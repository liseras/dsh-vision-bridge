/**
 * 视觉调用层的端到端测试。
 *
 * 起一个真实的 HTTP 服务替身，验证两种协议的请求体、认证头与响应解析。
 * 这一层最容易在字段名上出错（image_url vs source.base64），而重启后
 * 只能看到"调用失败"，看不到到底发了什么，所以在这里把请求钉死。
 */
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { callVisionModel } from '../lib/vision.js';

let passed = 0, failed = 0;
const test = (name, fn) => fn().then(
  () => { passed++; console.log('  ok  ' + name); },
  (e) => { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); },
);

/** 起一个单次请求的服务，把收到的请求体交回给测试。 */
function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      handler({ url: req.url, headers: req.headers, body, res });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      base: 'http://127.0.0.1:' + server.address().port + '/v1',
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

console.log('--- OpenAI chat-completions ---');
await test('请求体使用 image_url + data URI，并带上 Bearer', async () => {
  let seen;
  const s = await serve((req) => {
    seen = req;
    req.res.writeHead(200, { 'content-type': 'application/json' });
    req.res.end(JSON.stringify({ choices: [{ message: { content: '一只猫' } }] }));
  });
  try {
    const text = await callVisionModel({
      profile: { api: 'openai-completions', baseURL: s.base },
      model: 'vis-1', apiKey: 'sk-test', bytes: [{ data: PNG, mediaType: 'image/png' }],
      prompt: 'P', maxTokens: 77,
    });
    assert.equal(text, '一只猫');
    assert.equal(seen.url, '/v1/chat/completions');
    assert.equal(seen.headers.authorization, 'Bearer sk-test');
    assert.equal(seen.body.model, 'vis-1');
    assert.equal(seen.body.max_tokens, 77);
    const parts = seen.body.messages[0].content;
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[1].type, 'image_url');
    assert.match(parts[1].image_url.url, /^data:image\/png;base64,/);
  } finally { await s.close(); }
});
await test('兼容 content 为分片数组的网关', async () => {
  const s = await serve((req) => {
    req.res.writeHead(200, { 'content-type': 'application/json' });
    req.res.end(JSON.stringify({ choices: [{ message: { content: [{ text: 'A' }, { text: 'B' }] } }] }));
  });
  try {
    const text = await callVisionModel({ profile: { api: 'openai-completions', baseURL: s.base }, model: 'm', apiKey: 'k', bytes: [{ data: PNG, mediaType: 'image/png' }], prompt: 'P', maxTokens: 8 });
    assert.equal(text, 'AB');
  } finally { await s.close(); }
});
await test('HTTP 错误带上状态码与响应体', async () => {
  const s = await serve((req) => { req.res.writeHead(401); req.res.end('bad key'); });
  try {
    await assert.rejects(
      () => callVisionModel({ profile: { api: 'openai-completions', baseURL: s.base }, model: 'm', apiKey: 'k', bytes: [{ data: PNG, mediaType: 'image/png' }], prompt: 'P', maxTokens: 8 }),
      /HTTP 401.*bad key/s,
    );
  } finally { await s.close(); }
});

console.log('--- Anthropic messages ---');
await test('请求体使用 source.base64，并带上 x-api-key 与版本头', async () => {
  let seen;
  const s = await serve((req) => {
    seen = req;
    req.res.writeHead(200, { 'content-type': 'application/json' });
    req.res.end(JSON.stringify({ content: [{ type: 'text', text: '描述结果' }] }));
  });
  try {
    const text = await callVisionModel({
      profile: { api: 'anthropic-messages', baseURL: s.base },
      model: 'claude-x', apiKey: 'ant-key', bytes: [{ data: PNG, mediaType: 'image/png' }],
      prompt: 'P', maxTokens: 55,
    });
    assert.equal(text, '描述结果');
    assert.equal(seen.url, '/v1/messages');
    assert.equal(seen.headers['x-api-key'], 'ant-key');
    assert.equal(seen.headers['anthropic-version'], '2023-06-01');
    const img = seen.body.messages[0].content[0];
    assert.equal(img.type, 'image');
    assert.equal(img.source.type, 'base64');
    assert.equal(img.source.media_type, 'image/png');
    assert.equal(seen.body.max_tokens, 55);
  } finally { await s.close(); }
});

console.log('--- 边界 ---');
await test('未配置密钥时不发 authorization 头', async () => {
  let seen;
  const s = await serve((req) => {
    seen = req;
    req.res.writeHead(200, { 'content-type': 'application/json' });
    req.res.end(JSON.stringify({ choices: [{ message: { content: 'x' } }] }));
  });
  try {
    await callVisionModel({ profile: { api: 'openai-completions', baseURL: s.base }, model: 'm', apiKey: undefined, bytes: [{ data: PNG, mediaType: 'image/png' }], prompt: 'P', maxTokens: 8 });
    assert.equal(seen.headers.authorization, undefined);
  } finally { await s.close(); }
});
await test('无法识别的图片格式被拒绝', async () => {
  await assert.rejects(
    () => callVisionModel({ profile: { api: 'openai-completions', baseURL: 'http://127.0.0.1:1/v1' }, model: 'm', apiKey: 'k', bytes: [{ data: new Uint8Array([1, 2, 3, 4]) }], prompt: 'P', maxTokens: 8 }),
    /无法识别的图片格式/,
  );
});
await test('空图片列表被拒绝', async () => {
  await assert.rejects(
    () => callVisionModel({ profile: { api: 'openai-completions', baseURL: 'http://127.0.0.1:1/v1' }, model: 'm', apiKey: 'k', bytes: [], prompt: 'P', maxTokens: 8 }),
    /没有收到任何图片/,
  );
});
await test('baseURL 尾部斜杠不产生双斜杠', async () => {
  let seen;
  const s = await serve((req) => {
    seen = req;
    req.res.writeHead(200, { 'content-type': 'application/json' });
    req.res.end(JSON.stringify({ choices: [{ message: { content: 'y' } }] }));
  });
  try {
    await callVisionModel({ profile: { api: 'openai-completions', baseURL: s.base + '/' }, model: 'm', apiKey: 'k', bytes: [{ data: PNG, mediaType: 'image/png' }], prompt: 'P', maxTokens: 8 });
    assert.equal(seen.url, '/v1/chat/completions');
  } finally { await s.close(); }
});

console.log('');
console.log(failed === 0 ? `全部通过：${passed} 项` : `通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;

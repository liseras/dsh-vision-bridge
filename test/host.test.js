/**
 * 视觉桥 Host 端自测。
 *
 * 覆盖三块在重启后不容易观察、也最容易写错的地方：
 *   路由选择（哪种情况该桥接、选哪个模型）
 *   图片替换（冻结消息不被改写、多图、失败降级）
 *   缓存（同一张图只调用一次）
 * 不依赖 DSH 运行时：ctx.llm / ctx.get('attachments') 都用替身。
 */
import { strict as assert } from 'node:assert';
import { Config } from '../lib/config.js';
import { readConfig } from '../lib/values.js';
import { DescriptionCache, replaceImagesWithDescriptions, installVisionBridge, BYPASS } from '../lib/bridge.js';
import { sniffImageMediaType } from '../lib/vision.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) return result.then(
      () => { passed++; console.log('  ok  ' + name); },
      (error) => { failed++; console.log('  FAIL ' + name + '\n       ' + error.message); }
    );
    passed++; console.log('  ok  ' + name);
  } catch (error) {
    failed++; console.log('  FAIL ' + name + '\n       ' + error.message);
  }
}
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

console.log('--- 配置 schema ---');
await test('未配置 providers 时给出安全默认值', () => {
  const parsed = Config({});
  // 字段级 volatile：经 readConfig 解包
  assert.equal(readConfig(parsed, 'visionModel', 'X'), '');
  assert.equal(readConfig(parsed, 'maxOutputTokens', -1), 1024);
  assert.equal(readConfig(parsed, 'failClosed', 'X'), false);
  assert.deepEqual(readConfig(parsed, 'providers', 'X'), {});
});
await test('保留 providers 内 models[].input', () => {
  const parsed = Config({ providers: { p: { api: 'openai-completions', baseURL: 'https://x/v1', models: [{ id: 'm', input: ['text', 'image'], contextWindow: 1000, maxTokens: 10 }] } } });
  assert.deepEqual(readConfig(parsed, 'providers', {}).p.models[0].input, ['text', 'image']);
});
await test('字段级 volatile 不会让整个 schema 塌缩（对象本身非 volatile）', () => {
  assert.equal(Config.meta?.volatile, undefined, 'Config 本身不应是 volatile');
});
await test('拒绝未知协议', () => {
  assert.throws(() => Config({ providers: { p: { api: 'nope' } } }));
});

console.log('--- 图片格式嗅探 ---');
await test('识别 PNG/JPEG/GIF/WEBP', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const gif = new Uint8Array([...Buffer.from('GIF89a'), 0, 0]);
  const webp = new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')]);
  assert.equal(sniffImageMediaType(png), 'image/png');
  assert.equal(sniffImageMediaType(jpeg), 'image/jpeg');
  assert.equal(sniffImageMediaType(gif), 'image/gif');
  assert.equal(sniffImageMediaType(webp), 'image/webp');
  assert.equal(sniffImageMediaType(new Uint8Array([1, 2, 3, 4])), undefined);
});

console.log('--- 图片替换 ---');
await test('把图片块换成描述文本，并保留其它块', async () => {
  const messages = deepFreeze([{ role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image', attachment: { attachmentId: 'sha256:aaa' } }] }]);
  const out = await replaceImagesWithDescriptions(messages, async () => 'DESC');
  assert.deepEqual(out[0].content, [{ type: 'text', text: '看这张图' }, { type: 'text', text: 'DESC' }]);
  // 原始（冻结的）消息未被改动
  assert.equal(messages[0].content[1].type, 'image');
});
await test('多图各自转述，顺序保持', async () => {
  const messages = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:1' } }, { type: 'image', attachment: { attachmentId: 'sha256:2' } }] }];
  const out = await replaceImagesWithDescriptions(messages, async (a) => 'D' + a.attachmentId.slice(-1));
  assert.deepEqual(out[0].content.map((b) => b.text), ['D1', 'D2']);
});
await test('无图片的消息保持同一对象引用', async () => {
  const message = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
  const out = await replaceImagesWithDescriptions([message], async () => 'X');
  assert.equal(out[0], message);
});
await test('单张图失败不影响其它图片', async () => {
  const messages = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:bad' } }, { type: 'image', attachment: { attachmentId: 'sha256:good' } }] }];
  const out = await replaceImagesWithDescriptions(messages, async (a) => {
    if (a.attachmentId.endsWith('bad')) throw new Error('boom');
    return 'OK';
  });
  assert.match(out[0].content[0].text, /vision bridge failed/);
  assert.equal(out[0].content[1].text, 'OK');
});

console.log('--- 描述缓存 ---');
await test('命中后返回同一结果', () => {
  const cache = new DescriptionCache(2);
  cache.set('a', 'A');
  assert.equal(cache.get('a'), 'A');
});
await test('超过上限时淘汰最久未用', () => {
  const cache = new DescriptionCache(2);
  cache.set('a', 'A'); cache.set('b', 'B');
  cache.get('a');            // a 变成最近使用
  cache.set('c', 'C');       // 应淘汰 b
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 'A');
  assert.equal(cache.get('c'), 'C');
});

console.log('--- 拦截器 ---');
function makeCtx({ modalities = ['text'], model = 'm1', onStream } = {}) {
  const handlers = [];
  return {
    handlers,
    get: () => undefined,
    llm: {
      resolveModelInfo: async () => ({ inputModalities: modalities }),
      stream: (options) => { if (onStream) onStream(options); return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })(); },
    },
    logger: { info() {}, warn() {} },
    on: (event, handler) => handlers.push({ event, handler }),
  };
}
const collect = async (iterable) => { const out = []; for await (const item of iterable) out.push(item); return out; };

await test('无图片的请求直接放行', async () => {
  const ctx = makeCtx();
  const config = Config({ providers: { p: { api: 'openai-completions', baseURL: 'https://x/v1', models: [{ id: 'v', input: ['image'], contextWindow: 1, maxTokens: 1 }] } } });
  installVisionBridge(ctx, { cache: new DescriptionCache(4), config, logger: ctx.logger, resolveRoute: async () => ({ provider: 'p', model: 'v', profile: {}, apiKey: 'k' }) });
  const handler = ctx.handlers[0].handler;
  let nextCalled = false;
  const out = await collect(handler({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, () => { nextCalled = true; return (async function* () { yield 'downstream'; })(); }));
  assert.ok(nextCalled, '应调用 next()');
  assert.deepEqual(out, ['downstream']);
});
await test('目标模型自带视觉能力时不桥接', async () => {
  const ctx = makeCtx({ modalities: ['text', 'image'] });
  const config = Config({ providers: { p: { api: 'openai-completions', baseURL: 'https://x/v1', models: [{ id: 'v', input: ['image'], contextWindow: 1, maxTokens: 1 }] } } });
  installVisionBridge(ctx, { cache: new DescriptionCache(4), config, logger: ctx.logger, resolveRoute: async () => undefined });
  const handler = ctx.handlers[0].handler;
  let nextCalled = false;
  await collect(handler({ messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'x' } }] }] }, () => { nextCalled = true; return (async function* () {})(); }));
  assert.ok(nextCalled, '自带视觉时应放行');
});
await test('BYPASS 标记的请求不再次拦截（防递归）', async () => {
  const ctx = makeCtx();
  installVisionBridge(ctx, { cache: new DescriptionCache(4), config: Config({}), logger: ctx.logger, resolveRoute: async () => { throw new Error('不该被调用'); } });
  const handler = ctx.handlers[0].handler;
  let nextCalled = false;
  await collect(handler({ messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'x' } }] }], [BYPASS]: true }, () => { nextCalled = true; return (async function* () {})(); }));
  assert.ok(nextCalled, '带 BYPASS 应放行');
});

console.log('');
console.log(failed === 0 ? `全部通过：${passed} 项` : `通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;

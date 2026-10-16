/**
 * apply() 装配测试。
 *
 * dump-config 只能证明配置语法正确，证明不了 apply() 不抛异常。
 * 插件在 apply 里抛错会让整个 profile 加载失败、Web 起不来，所以这一层必须钉死。
 */
import { strict as assert } from 'node:assert';
import { apply, Config } from '../lib/index.js';
import { readConfig } from '../lib/values.js';
import { BYPASS, bypass } from '../lib/bridge.js';

let passed = 0, failed = 0;
const test = (name, fn) => {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(
        () => { passed++; console.log('  ok  ' + name); },
        (e) => { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); },
      );
    }
    passed++; console.log('  ok  ' + name);
  } catch (e) {
    failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message));
  }
};

/** 最小的 cordis 替身。 */
function makeCtx() {
  const handlers = [];
  const logs = [];
  const directoryCalls = [];
  const ctx = {
    handlers, logs, directoryCalls,
    fiber: { entry: { options: { id: 'dsh-vision-bridge' } } },
    get: () => undefined,
    inject: (services, cb) => { ctx.injected = { services, cb }; },
    llm: {
      resolveModelInfo: async () => ({ inputModalities: ['text'] }),
      stream: () => (async function* () {})(),
      listProviders: () => [],
      listModels: async () => [],
      registerConfigurableProviders: (entries) => {
        directoryCalls.push(entries);
        return { replace: (next) => directoryCalls.push(next) };
      },
      registerModelDiscovery: (ns, discover) => { ctx.discovery = { ns, discover }; return () => {}; },
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    on: (event, handler) => { handlers.push({ event, handler }); },
  };
  return ctx;
}

console.log('--- apply 装配 ---');
await test('没有配置 provider 时不抛异常', () => {
  const ctx = makeCtx();
  apply(ctx, Config({}));
  // 现在会注册两个监听：llm/stream 拦截器 + loader/volatile-update（刷新 provider 目录）
  assert.equal(ctx.handlers.length, 2, '应注册两个监听：' + ctx.handlers.map((h) => h.event).join(', '));
  assert.ok(ctx.handlers.some((h) => h.event === 'llm/stream'), '应有 llm/stream 拦截器');
  assert.ok(ctx.handlers.some((h) => h.event === 'loader/volatile-update'), '应有目录刷新监听');
  assert.ok(ctx.logs.some((m) => m.includes('尚未配置')), '应提示未配置：' + ctx.logs.join('|'));
});
await test('配置了视觉模型时报告就绪', () => {
  const ctx = makeCtx();
  apply(ctx, Config({ providers: { codepin: { api: 'openai-completions', baseURL: 'https://x/v1', models: [{ id: 'glm', input: ['text', 'image'], contextWindow: 1, maxTokens: 1 }] } } }));
  assert.ok(ctx.logs.some((m) => m.includes('已就绪') && m.includes('codepin/glm')), '应报告就绪：' + ctx.logs.join('|'));
});
await test('未声明 image 的模型也被列为候选（声明是提示，不是事实）', () => {
  const ctx = makeCtx();
  // pi-ai 的 defaultInput 是 ["text"]，而中转网关常不写 input：后端支持视觉，
  // 声明却是纯文本。按声明过滤会让候选恒为空——页面只剩"自动"，桥接永不触发。
  apply(ctx, Config({ providers: { p: { api: 'openai-completions', baseURL: 'https://x/v1', models: [{ id: 'textonly', input: ['text'], contextWindow: 1, maxTokens: 1 }] } } }));
  assert.ok(ctx.logs.some((m) => m.includes('已就绪') && m.includes('p/textonly')), '未声明 image 的模型也应出现在就绪列表：' + ctx.logs.join('|'));
});
await test('enabled=false 时报告停用', () => {
  const ctx = makeCtx();
  apply(ctx, Config({ enabled: false, providers: { p: { api: 'openai-completions', baseURL: 'https://x/v1', models: [{ id: 'glm', input: ['text', 'image'], contextWindow: 1, maxTokens: 1 }] } } }));
  assert.ok(ctx.logs.some((m) => m.includes('已停用')), '应报告已停用：' + ctx.logs.join('|'));
});
await test('alwaysDescribe 默认关闭，不改变既有行为', () => {
  // 默认值必须为 false——否则"主模型能看图就不转述"这条会被静默改掉。
  // volatile 字段是带 .get() 的包装对象，必须经 readConfig 读（见 values.js）。
  assert.equal(readConfig(Config({}), 'alwaysDescribe', false), false, 'alwaysDescribe 默认应为 false');
  assert.equal(readConfig(Config({ alwaysDescribe: true }), 'alwaysDescribe', false), true, '显式开启应被接受');
  assert.equal(readConfig(Config({}), 'enabled', true), true, 'enabled 默认仍为 true');
});
await test('重复 apply 不冲突（各注册一组监听）', () => {
  const ctx = makeCtx();
  apply(ctx, Config({}));
  apply(ctx, Config({}));
  assert.equal(ctx.handlers.length, 4);
});

console.log('--- 路由选择 ---');
// 通过拦截器行为间接验证路由选择
const collect = async (it) => { const out = []; if (it === undefined || it === null) return out; for await (const c of it) out.push(c); return out; };
const deepFreeze = (v) => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const c of Object.values(v)) deepFreeze(c); } return v; };

function ctxWithRoute(modalities, seen, options = {}) {
  const ctx = makeCtx();
  const register = ctx.llm.registerConfigurableProviders;
  const registerDiscovery = ctx.llm.registerModelDiscovery;
  ctx.llm = {
    registerConfigurableProviders: register,
    registerModelDiscovery: registerDiscovery,
    resolveModelInfo: async (provider, model) => {
      // 让"视觉模型自己"被当作有图片能力的 route
      if (options.visionRoute === provider + '/' + model) return { inputModalities: ['text', 'image'] };
      return { inputModalities: modalities };
    },
    listProviders: () => options.providers ?? [],
    listModels: async (provider) => options.models?.[provider] ?? [],
    stream: (options_) => { seen.push(options_); return (options.streamResult ?? (async function* () { yield 'UPSTREAM'; })()); },
  };
  return ctx;
}

await test('visionModel 指定的模型不在配置中时回退到第一个可用模型', async () => {
  const seen = [];
  const ctx = ctxWithRoute(['text'], seen);
  const config = Config({
    visionModel: 'nope/missing',
    providers: { p: { api: 'openai-completions', baseURL: 'https://x/v1', models: [{ id: 'vis', input: ['image'], contextWindow: 1, maxTokens: 1 }] } },
  });
  apply(ctx, config);
  const handler = ctx.handlers.find((h) => h.event === 'llm/stream').handler;
  // 不真发请求：describe 会因为取不到附件而失败，走 failClosed=false 的降级分支
  const out = await collect(handler({ provider: 'main', model: 'm', messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:z' } }] }] }, () => (async function* () { yield 'DOWNSTREAM'; })()));
  // 走 ctx.llm.stream 说明桥接生效（替身把它记进 seen）
  assert.ok(out.includes('UPSTREAM'), '应经桥接重新发起：' + JSON.stringify(out));
  assert.ok(seen.length === 1, '应有一次重新发起的请求');
  assert.ok(ctx.logs.some((m) => m.includes('nope/missing')), '应告警 visionModel 无效：' + ctx.logs.join('|'));
});
await test('failClosed=true 时转述失败会抛出', async () => {
  const seen = [];
  const ctx = ctxWithRoute(['text'], seen);
  const config = Config({
    failClosed: true,
    providers: { p: { api: 'openai-completions', baseURL: 'https://x/v1', models: [{ id: 'vis', input: ['image'], contextWindow: 1, maxTokens: 1 }] } },
  });
  apply(ctx, config);
  const handler = ctx.handlers.find((h) => h.event === 'llm/stream').handler;
  let threw = false;
  try {
    await collect(handler({ provider: 'main', model: 'm', messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:z' } }] }] }, () => (async function* () { yield 'DOWNSTREAM'; })()));
  } catch { threw = true; }
  assert.ok(threw, 'failClosed=true 时应抛出');
});

await test('转述失败且 failClosed=false 时降级到下游', async () => {
  const seen = [];
  const ctx = ctxWithRoute(['text'], seen);
  const config = Config({ providers: { p: { api: 'openai-completions', baseURL: 'https://x/v1', models: [{ id: 'vis', input: ['image'], contextWindow: 1, maxTokens: 1 }] } } });
  apply(ctx, config);
  const handler = ctx.handlers.find((h) => h.event === 'llm/stream').handler;
  // 默认 failClosed=false，且 ctx.get('attachments') 为 undefined
  const out = await collect(handler({ provider: 'main', model: 'm', messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:z' } }] }] }, () => (async function* () { yield 'DOWNSTREAM'; })()));
  assert.ok(out.includes('UPSTREAM'), '应经桥接重新发起（图片被替换成失败说明）：' + JSON.stringify(out));
});

await test('转述成功时图片块被换掉，主模型看不到 image 块', async () => {
  const seen = [];
  const ctx = ctxWithRoute(['text'], seen);
  // 提供附件服务替身，让描述成功
  ctx.get = (name) => name === 'attachments' ? { readImage: async () => ({ data: new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]) }) } : undefined;
  const config = Config({ providers: { p: { api: 'openai-completions', baseURL: 'https://x/v1', models: [{ id: 'vis', input: ['image'], contextWindow: 1, maxTokens: 1 }] } } });
  apply(ctx, config);
  const handler = ctx.handlers.find((h) => h.event === 'llm/stream').handler;
  // 让 callVisionModel 走不通（端口不可达）→ 单图失败降级为说明文本，但仍应替换掉 image 块
  const messages = deepFreeze([{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png' } }] }]);
  await collect(handler({ provider: 'main', model: 'm', messages }, () => (async function* () {})()));
  assert.equal(seen.length, 1, '应重新发起一次');
  const rewritten = seen[0].messages[0].content;
  assert.equal(rewritten.every((b) => b.type !== 'image'), true, '不应残留 image 块：' + JSON.stringify(rewritten));
  assert.equal(rewritten[0].type, 'text');
  assert.match(rewritten[0].text, /vision bridge|image described/);
});

console.log('--- settings namespace 与 provider 目录 ---');
await test('注册模型发现通道（设置页列候选的唯一途径）', async () => {
  const ctx = makeCtx();
  ctx.llm.listModels = async () => [{ id: 'v1', name: 'V1', inputModalities: ['text', 'image'] }];
  apply(ctx, Config({}));
  assert.ok(ctx.discovery !== undefined, '应注册 discovery');
  assert.equal(ctx.discovery.ns, 'dsh-vision-bridge');
  const models = await ctx.discovery.discover({ provider: 'deepseek-official' });
  assert.equal(models[0].id, 'v1');
});
await test('发现通道对空 provider 与异常都安全降级', async () => {
  const ctx = makeCtx();
  ctx.llm.listModels = async () => { throw new Error('boom'); };
  apply(ctx, Config({}));
  assert.deepEqual(await ctx.discovery.discover({}), []);
  assert.deepEqual(await ctx.discovery.discover({ provider: 'x' }), []);
});

await test('声明 settings.configure({auto:false})，让页面自绘而非自动生成', () => {
  const ctx = makeCtx();
  apply(ctx, Config({}));
  assert.ok(ctx.injected, '应调用 ctx.inject');
  assert.deepEqual(ctx.injected.services, ['settings']);
  // 模拟 cordis 子上下文，确认 configure 被调用
  let configured;
  ctx.injected.cb({ effect: (fn) => { fn(); }, settings: { configure: (policy) => { configured = policy; } } });
  assert.deepEqual(configured, { auto: false }, 'auto 应为 false，否则设置页不显示');
});
await test('把配置的 provider 声明进配置目录（这是页面不空白的根因）', () => {
  const ctx = makeCtx();
  apply(ctx, Config({ providers: {
    codepin: { api: 'openai-completions', baseURL: 'https://x/v1', models: [{ id: 'glm', input: ['text', 'image'], contextWindow: 1, maxTokens: 1 }] },
  } }));
  assert.equal(ctx.directoryCalls.length, 1, '应注册一次目录');
  const entry = ctx.directoryCalls[0][0];
  assert.equal(entry.provider, 'codepin');
  assert.equal(entry.settingsNs, 'dsh-vision-bridge', 'settingsNs 必须是本插件的 entry id');
  assert.deepEqual(entry.settingsPath, ['providers', 'codepin']);
});
await test('没有模型的 provider 不进目录（避免空壳行）', () => {
  const ctx = makeCtx();
  apply(ctx, Config({ providers: { empty: { api: 'openai-completions', baseURL: 'https://x/v1', models: [] } } }));
  assert.equal(ctx.directoryCalls.length, 0);
});

console.log('--- 已注册视觉模型（DSH 自带 V4.1 走这一路）---');

await test('本插件无配置时，改用 harness 已注册的视觉模型', async () => {
  const seen = [];
  const ctx = ctxWithRoute(['text'], seen, {
    providers: [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'codepin', name: 'codepin' }],
    models: {
      'deepseek-official': [{ provider: 'deepseek-official', id: 'deepseek-flash', name: 'V41', inputModalities: ['text', 'image'] }],
      codepin: [{ provider: 'codepin', id: 'text-only', name: 'T', inputModalities: ['text'] }],
    },
    visionRoute: 'deepseek-official/deepseek-flash',
  });
  apply(ctx, Config({}));
  const handler = ctx.handlers.find((h) => h.event === 'llm/stream').handler;
  await collect(handler({ provider: 'codepin', model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:z' } }] }] }, () => (async function* () {})()));
  // 桥接生效 → 会用 ctx.llm.stream 重新发起（describe 也会走它）
  assert.ok(seen.length >= 1, '应经已注册 route 发起调用：' + seen.length);
});
await test('只有 text 的已注册模型不算视觉模型', async () => {
  const seen = [];
  const ctx = ctxWithRoute(['text'], seen, {
    providers: [{ id: 'codepin', name: 'codepin' }],
    models: { codepin: [{ provider: 'codepin', id: 'glm-5.3-flash', name: 'G', inputModalities: ['text'] }] },
  });
  apply(ctx, Config({}));
  const handler = ctx.handlers.find((h) => h.event === 'llm/stream').handler;
  let nextCalled = false;
  await collect(handler({ provider: 'codepin', model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:z' } }] }] }, () => { nextCalled = true; return (async function* () { yield 'DOWN'; })(); }));
  assert.ok(nextCalled, '没有视觉模型时应放行到下游');
});
await test('排除正在被桥接的模型本身当视觉模型', async () => {
  const seen = [];
  const ctx = ctxWithRoute(['text'], seen, {
    providers: [{ id: 'codepin', name: 'codepin' }],
    models: { codepin: [{ provider: 'codepin', id: 'deepseek-v4.1-flash', name: 'X', inputModalities: ['text', 'image'] }] },
    visionRoute: 'codepin/deepseek-v4.1-flash',
  });
  apply(ctx, Config({}));
  const handler = ctx.handlers.find((h) => h.event === 'llm/stream').handler;
  let nextCalled = false;
  await collect(handler({ provider: 'codepin', model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:z' } }] }] }, () => { nextCalled = true; return (async function* () { yield 'DOWN'; })(); }));
  assert.ok(nextCalled, '唯一视觉模型是自己时应放行，不能自指');
});
await test('listProviders 抛错时不崩溃，放行到下游', async () => {
  const seen = [];
  const ctx = ctxWithRoute(['text'], seen);
  ctx.llm.listProviders = () => { throw new Error('registry down'); };
  apply(ctx, Config({}));
  const handler = ctx.handlers.find((h) => h.event === 'llm/stream').handler;
  let nextCalled = false;
  await collect(handler({ provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:z' } }] }] }, () => { nextCalled = true; return (async function* () { yield 'DOWN'; })(); }));
  assert.ok(nextCalled, '枚举失败应降级');
});

console.log('--- 自指与候选排序（插件只排它确实知道的那点信息）---');

await test('主模型自己声明了 image 且未开 alwaysDescribe 时直接放行', async () => {
  // 目标模型自己声明了 image，且用户没要求一律转述 —— 上游那条
  // "inputModalities 含 image 就不投影"的短路会先返回 undefined，
  // 图片原样交给主模型。这是插件的默认行为，不该被排序逻辑扰动。
  const seen = [];
  const ctx = ctxWithRoute(['text', 'image'], seen, {
    providers: [{ id: 'deepseek-official' }, { id: 'codepin' }],
    models: {
      'deepseek-official': [{ id: 'deepseek-flash', inputModalities: ['text', 'image'] }],
      codepin: [{ id: 'glm-5.3-flash', inputModalities: ['text', 'image'] }],
    },
    visionRoute: 'deepseek-official/deepseek-flash',
  });
  apply(ctx, Config({ visionModel: 'deepseek-official/deepseek-flash' }));
  const handler = ctx.handlers.find((h) => h.event === 'llm/stream').handler;
  let nextCalled = false;
  const out = await collect(handler(
    { provider: 'deepseek-official', model: 'deepseek-flash', messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:z' } }] }] },
    () => { nextCalled = true; return (async function* () { yield 'DOWN'; })(); },
  ));
  assert.ok(nextCalled, '应放行到下游，把图片原样交给主模型');
  assert.equal(seen.length, 0, '不该发起任何转述请求，实际 ' + seen.length);
  assert.deepEqual(out, ['DOWN']);
});

await test('主模型正是用户显式指定的 visionModel 时放行——声明不可信，用户指定才作数', async () => {
  // 关键：本插件读到的 inputModalities 全是配置里写死的字符串，"声明 image"
  // 有"真能看图"和"只为让图片入库"两种来由，长得一样但含义相反。
  // 唯一可信的信号是用户把谁填进了 visionModel。填的就是主模型自己时，
  // 含义是"我自己会看图，别绕道"。
  const seen = [];
  const ctx = ctxWithWaterfall(seen, { count: 0 });
  ctx.llm.listProviders = () => [{ id: 'deepseek-official' }, { id: 'codepin' }];
  // codepin 故意声明 image（只为入库），照旧不该被当成眼睛
  ctx.llm.listModels = async (p) => p === 'deepseek-official'
    ? [{ id: 'deepseek-flash', inputModalities: ['text', 'image'] }]
    : [{ id: 'glm-5.3-flash', inputModalities: ['text', 'image'] }];
  ctx.llm.resolveModelInfo = async () => ({ inputModalities: ['text', 'image'] });
  apply(ctx, Config({ visionModel: 'deepseek-official/deepseek-flash', alwaysDescribe: true }));
  const described = describeProbe(ctx);
  const handler = ctx.__handlers.find((h) => h.event === 'llm/stream').handler;
  let nextCalled = false;
  await collect(handler(
    { provider: 'deepseek-official', model: 'deepseek-flash', messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:z' } }] }] },
    () => { nextCalled = true; return (async function* () { yield 'DOWN'; })(); },
  ));
  assert.ok(nextCalled, '应放行到下游');
  assert.deepEqual(described, [], '不该发起转述，实际 ' + JSON.stringify(described));
});

await test('主模型不是指定的 visionModel 时，指定的那个仍被优先使用', async () => {
  // 主模型是 codepin（声明了 image 但收不了图），用户指定 deepseek-flash 当眼睛。
  // 此时必须把图片转述给 deepseek-flash，而不是因为主模型"声明了 image"就放行。
  const { handler, described } = visionProbe(
    ['deepseek-official', 'codepin'],
    {
      'deepseek-official': [{ id: 'deepseek-flash', inputModalities: ['text', 'image'] }],
      codepin: [{ id: 'deepseek-v4.1-flash', inputModalities: ['text', 'image'] }],
    },
    { alwaysDescribe: true },
    'deepseek-official/deepseek-flash',
  );
  await collect(handler(
    { provider: 'codepin', model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:z' } }] }] },
    () => (async function* () { yield 'DOWN'; })(),
  ));
  assert.deepEqual(described, ['deepseek-official/deepseek-flash'], '转述应发往用户指定的模型，实际 ' + JSON.stringify(described));
});

/**
 * 排序与自指这两个行为，只有让转述**真的发出去**才观察得到。
 * 没有附件服务时 describeAttachment 必失败，会降级成主请求重放，
 * 于是看不到任何"含图"的请求——所以这里一律用带附件替身的 ctxWithWaterfall。
 */
function visionProbe(providers, models, configExtra = {}, visionRoute) {
  const seen = [];
  const adapterCalls = { count: 0 };
  const ctx = ctxWithWaterfall(seen, adapterCalls);
  ctx.llm.listProviders = () => providers.map((id) => ({ id }));
  ctx.llm.listModels = async (provider) => models[provider] ?? [];
  ctx.llm.registerModelDiscovery = () => () => {};
  // resolveModelInfo 决定"目标模型自己能不能看图"与候选的 adapterReady
  ctx.llm.resolveModelInfo = async (provider, model) => {
    if (visionRoute === provider + '/' + model) return { inputModalities: ['text', 'image'] };
    if (provider === 'deepseek-official' && model === 'deepseek-flash') return { inputModalities: ['text', 'image'] };
    const hit = (models[provider] ?? []).find((m) => m.id === model);
    return { inputModalities: hit ? hit.inputModalities : ['text'] };
  };
  apply(ctx, Config({ visionModel: visionRoute ?? '', ...configExtra }));
  // 注意顺序：describeProbe 必须在 apply 之后包，才能包住拦截器真正调用的那个 stream。
  const described = describeProbe(ctx);
  const handler = ctx.__handlers.find((h) => h.event === 'llm/stream').handler;
  return { ctx, handler, described };
}

/** 包一层 stream，只记录"含图"的请求——那就是真正的转述请求。 */
function describeProbe(ctx) {
  const described = [];
  const inner = ctx.llm.stream;
  ctx.llm.stream = (options) => {
    if (options.messages.some((m) => m.content.some((b) => b.type === 'image'))) {
      described.push(options.provider + '/' + options.model);
    }
    return inner(options);
  };
  return described;
}

await test('自指但该模型不能走 adapter 时仍然排除它', async () => {
  // 主模型是 codepin/deepseek-v4.1-flash：它声明了 image 所以被当成候选，
  // 但 usableRoute 对它只能借连接信息直连（borrowedProfile 拿不到时返回 undefined），
  // 拿不到图就当不了眼睛——不能把转述发给它自己。
  const { handler, described } = visionProbe(
    ['deepseek-official', 'codepin'],
    {
      'deepseek-official': [{ id: 'deepseek-flash', inputModalities: ['text', 'image'] }],
      codepin: [{ id: 'deepseek-v4.1-flash', inputModalities: ['text', 'image'] }],
    },
    { alwaysDescribe: true },
    'deepseek-official/deepseek-flash',
  );
  await collect(handler(
    { provider: 'codepin', model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:z' } }] }] },
    () => (async function* () { yield 'DOWN'; })(),
  ));
  assert.deepEqual(described, ['deepseek-official/deepseek-flash'], '转述应发往 deepseek-flash，实际 ' + JSON.stringify(described));
});

await test('能走 adapter 的候选排在只能直连的候选前面', async () => {
  // 候选来自已注册 provider：deepseek-flash 声明了 image 走 adapter，
  // codepin/glm-5.3-flash 没声明 → 只能借连接信息直连。没有显式 visionModel 时，
  // 应当先试 adapter 那条。provider 顺序刻意把 codepin 放前面，验证排序确实生效。
  const { handler, described } = visionProbe(
    ['codepin', 'deepseek-official'],
    {
      codepin: [{ id: 'glm-5.3-flash', inputModalities: ['text'] }],
      'deepseek-official': [{ id: 'deepseek-flash', inputModalities: ['text', 'image'] }],
    },
  );
  await collect(handler(
    { provider: 'codepin', model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:z' } }] }] },
    () => (async function* () { yield 'DOWN'; })(),
  ));
  assert.equal(described[0], 'deepseek-official/deepseek-flash', '转述应发给能走 adapter 的候选，实际 ' + JSON.stringify(described));
});

console.log('--- 递归防护（alwaysDescribe 下的转述请求必须带 BYPASS）---');

/**
 * 把拦截器按 cordis waterfall 的语义串起来：每个 handler 包住它后面的那个，
 * 最内层才是 adapterStream。这样"请求会不会回到拦截器"就能被真实观察到。
 */
function ctxWithWaterfall(seen, adapterCalls) {
  const handlers = [];
  const ctx = makeCtx();
  ctx.on = (event, handler, opts) => {
    // 存成 { event, handler } 而不是裸函数：读取方按 event 找监听，链式调用按 handler 取函数。
    if (event !== 'llm/stream') return;
    const entry = { event, handler };
    if (opts?.prepend) handlers.unshift(entry); else handlers.push(entry);
  };
  const registered = ctx.llm.registerConfigurableProviders;
  const discovery = ctx.llm.registerModelDiscovery;
  ctx.get = (name) => name === 'attachments' ? {
    imageLimits: { mediaTypes: ['image/png', 'image/jpeg'] },
    readImage: async () => ({ data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]) }),
    saveImage: async () => ({ attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/jpeg' }),
  } : undefined;
  ctx.__handlers = handlers;
  ctx.llm = {
    registerConfigurableProviders: registered,
    registerModelDiscovery: discovery,
    listProviders: () => [{ id: 'deepseek-official' }, { id: 'codepin' }],
    listModels: async (provider) => provider === 'deepseek-official'
      ? [{ id: 'deepseek-flash', inputModalities: ['text', 'image'] }]
      : [{ id: 'deepseek-v4.1-flash', inputModalities: ['text', 'image'] }],
    resolveModelInfo: async (provider) => ({ inputModalities: ['text', 'image'] }),
    stream: (options) => {
      seen.push(options);
      if (seen.length > 50) throw new Error('递归未收敛：llm.stream 被调用了 ' + seen.length + ' 次');
      const list = handlers.map((entry) => entry.handler);
      const call = (i) => (i >= list.length
        ? (adapterCalls.count++, (async function* () { yield { type: 'text', text: 'ADAPTER' }; })())
        : list[i](options, () => call(i + 1)));
      return call(0);
    },
  };
  return ctx;
}

const imageMsg = (id) => ({ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:' + id, mediaType: 'image/jpeg' } }] });

await test('alwaysDescribe=true 时转述请求不再被拦截（无限递归回归）', async () => {
  const seen = [];
  const adapterCalls = { count: 0 };
  const ctx = ctxWithWaterfall(seen, adapterCalls);
  apply(ctx, Config({ visionModel: 'deepseek-official/deepseek-flash', alwaysDescribe: true }));
  const out = await collect(ctx.llm.stream({ provider: 'codepin', model: 'deepseek-v4.1-flash', messages: [imageMsg('b'.repeat(64))] }));
  assert.ok(out.length > 0, '主请求应拿到下游 chunk');
  // 恰好两次 adapter 调用：一次转述（发往视觉模型）、一次主请求重放。
  // 递归时这个数字会无限增长，所以它正是回归信号。
  assert.equal(adapterCalls.count, 2, '应恰好到达 adapter 两次，实际 ' + adapterCalls.count);
  // 每次进入拦截器都会记一笔：主请求 1 次 + 转述 1 次 + 主请求重放 1 次 = 3。
  assert.equal(seen.length, 3, '应只重新发起三次，实际 ' + seen.length);
  const described = seen.find((o) => o.provider === 'deepseek-official');
  assert.ok(described !== undefined, '应有一次发往视觉模型的转述请求');
  assert.equal(described[BYPASS], true, '转述请求必须带 BYPASS，否则会递归');
  const replay = seen.filter((o) => o.provider === 'codepin').at(-1);
  assert.ok(replay !== undefined, '应有一次主请求重放');
  assert.equal(replay[BYPASS], true, '主请求重放必须带 BYPASS');
  assert.equal(replay.messages.some((m) => m.content.some((b) => b.type === 'image')), false, '重放的消息里不应再有 image 块');
});

await test('bypass() 只加标记、不改动原请求对象', () => {
  const request = { provider: 'p', model: 'm', nested: { a: 1 } };
  const marked = bypass(request, { messages: [] });
  assert.equal(marked[BYPASS], true);
  assert.deepEqual(marked.messages, []);
  assert.equal(marked.provider, 'p');
  assert.equal(request[BYPASS], undefined, '原对象不应被污染');
  assert.equal(request.messages, undefined);
});

console.log('');
console.log(failed === 0 ? `全部通过：${passed} 项` : `通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;

/**
 * 视觉桥的核心。
 *
 * ## 为什么必须拦截 `llm/stream`
 *
 * 上游在 `dsh-llm` 的 adapterStream 里已经有一条固定策略：目标模型不声明 image
 * 模态时，把每个图片块替换成
 *
 *     [image omitted because this model accepts text only; attachment sha256:...]
 *
 * 这条策略没有开关，也没有扩展点。视觉桥要做的事正是**接管这个替换**：在同一个
 * 位置、用同一份图片，把占位符换成视觉模型看出来的文字。
 *
 * ## 为什么不能直接改 options，必须重建流
 *
 * cordis 的 `waterfall` 把参数数组按引用透传，`next()` 调用的是闭包里那个 inner，
 * 它**忽略调用方传进去的参数**：
 *
 *     waterfall(...args) { ... const inner = args.pop(); const next = () => (cbs.shift() ?? inner)(...args); }
 *
 * 也就是说 `next(newOptions)` 并不意味着下游会看到 `newOptions`。而且 agent-loop
 * 交给这里的 options 是 `markAgentLoopRequest(Object.freeze({...}))`，messages 数组
 * 与其中的每条消息都被 deepFreeze 过，原地改写会静默失败（严格模式下抛错）。
 *
 * 所以桥接必须**自己产出流**：改写后的 options 交给一个绕开本拦截的调用路径。
 * 绕开用的标记放在 options 上——它只在本次进程内传递，不落盘，也不进模型可见内容。
 */
import { contentHasImage } from '@deepseek-ai/dsh-llm';
import { callVisionModel } from './vision.js';
import { readConfig } from './values.js';

/** 绕行标记：带这个键的请求不再经过桥接，避免无限递归。 */
export const BYPASS = Symbol.for('dsh-vision-bridge.bypass');

/**
 * 把一次请求标记为「已绕行」。
 *
 * 视觉桥有两个地方需要重新发起模型调用：主请求被改写后的重放，以及
 * 交给视觉模型的那一次转述。**两处都必须带标记**，漏掉任何一处都会让
 * 新请求重新落进本拦截器：
 *
 *   转述请求漏标记 → 它自己也带图 → 又触发转述 → 无限递归。
 *   这条链在 alwaysDescribe=true 时必然发生，且不会自行终止：外层
 *   await 着内层，取消信号传不进已经开始的下一圈，表现为界面无响应、
 *   暂停按钮也按不动，同时 CPU 打满。
 *
 * 所以标记只在这一个函数里落，调用方一律经它发起，从结构上堵死复发。
 *
 * @param request - 原始请求选项。
 * @param overrides - 需要覆盖的字段（例如改写后的 messages）。
 * @returns 带绕行标记的新请求。
 */
export function bypass(request, overrides = {}) {
  return { ...request, ...overrides, [BYPASS]: true };
}

/** 描述请求的提示词。强调「忠实转述」而不是「自由发挥」。 */
export const DESCRIBE_PROMPT = [
  'You are describing an image for another model that cannot see images.',
  'Produce a faithful, information-dense description in the same language as any text in the image.',
  'Cover: what the image is, all visible text verbatim, layout and position of elements,',
  'UI state if it is a screenshot, notable numbers, labels, and anything a reader would need',
  'to act on the image without seeing it. Do not speculate beyond what is visible.',
  'Reply with the description only.',
].join(' ');

/**
 * 一张图描述结果的缓存。键是附件的 content-addressed id，所以同一张图
 * 无论被引用多少次、出现在哪条消息里，都只请求视觉模型一次。
 *
 * 上限通过 `limitOf` 每次读取，而不是在构造时固定：`cacheEntries` 是 volatile
 * 配置，用户改完应当立刻生效，而不是等到下次重启。
 */
export class DescriptionCache {
  constructor(limit) {
    this.limitOf = typeof limit === 'function' ? limit : () => limit;
    this.entries = new Map();
  }

  get limit() {
    return Math.max(1, Number(this.limitOf()) || 1);
  }

  get(key) {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key);
    // 命中后移到队尾，让淘汰顺序反映最近使用。
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * 把主请求的取消信号与配置的超时合成一个信号。
 *
 * `describeTimeoutMs` 之前只进了 schema、没接到请求上（README 里记着这条限制），
 * 后果是视觉模型卡住时描述会一直挂着，只能等主请求自己超时。
 *
 * @param signal - 主请求的取消信号，可能为 undefined。
 * @param timeoutMs - 配置的超时毫秒数；非正数表示不设超时。
 * @returns 合成信号，或 undefined（两者都不需要时）。
 */
function withTimeout(signal, timeoutMs) {
  const timed = typeof timeoutMs === 'number' && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  if (timed === undefined) return signal;
  if (signal === undefined) return timed;
  // AbortSignal.any 在 Node 20+ 可用；缺失时退回主信号，不因超时能力缺失而阻断桥接。
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timed]) : signal;
}

/**
 * 把一条消息里的图片块替换成描述文本块。
 *
 * @param message - 原始消息（可能是冻结的，只读）。
 * @param describe - 按附件引用取描述的异步函数。
 * @param onImageFailure - 单张图转述失败时的处理；返回替换文本，或抛出以中止整次桥接。
 * @returns 新的消息对象；没有图片时返回原对象。
 */
async function replaceImagesInMessage(message, describe, onImageFailure) {
  if (!contentHasImage(message.content)) return message;
  const content = [];
  for (const block of message.content) {
    if (block.type !== 'image') {
      content.push(block);
      continue;
    }
    let text;
    try {
      text = await describe(block.attachment);
    } catch (error) {
      text = onImageFailure(error, block);
    }
    content.push({ type: 'text', text });
  }
  return { ...message, content };
}

/**
 * 改写整份消息列表，把每张图换成描述。
 *
 * 单张图失败的处理由 `onImageFailure` 决定：默认把失败写进占位文本，让其余图片
 * 与后续对话继续；传一个会抛出的函数则让整次桥接失败——`failClosed` 就是靠这个
 * 开关实现的，否则"失败即中止"会被这里的容错悄悄吃掉。
 *
 * @param messages - 冻结的模型消息列表。
 * @param describe - 按附件引用取描述的异步函数。
 * @param onImageFailure - 可选的单图失败处理。
 * @returns 新的消息数组。
 */
export async function replaceImagesWithDescriptions(messages, describe, onImageFailure = defaultImageFailure) {
  const next = [];
  for (const message of messages) next.push(await replaceImagesInMessage(message, describe, onImageFailure));
  return next;
}

/** 默认的单图失败处理：写成占位文本，保留消息结构。 */
function defaultImageFailure(error) {
  return `[vision bridge failed to describe this image: ${error instanceof Error ? error.message : String(error)}]`;
}

/**
 * 安装视觉桥。注册 `llm/stream` 拦截器。
 *
 * 拦截器只在「请求里真的有图」且「目标模型确实没声明 image」时才改写，
 * 其余请求原样放行，零开销。
 *
 * @param ctx - 插件上下文。
 * @param options - 路由解析器、缓存、配置读取与记录器。
 */
export function installVisionBridge(ctx, options) {
  const { resolveRoute, cache, config, logger } = options;

  ctx.on('llm/stream', (request, next) => {
    // 标记过的请求是自己发出去的，直接放行。
    if (request[BYPASS] === true) return next();
    if (!Array.isArray(request.messages) || !request.messages.some((message) => contentHasImage(message.content))) return next();

    return (async function* bridged() {
      let target;
      try {
        target = await resolveRoute(request, ctx);
      } catch (error) {
        logger.warn(`视觉桥：无法解析视觉模型路由（${error instanceof Error ? error.message : String(error)}），本次请求交回上游处理`);
        yield* next();
        return;
      }
      // 目标模型自己能看图，桥接无事可做。
      if (target === undefined) {
        yield* next();
        return;
      }

      const describe = (attachment) => describeAttachment(ctx, attachment, target, cache, config, logger, request.signal);
      const failClosed = readConfig(config, 'failClosed', false) === true;
      // failClosed 时让单图失败直接冒泡到下面的 catch，而不是被写成占位文本。
      const onImageFailure = failClosed
        ? (error) => { throw error; }
        : undefined;

      let messages;
      try {
        messages = await replaceImagesWithDescriptions(request.messages, describe, onImageFailure);
      } catch (error) {
        if (readConfig(config, 'failClosed', false) === true) throw error;
        logger.warn(`视觉桥：转述失败，退回上游占位符（${error instanceof Error ? error.message : String(error)}）`);
        yield* next();
        return;
      }

      // 用改写后的消息重新发起同一个请求。BYPASS 保证它不会再进这个拦截器。
      yield* ctx.llm.stream(bypass(request, { messages }));
    })();
  }, { prepend: true });
}

/**
 * 取一张图的描述，命中缓存则直接返回。
 *
 * 两条调用路径，取决于视觉模型来自哪里：
 *
 *   configured —— 插件自己配的 provider。没有对应的 adapter，自己发 HTTP。
 *   registered —— harness 里已注册的 route（DSH 自带的 V4.1 就是这一路）。
 *                改走 ctx.llm.stream，让持有它的 adapter 自己认证与转发，
 *                这样不必复刻各家网关的密钥与协议细节。
 *
 * @param ctx - 插件上下文，用于读取附件字节与调用已注册路由。
 * @param attachment - 图片的持久化引用。
 * @param target - 已解析的视觉模型路由。
 * @param cache - 描述缓存。
 * @param config - 插件配置。
 * @param logger - 记录器。
 * @param signal - 可选的取消信号（跟随主请求）。
 * @returns 描述文本。
 */
async function describeAttachment(ctx, attachment, target, cache, config, logger, signal) {
  const key = String(attachment.attachmentId);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const attachments = ctx.get('attachments');
  if (attachments === undefined) throw new Error('没有挂载附件服务，无法读取图片字节');
  const stored = await attachments.readImage(attachment);

  logger.info(`视觉桥：用 ${target.provider}/${target.model} 转述图片 ${key.slice(7, 15)}`);
  const bounded = withTimeout(signal, readConfig(config, 'describeTimeoutMs', 60000));
  const text = target.kind === 'registered'
    ? await describeViaRegisteredRoute(ctx, target, stored.data, attachment.mediaType, config, bounded)
    : await callVisionModel({
      profile: target.profile,
      model: target.model,
      apiKey: target.apiKey,
      bytes: [{ data: stored.data, mediaType: attachment.mediaType }],
      prompt: DESCRIBE_PROMPT,
      maxTokens: readConfig(config, 'maxOutputTokens', 1024),
      signal: bounded,
    });
  const framed = `[image described by ${target.provider}/${target.model}]
${text}`;
  cache.set(key, framed);
  return framed;
}

/**
 * 走 harness 已注册的 route 取得描述。
 *
 * 直接把图片当作消息内容发给视觉模型，并**必须带 BYPASS 标记**：
 * 这条消息本身含图片，不标记就会被本拦截器接管；而 alwaysDescribe=true 时
 * 拦截器对任何含图请求都一律转述，于是转述再触发转述，形成无限递归。
 * 绕行标记是唯一出口——不能指望"视觉模型声明了 image 就不会被拦"，
 * 那个判断恰恰被 alwaysDescribe 关掉了。
 *
 * @param ctx - 插件上下文。
 * @param target - 已解析的视觉模型路由。
 * @param data - 图片字节。
 * @param mediaType - 图片媒体类型。
 * @param config - 插件配置。
 * @param signal - 可选的取消信号。
 * @returns 描述文本。
 */
async function describeViaRegisteredRoute(ctx, target, data, mediaType, config, signal) {
  const { createUserMessage, BlockAssembler } = await import('@deepseek-ai/dsh-llm');
  const { saveImage } = await import('./vision.js');

  // 已注册 route 的 adapter 只接受持久化附件引用，不接受裸字节：
  // 先把图片提交给附件服务，再以引用构造消息。
  const attachments = ctx.get('attachments');
  if (attachments === undefined) throw new Error('没有挂载附件服务，无法提交图片给已注册的视觉模型');
  const ref = await saveImage(attachments, data, mediaType);

  const messages = [createUserMessage({
    content: [
      { type: 'text', text: DESCRIBE_PROMPT },
      { type: 'image', attachment: ref },
    ],
    source: { kind: 'dsh-vision-bridge' },
  })];

  const assembler = new BlockAssembler();
  // 必须带 BYPASS：这条转述请求自身就含图片，不标记就会被本拦截器再次接管。
  // 在 alwaysDescribe=true 下那会形成无限递归（详见 bypass() 的注释）。
  for await (const chunk of ctx.llm.stream(bypass({
    provider: target.provider,
    model: target.model,
    maxTokens: readConfig(config, 'maxOutputTokens', 1024),
    ...signal === undefined ? {} : { signal },
  }, { messages }))) {
    assembler.push(chunk);
  }
  const finish = assembler.finish;
  if (finish?.kind === 'error') throw new Error(`视觉模型调用失败：${finish.failure?.message ?? '未知错误'}`);
  const text = assembler.blocks().filter((block) => block.type === 'text').map((block) => block.text).join('').trim();
  if (text.length === 0) throw new Error('视觉模型没有返回任何文本');
  return text;
}

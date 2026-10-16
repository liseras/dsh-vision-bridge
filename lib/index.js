/**
 * dsh-vision-bridge —— 独立配置视觉模型，主模型不支持图片时自动转述。
 *
 * 两种用法并存：
 *   - 当主模型声明了 image 模态：什么都不做，图片直接给主模型。
 *   - 当主模型没声明 image：上游本会把图片换成 "[image omitted ...]" 占位符，
 *     本插件抢在那之前把图片交给配置好的视觉模型，把描述文本交给主模型。
 *
 * 组件分工：
 *   config.js  —— 与上游 pi-ai 同构的配置 schema（模型设置页认它）
 *   vision.js  —— 视觉模型的一次性 HTTP 调用（两种协议）
 *   bridge.js  —— llm/stream 拦截器与描述缓存
 */
import { Config } from './config.js';
import { readConfig } from './values.js';
import { DescriptionCache, installVisionBridge } from './bridge.js';

export { Config };
export const name = 'dsh-vision-bridge';
export const inject = ['llm'];

/**
 * 把本插件的 provider 配置转成 harness 的配置目录条目。
 *
 * 每条 entry 描述一个可编辑的路由；settingsPath 指向该 route 在本插件配置
 * 里的位置，设置页据此寻址。只声明有模型的 provider，避免目录里出现空壳。
 *
 * @param providers - 插件的 provider 字典。
 * @param settingsNs - 本插件的 settings namespace。
 * @returns 目录条目列表。
 */
function configuredVisionProviders(providers, settingsNs) {
  const entries = [];
  for (const [provider, profile] of Object.entries(providers ?? {})) {
    if ((profile?.models ?? []).length === 0) continue;
    entries.push({
      provider,
      displayName: profile.displayName ?? provider,
      settingsNs,
      settingsPath: ['providers', provider],
      declared: true,
    });
  }
  return entries;
}

/** 读取本插件的 provider 字典；volatile 字段需要经 .get() 解包。 */
function providersOf(config) {
  return readConfig(config, 'providers', {});
}

/**
 * 列出本插件自己配置的模型。
 *
 * `declaredImage` 记录模型有没有声明 image 模态，用于排序与提示，**不用于过滤**：
 * 声明是提示，不是事实——大量中转网关在 profile 里写成 openai-completions 且不声明
 * `input`，后端却完全支持视觉。按声明过滤会让候选恒为空（页面只剩"自动"，桥接永不触发）。
 *
 * @param providers - 插件的 provider 字典。
 * @returns 形如 { provider, profile, model, declaredImage } 的列表。
 */
function configuredVisionModels(providers) {
  const found = [];
  for (const [provider, profile] of Object.entries(providers ?? {})) {
    for (const model of profile?.models ?? []) {
      found.push({
        provider,
        profile: { ...profile },
        model,
        declaredImage: Array.isArray(model.input) && model.input.includes('image'),
      });
    }
  }
  return found;
}

/**
 * 枚举 harness 里**所有已注册**的、声明了图片能力的模型。
 *
 * 这一路覆盖了 DSH 自带的视觉模型（例如官方 adapter 的 deepseek-flash），
 * 它们的模型声明写在 adapter 代码里，不在任何可编辑的 provider 配置中——
 * 只看插件的 providers 会漏掉它们，而它们往往正是最好用的那只"眼睛"。
 *
 * @param ctx - 插件上下文。
 * @param logger - 记录器。
 * @returns 形如 { provider, model, declaredImage } 的候选列表。
 */
async function registeredVisionModels(ctx, logger) {
  const found = [];
  let providers;
  try {
    providers = ctx.llm.listProviders();
  } catch (error) {
    logger.warn(`视觉桥：枚举已注册 provider 失败（${error instanceof Error ? error.message : String(error)}）`);
    return found;
  }
  for (const entry of providers ?? []) {
    try {
      const models = await ctx.llm.listModels(entry.id);
      for (const model of models ?? []) {
        found.push({
          provider: entry.id,
          model: { id: model.id },
          declaredImage: model.inputModalities?.includes('image') === true,
        });
      }
    } catch (error) {
      // 单个 route 列不出模型不影响其它 route。
      logger.warn(`视觉桥：枚举 ${entry.id} 的模型失败（${error instanceof Error ? error.message : String(error)}）`);
    }
  }
  return found;
}

/**
 * 借用其它插件已配好的 provider 连接信息（baseURL / api / apiKeyEnv）。
 *
 * ## 为什么必须要这一步
 *
 * 走 `ctx.llm.stream` 的 registered 路径有个硬限制：上游 `dsh-llm` 在 adapter 派发前
 * 会做一次投影（`dsh-llm/lib/index.js` 的 `projectImagesForTextModel`）——
 *
 *     if (modelInfo.inputModalities !== undefined
 *         && !modelInfo.inputModalities.includes("image")
 *         && messages.some(hasImage)) projected = projectImagesForTextModel(...)
 *
 * 于是**没声明 image 的模型永远收不到图片本身**，只会收到
 * `[image omitted because this model accepts text only; ...]`。
 * 而 pi-ai 的 `defaultInput` 是 `["text"]`，profile 里常见的网关写法（不写 `input`）
 * 正好落进这个分支：后端明明支持视觉，桥接却注定拿到占位符当"描述"。
 *
 * 所以对"没声明 image"的候选，必须绕开 adapter、自己按 profile 直连。
 * 连接信息从 `settings.describe()` 里读——它暴露每个 entry 的**归一化 value**，
 * 恰好包含 baseURL / api / apiKeyEnv，于是用户不必把同一份网关配置抄第二遍。
 *
 * @param ctx - 插件上下文。
 * @param provider - provider route 名（例如 codepin）。
 * @param logger - 记录器。
 * @returns 可直接发请求的 profile，或 undefined。
 */
function borrowedProfile(ctx, provider, logger) {
  const settings = ctx.get('settings');
  if (settings === undefined) return undefined;
  let descriptors;
  try {
    descriptors = settings.describe();
  } catch (error) {
    logger.warn(`视觉桥：读取设置目录失败（${error instanceof Error ? error.message : String(error)}）`);
    return undefined;
  }
  for (const descriptor of descriptors ?? []) {
    // describe() 的值是归一化后的完整配置；provider 字典通常挂在 providers 下。
    const dictionary = descriptor?.value?.providers;
    if (dictionary === null || typeof dictionary !== 'object') continue;
    const profile = dictionary[provider];
    if (profile === null || typeof profile !== 'object') continue;
    const baseURL = typeof profile.baseURL === 'string' ? profile.baseURL : undefined;
    if (baseURL === undefined || baseURL.length === 0) continue;
    return {
      baseURL,
      api: typeof profile.api === 'string' ? profile.api : undefined,
      apiKeyEnv: typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined,
      models: Array.isArray(profile.models) ? profile.models : [],
      timeoutMs: profile.timeoutMs,
    };
  }
  return undefined;
}

/** 把 "provider/model" 拆开；形状不对时返回 undefined。 */
function parseVisionModel(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

/**
 * 解析一次请求该用哪个视觉模型。
 *
 * 返回 undefined 表示**不需要桥接**，来源有三：请求的目标模型自己就能看图、
 * 总开关关闭，或者配置里根本没有可用的视觉模型。
 *
 * @param request - 正在被拦截的模型请求。
 * @param ctx - 插件上下文，用于查询目标模型的能力。
 * @returns 视觉模型路由，或 undefined。
 */
async function resolveVisionRoute(request, ctx, config, logger) {
  // 总开关：关掉时完全放行，图片交回上游的占位符策略。
  if (readConfig(config, 'enabled', true) !== true) return undefined;

  // 目标模型自己声明了 image 就无需桥接——除非配置要求一律转述。
  //
  // `alwaysDescribe` 存在的理由：DSH 核心在图片入库前会按 `inputModalities`
  // 拒绝"不支持图片"的模型，而那道检查早于本插件挂载的 `llm/stream`，
  // 于是纯文本后端连图片都传不进来。让这类后端在 profile 里声明 image
  // 可以放行入库，但声明之后本插件就会误以为"它自己能看图"而跳过转述，
  // 裸图照样发给收不了图的后端。打开这个开关就把两件事分开：
  // 声明只用于通过入库检查，转述与否由这里决定。
  if (readConfig(config, 'alwaysDescribe', false) !== true) {
    try {
      const info = await ctx.llm.resolveModelInfo(request.provider, request.model, request.signal);
      if (info.inputModalities?.includes('image') === true) return undefined;
    } catch (error) {
      // 解析不出能力时不阻断：交给下面的候选检查决定。
      logger.warn(`视觉桥：解析 ${request.provider}/${request.model} 的能力失败（${error instanceof Error ? error.message : String(error)}）`);
    }
  }

  const wanted = parseVisionModel(readConfig(config, 'visionModel', ''));

  // 候选来源一：本插件自己配置的模型（携带完整 profile，可直接发请求）。
  const configured = configuredVisionModels(providersOf(config));
  // 候选来源二：harness 里已注册的模型（purpose 是借用它们的连接信息或 adapter）。
  const registered = await registeredVisionModels(ctx, logger);

  // 合并去重，configured 优先（它有显式配置的端点）。
  const seen = new Set();
  const candidates = [];
  for (const entry of configured) {
    const key = entry.provider + '/' + entry.model.id;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ ...entry, kind: 'configured' });
  }
  for (const entry of registered) {
    const key = entry.provider + '/' + entry.model.id;
    if (seen.has(key)) continue;
    seen.add(key);
    // adapterReady：这个候选会真的走 adapter（而不是借连接信息自己发 HTTP）。
    // 只有这一类能吃到上游的能力声明，"谁更适合当眼睛"的判断全靠它，见下方排序。
    candidates.push({ ...entry, profile: undefined, kind: 'registered', adapterReady: entry.declaredImage === true });
  }

  /**
   * 把一个候选变成"能真正拿到图片"的可调用路由。
   *
   * 这一段是整个插件最容易做错的地方，两条路径的取舍由**能力声明**决定：
   *
   *   声明了 image  → 走 adapter（`ctx.llm.stream`）。上游不会投影图片，adapter
   *                   自己认证，最省事也最正确。
   *   没声明 image  → 必须自己发 HTTP。走 adapter 的话，上游会在派发前把图片
   *                   换成 "[image omitted ...]"，描述函数拿到的就是那句占位符。
   *                   连接信息向 settings 目录借（见 borrowedProfile）。
   *
   * 都拿不到可用 profile 时返回 undefined，让这次桥接回退到上游占位符。
   */
  const usableRoute = async (entry) => {
    if (entry.kind === 'configured') {
      const profile = entry.profile;
      if (profile?.baseURL === undefined || profile.baseURL.length === 0) return undefined;
      return {
        provider: entry.provider,
        model: entry.model.id,
        profile,
        kind: 'http',
        apiKey: await resolveApiKey(ctx, profile),
        declaredImage: entry.declaredImage === true,
      };
    }
    if (entry.declaredImage === true) {
      // adapter 能收到图片，交给它认证。
      return {
        provider: entry.provider,
        model: entry.model.id,
        profile: undefined,
        kind: 'registered',
        apiKey: undefined,
        declaredImage: true,
      };
    }
    // 未声明 image：借连接信息自己发请求，否则注定只拿到占位符。
    const borrowed = borrowedProfile(ctx, entry.provider, logger);
    if (borrowed === undefined || borrowed.baseURL.length === 0) return undefined;
    return {
      provider: entry.provider,
      model: entry.model.id,
      profile: borrowed,
      kind: 'http',
      apiKey: await resolveApiKey(ctx, borrowed),
      declaredImage: false,
    };
  };

  /**
   * 自指（正在被桥接的模型自己也在候选池里）该怎么处理。
   *
   * 判据是**用户有没有把它显式选成视觉模型**，而不是它声不声明 image。
   *
   * 为什么不看声明：本插件读到的 `inputModalities` 全是配置里写死的字符串，
   * 而"声明 image"在本项目里有两种截然不同的来由 ——
   *
   *   真能看图：DSH 自带模型的声明来自 adapter 代码，可信。
   *   只为入库：中转网关（本项目里的 codepin）声明 image 纯粹是为了让 DSH
   *             核心放行图片入库，后端其实收不了图。
   *
   * 两者在配置里长得一模一样，插件无从分辨。拿声明当判据，就会把图片
   * "转述"给一个收不了图的后端。
   *
   * 唯一可信的信号是用户的显式指定：他把某个模型填进 visionModel，就是
   * 在说"我认为它能看图"。此时如果主模型正是它，含义是"我自己会看图，
   * 别绕道"——放行，图片原样交给主模型。反过来，若用户指定的视觉模型是
   * 别的模型，主模型自指的排除照旧。
   */
  const self = candidates.find((entry) => entry.provider === request.provider && entry.model.id === request.model);
  if (self !== undefined && wanted !== undefined
    && self.provider === wanted.provider && self.model.id === wanted.model) {
    logger.info(`视觉桥：${request.provider}/${request.model} 正是配置的视觉模型，图片直接交给它`);
    return undefined;
  }

  // 排除正在被桥接的那个模型——它拿不到图片，让它当眼睛毫无意义。
  const pool = candidates.filter((entry) => !(entry.provider === request.provider && entry.model.id === request.model));
  if (pool.length === 0) {
    if (candidates.length > 0) logger.warn('视觉桥：可用的视觉模型只有当前请求的模型本身，无法桥接');
    return undefined;
  }

  // 用户显式指定的模型优先，且不受"是否声明 image"的限制：声明是提示，不是事实。
  const explicit = wanted === undefined
    ? undefined
    : pool.find((entry) => entry.provider === wanted.provider && entry.model.id === wanted.model);
  const requested = wanted === undefined ? [] : [explicit].filter((entry) => entry !== undefined);

  // 其余候选：能走 adapter 的排前面。
  //
  // 为什么排序而不是保持原样：这两类的**可验证程度**不同。
  //
  //   adapterReady —— 它自己声明了图片模态，声明与实际能力一致的概率高，
  //                   而且由 adapter 认证转发，拿不到图就报错，不会静默降级。
  //   其余          —— 借连接信息直连，能不能收图全凭后端，本插件无从判断。
  //
  // 本插件此前宣称"不做任何排序，谁更可能成功交给用户判断"。问题在于用户
  // 在设置页看到的候选是按本文件顺序列的，看不出这个差别，于是"交给用户判断"
  // 实际变成了"让用户抽签"。现在把插件**确实知道**的那点信息（能不能走 adapter）
  // 用于排序；插件不知道的（某个后端到底收不收图）依旧不猜。
  //
  // 组内保持原顺序（本插件配置的在前，已注册的在后）。
  const rest = pool
    .filter((entry) => entry !== explicit)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (Number(b.entry.adapterReady === true) - Number(a.entry.adapterReady === true)) || (a.index - b.index))
    .map(({ entry }) => entry);

  for (const entry of [...requested, ...rest]) {
    const route = await usableRoute(entry);
    if (route !== undefined) {
      if (entry !== explicit && wanted !== undefined) {
        logger.warn(`视觉桥：配置的 visionModel "${readConfig(config, 'visionModel', '')}" 不可用，改用 ${route.provider}/${route.model}`);
      }
      return route;
    }
    if (entry === explicit) {
      logger.warn(`视觉桥：配置的 visionModel "${readConfig(config, 'visionModel', '')}" 拿不到可用的连接信息，改用其它候选`);
    }
  }
  logger.warn('视觉桥：没有任何候选能真正拿到图片，本次请求交回上游');
  return undefined;
}

/**
 * 解析视觉调用的密钥。
 *
 * 两条路来源不同：插件自己配置的 provider 走 apiKeyEnv → credentials；
 * 已注册 route（DSH 自带模型）的密钥由它自己的 adapter 在内部解析，
 * 这里返回 undefined 即可——下面改用 ctx.llm.stream 让原 adapter 自己认证。
 *
 * @param ctx - 插件上下文。
 * @param chosen - 已选定的视觉模型。
 * @returns 密钥，或 undefined。
 */
async function resolveVisionApiKey(ctx, chosen) {
  if (chosen.profile === undefined) return undefined;
  return resolveApiKey(ctx, chosen.profile);
}

/**
 * 取一个 provider profile 的 API key。
 * @param ctx - 插件上下文。
 * @param profile - provider 配置。
 * @returns 密钥字符串，未配置时为 undefined。
 */
async function resolveApiKey(ctx, profile) {
  const ref = profile?.apiKeyEnv;
  if (typeof ref !== 'string' || ref.length === 0) return undefined;
  const credentials = ctx.get('credentials');
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref);
    if (hit?.value !== undefined && hit.value.length > 0) return hit.value;
  }
  const env = process.env[ref];
  return typeof env === 'string' && env.length > 0 ? env : undefined;
}

/**
 * 装配插件。
 * @param ctx - 插件上下文。
 * @param config - 已按 schema 归一化的配置。
 */
export function apply(ctx, config) {
  const settingsNs = ctx.fiber?.entry?.options.id ?? 'dsh-vision-bridge';

  // 这个 namespace 由本插件自绘设置页，所以关掉自动生成的表单。
  // 与上游 llm-pi-ai 的做法一致；不这样做，配置端口不会进入目录，
  // 设置页也就看不到任何可编辑的 provider。
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });

  // 把视觉 provider 声明进 harness 的配置目录。
  // 模型设置页/视觉模型页都靠 listConfigurableProviders 才认得出该路由，
  // 缺了这一步，页面就是空白的。
  const ensureDirectory = () => {
    const entries = configuredVisionProviders(providersOf(config), settingsNs);
    if (entries.length === 0) return;
    if (directory === undefined) directory = ctx.llm.registerConfigurableProviders(entries);
    else directory.replace(entries);
  };
  let directory;
  try {
    ensureDirectory();
  } catch (error) {
    ctx.logger.warn(`视觉桥：声明可配置 provider 失败（${error instanceof Error ? error.message : String(error)}）`);
  }
  ctx.on('loader/volatile-update', () => {
    try { ensureDirectory(); } catch (error) {
      ctx.logger.warn(`视觉桥：刷新可配置 provider 失败（${error instanceof Error ? error.message : String(error)}）`);
    }
  });

  // 把"某个 route 上有哪些可看图的模型"暴露给设置页。
  //
  // 为什么必须由 Host 代劳：`llm.listModels` 与 `resolveModelInfo` 都不带
  // `@Remote` 装饰器，浏览器侧根本调不到；而 `session.modelCatalog()` 返回的
  // 模型条目里**不含 inputModalities**。于是前端无从判断哪个模型真正声明了图片。
  //
  // `remoteDiscoverModels` 是这条 seam 上唯一可用的通道，且它的返回结构
  // 原样保留 inputModalities，正好够用。
  ctx.llm.registerModelDiscovery(settingsNs, async (request) => {
    const provider = request?.provider;
    if (typeof provider !== 'string' || provider.length === 0) return [];
    try {
      return await ctx.llm.listModels(provider);
    } catch (error) {
      // 单个 route 列不出模型不影响其它 route。
      ctx.logger.warn(`视觉桥：枚举 ${provider} 的模型失败（${error instanceof Error ? error.message : String(error)}）`);
      return [];
    }
  });

  // 上限读成一个函数，让 cacheEntries 的热更新立刻生效（见 DescriptionCache）。
  const cache = new DescriptionCache(() => readConfig(config, 'cacheEntries', 256));
  installVisionBridge(ctx, {
    cache,
    config,
    logger: ctx.logger,
    resolveRoute: (request) => resolveVisionRoute(request, ctx, config, ctx.logger),
  });

  const enabled = readConfig(config, 'enabled', true) === true;
  const candidates = configuredVisionModels(providersOf(config));
  if (!enabled) {
    ctx.logger.info('视觉桥：已停用（enabled=false），图片按上游占位符策略处理');
  } else if (candidates.length === 0) {
    ctx.logger.info('视觉桥：尚未配置视觉模型，将尝试借用已注册的 provider');
  } else {
    ctx.logger.info(`视觉桥：已就绪，已配置 ${candidates.map((entry) => `${entry.provider}/${entry.model.id}`).join('、')}`);
  }
}

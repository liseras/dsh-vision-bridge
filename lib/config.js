/**
 * 配置 schema —— 刻意与 `@deepseek-ai/dsh-llm-pi-ai` 的 providers 形状同构。
 *
 * 同构有两个作用：
 *   1) 模型设置页那份编辑器认得出这个 namespace 的字段结构，目录/自定义两个
 *      标签页、密钥、模型增删、连通性测试都能照常用；
 *   2) 迁移过来的人的已有 provider 配置可以直接粘贴，不需要翻译字段名。
 *
 * 唯一的差异是 `models[].input`：视觉桥只接受声明了 `image` 的模型。
 * 这一条由 resolveProfiles 强制，而不是留给用户自己遵守。
 */
import z from '@deepseek-ai/schemastery';

/** 本桥支持的传输协议。与上游 pi-ai 的协议名保持一致。 */
export const PROTOCOLS = ['openai-completions', 'anthropic-messages'];

/** 模态取值，与上游同名。 */
const MODALITIES = ['text', 'image'];

const modelFields = {
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  input: z.array(z.union(MODALITIES)),
};

const modelProfile = z.object({
  id: z.string().required(),
  ...modelFields,
});

const profile = z.object({
  apiKeyEnv: z.string(),
  displayName: z.string(),
  api: z.union(PROTOCOLS),
  baseURL: z.string(),
  models: z.array(modelProfile),
  defaultContextWindow: z.number().step(1).min(1).default(262144),
  defaultMaxTokens: z.number().step(1).min(1).default(32768),
  timeoutMs: z.natural(),
});

/**
 * 插件配置：一个 provider 字典，加视觉桥自己的策略字段。
 *
 * **每个字段单独标 `.volatile()`**，而不是给整个对象标——这个区别是关键的：
 *
 *   - 字段级：`Config(raw).providers` 是带 `.get()` 的包装，其余字段正常，
 *     与上游 llm-pi-ai 的 `z.dict(profile).default({}).volatile()` 形状一致。
 *   - 对象级：整个 schema 塌缩成**一个** volatile 包装，`Config(raw).providers`
 *     直接变成 `undefined`，所有读取全部失效。
 *
 * 那为什么非标不可：`dsh-settings` 的 `describe()` 先调用 `volatileForm(schema)`，
 * 该函数只收集带 volatile 标记的字段——一个都没有时返回 `undefined`，describe 便
 * 整个跳过这个插件。后果是设置页的 `state.namespaces` 里没有这个 namespace，
 * 界面空白，且写回任何字段都会被判为非 volatile 路径而拒绝。
 *
 * 读取这些字段统一走 `readConfig()`（见 values.js），它兼容"包装/普通值"两种形态。
 */
export const Config = z.object({
  providers: z.dict(profile).default({}).volatile(),

  /**
   * 视觉桥总开关。false 时拦截器完全放行，图片交回上游的占位符策略。
   *
   * 默认 true：升级到本版本的人原本就在用这个插件，不该因为多了一个开关
   * 就悄悄失效（或反过来突然生效）。
   */
  enabled: z.boolean().default(true).volatile(),
  /**
   * 指定用哪个 route/model 看图，形如 "codepin/glm-5.3-flash"。留空则自动选第一个候选。
   *
   * 这个字段是**用户意图**，不是能力声明：即使模型没在 adapter 里声明 image 模态，
   * 只要它的后端真的能看图（很多中转网关如此），就要照用。
   *
   * 候选列表**不做任何能力筛选与排序**：声明只是配置里的静态字段，不代表后端
   * 真的收不收图片——那只有试过才知道，由用户自己判断，插件不替他下结论。
   */
  visionModel: z.string().default('').volatile(),
  /**
   * 是否对所有图片请求一律转述，**不再看主模型是否声明了图片能力**。
   *
   * 为什么需要它：DSH 核心在图片入库前会按 `inputModalities` 拒绝"不支持图片"
   * 的模型，那道检查早于本插件挂载的 `llm/stream`。让纯文本后端在 profile 里
   * 声明 image 可以放行入库，但声明之后本插件会以为它自己能看图而跳过转述。
   * 打开这个开关就把两件事分开：声明只用于通过入库检查，是否转述由本开关决定。
   *
   * 默认 false：主模型真能看图时不该白白多绕一次转述。
   */
  alwaysDescribe: z.boolean().default(false).volatile(),
  /** 单张图描述的最大 token 数。 */
  maxOutputTokens: z.natural().default(1024).volatile(),
  /** 单次描述请求的超时（毫秒）。 */
  describeTimeoutMs: z.natural().default(60000).volatile(),
  /** 描述缓存条数上限；同一张图（按 attachmentId）不重复请求。 */
  cacheEntries: z.natural().default(256).volatile(),
  /** 自动桥接失败时是否中止请求（true），还是退回上游的"[图片已省略]"占位符（false）。 */
  failClosed: z.boolean().default(false).volatile(),
});

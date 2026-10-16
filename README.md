# dsh-vision-bridge — 视觉桥

给不支持图片的模型配一个"眼睛"。

主模型（比如 `deepseek-v4.1-flash`）不能看图时，上游会把图片换成
`[image omitted because this model accepts text only; ...]`。本插件抢在那之前
把图片交给你在**视觉模型**页配置的模型，把描述文字交给主模型。主模型无感。

## 配置

设置 → **视觉模型**。界面与「模型」页完全一致：

页面顶部有**「用于看图的模型」下拉框**，列出所有可用候选（本插件配的在前，DSH 自带的带"（自带）"后缀）。
留空 = 自动选第一个可用者。

- **第三方模型提供商**：从内置目录选，填密钥。
- **自定义模型 API**：填 API 地址、协议（OpenAI / Anthropic 兼容）、模型列表，点「测试」可拉模型目录。

**关键：模型的"输入类型"必须勾上"图片"**，否则它不会被当作视觉模型使用。
只有勾了图片的模型才会出现在桥上。

插件设置（`settings` 里本插件的 namespace）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `visionModel` | `""` | 指定用哪个模型看图，形如 `codepin/glm-5.3-flash`；设置页顶部的下拉框写这个字段。留空 = 自动选第一个可用者 |
| `maxOutputTokens` | 1024 | 单张图描述的最大 token |
| `describeTimeoutMs` | 60000 | 描述请求超时（当前实现未启用外部取消） |
| `cacheEntries` | 256 | 描述缓存条数；同一张图只请求一次 |
| `failClosed` | false | `true`：转述失败就中止本次请求；`false`：退回上游占位符 |

## 行为

| 情况 | 结果 |
|---|---|
| 主模型声明了图片能力 | 不介入，图片直接给主模型 |
| 主模型不支持图片，且配了视觉模型 | 自动转述，替换为描述文本 |
| 主模型不支持图片，且没配视觉模型 | 保持上游行为（占位符） |
| 视觉模型调用失败 | 该图片替换为失败说明，其余图片照常；整体不中断（除非 `failClosed`） |

## 设计要点

**为什么不用 `llm` adapter。** `ctx.llm.registerConfigurableProviders` 的 provider
名是全局唯一的，视觉桥的 provider 与其它 adapter 共享同一命名空间。注册一个只为
看图服务的 adapter，会把两套路由的生命周期绑在一起。视觉调用是单向窄接口，直接发
HTTP 更稳。

**为什么桥接要自建流。** cordis 的 `waterfall` 按引用透传参数数组，`next()` 调用的是
闭包里的 inner，**忽略传入参数**；且 agent-loop 的请求被 deepFreeze。
所以改写后的 options 通过带 `BYPASS` 标记的 `ctx.llm.stream()` 重新发出，避免递归。

**`BYPASS` 是硬性不变量，两处重发都必须带。** 桥接内部会发起两次模型调用：

| 发起方 | 用途 | 必须带标记的原因 |
|---|---|---|
| 拦截器的 `bridged()` | 用描述文本替换图片后的**主请求重放** | 改写后的消息不再含图，但标记让它连"是否含图"的检查都跳过 |
| `describeViaRegisteredRoute` | 交给视觉模型的**转述请求** | 它自己就含图片，不标记就会被同一个拦截器接管 |

第二处漏标记的后果不是多绕一次，而是**无限递归**：`alwaysDescribe: true` 会关掉
"目标模型自己能看图就不桥接"这个短路，于是转述请求被拦下、又去找一个视觉模型、
又发出一个带图请求……每层都在 `await` 下一层，任何一层都不会产出 chunk。

实测表现：界面显示"发出去了"但永远没有响应，停止/暂停按钮也按不动——
取消信号传不进已经开始的下一圈，而 CPU 会被这个纯本地循环打满（实测约 160% 单核）。
所以标记统一由 `bypass()` 落，调用方不要再手写对象。

**为什么配置 schema 与上游同构。** 设置页那份编辑器认得出这个字段结构，目录/自定义
两个标签页、密钥、模型增删、连通性测试都能照常用，字段名也无需翻译。

## 文件

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 装配：路由选择、密钥解析、注册拦截器 |
| `lib/config.js` | 配置 schema（与上游 pi-ai 同构） |
| `lib/vision.js` | 视觉模型 HTTP 调用（OpenAI / Anthropic 两种协议） |
| `lib/bridge.js` | `llm/stream` 拦截器、图片替换、描述缓存 |
| `client.js` | 设置页 UI（基于上游模型页改造，namespace 指向本插件） |

## 测试

```bash
node test/host.test.js    # 配置、替换、缓存、拦截器（13 项）
node test/vision.test.js  # 两种协议的请求与响应（8 项）
```

## 实现要点：为什么页面会是空白

配置页能显示可编辑的 provider，依赖两件事，缺一不可：

1. **Host 端 `settings.configure({ auto: false })`** —— 告诉 settings 服务这个 namespace 由插件自绘。
   不声明的话，配置端口不进入目录，页面看不到任何东西。
2. **Host 端 `ctx.llm.registerConfigurableProviders(entries)`** —— 把 provider 声明进 harness 的配置目录。
   设置页靠 `listConfigurableProviders()` 才认得出该路由；缺了它，`state.namespaces.has(settingsNs)`
   判定失败，行既不可编辑、添加卡片也不出现。

`settingsNs` 必须等于**插件 entry 的 id**（即 `dsh-vision-bridge`），因为
`settings.describe()` 用 `entry.options.id` 作为 namespace。名字对不上，UI 就找不到 schema。

## 候选模型的两个来源

| 来源 | 认证方式 | 说明 |
|---|---|---|
| 本插件配置的 provider | 自己发 HTTP（OpenAI / Anthropic） | 设置页里添加的 |
| **harness 已注册的视觉模型** | 走 `ctx.llm.stream`，由原 adapter 认证 | **DSH 自带的 V4.1 走这一路**；它的 `inputModalities` 声明在 adapter 代码里，不可编辑 |

优先级：自己配的 > 已注册的。

**候选排序**：能走 adapter 的排前面。这不是按"谁更强"排，而是按**插件能验证到什么程度**排：

| 类别 | 判据 | 插件知道什么 |
|---|---|---|
| 能走 adapter | 声明了 `image`，请求由 adapter 认证转发 | 拿不到图 adapter 会报错，不会静默降级 |
| 只能直连 | 未声明 `image`，借连接信息自己发 HTTP | 后端到底收不收图，本插件无从判断 |

组内保持原顺序（自己配的在前，已注册的在后）。插件**不知道**的那部分（某个网关实际收不收图）依旧不猜——仍由用户在设置页里判断。

### 声明为什么不能当判据

插件读到的 `inputModalities` 全是配置里写死的字符串。"声明了 `image`"在本项目里有两种
来由，长得一模一样，含义却相反：

| 来由 | 例 | 后端实际收不收图 |
|---|---|---|
| adapter 里真声明 | DSH 自带的 `deepseek-flash` | 收 |
| 真能看图，遂如实声明 | `codepin/deepseek-v4.1-flash` | 收 |
| 只为让图片通过入库检查 | `codepin/glm-5.3-flash` | **不收** |

DSH 核心在图片入站时会按当前主模型的 `inputModalities` 拒绝"不支持图片"的模型
（`dsh-api-session-controller` 的 `prompt()`，抛 `MODEL_DOES_NOT_SUPPORT_IMAGES`），
用户看到的是"当前模型不支持图片，请切换支持图片的模型"。

**这条检查在图片入库之前，早于本插件挂载的 `llm/stream`。** 所以结论是反直觉的：

> 一个后端明明收不了图，也**必须**在 profile 里声明 `image`，
> 否则用户连图都发不进来，本插件根本没有机会把它转述成文字。

声明在这里的作用只是"放行入库"，与后端能力无关；是否转述由 `alwaysDescribe` 决定。
两者配合，才能让收不了图的模型也"用上"图片。

**同一个 provider 下各模型能力可能不同**，不要用一个模型的测试结果推断整个 provider。
实测 `codepin/deepseek-v4.1-flash` 收图并准确描述内容，而 `codepin/glm-5.3-flash`
回"我目前无法查看图片内容——当前模型不支持多模态输入"。

**所以唯一可信的信号是用户的显式指定**：他把某个模型填进 `visionModel`，就是在说
"我认为它能看图"。插件只信这个。

### 自指的处理

自指 = 正在被桥接的模型自己也在候选池里。

| 情况 | 行为 |
|---|---|
| 目标模型正是用户指定的 `visionModel` | **放行**，图片原样交给它（"我自己会看图，别绕道"） |
| 未开 `alwaysDescribe`，且目标模型自己声明了 `image` | 放行（上游的投影短路会先返回） |
| 其余 | 排除它，在别的候选里找眼睛 |

## 已知限制

- **`alwaysDescribe` 是全局开关，无法按主模型区分。** 当同一份 profile 里既有"真能看图"
  又有"收不了图"的模型时，二者只能取其一：

  | 配法 | 主模型看图？ | 收不了图的模型 | 代价 |
  |---|---|---|---|
  | `alwaysDescribe: true` + `visionModel` 指向别的模型 | 走转述（信息有损） | 也能用图 | 每次多一次视觉调用 |
  | `alwaysDescribe: false` + `visionModel` 指向主模型自己 | 直接看图 | 上游回"无法查看图片" | 收不了图的模型用不了图 |

  本项目选的是前者（`visionModel: deepseek-official/deepseek-flash`、
  `alwaysDescribe: true`），为了"切换主模型都还能用图"而牺牲主模型的直读能力。
- 描述请求的信号是 `AbortSignal.any([主请求 signal, AbortSignal.timeout(describeTimeoutMs)])`，
  两者任一触发都会中止这次描述；超时后按 `failClosed` 决定中止整次请求还是退回占位符。
- 描述按 `attachmentId` 缓存，进程重启后失效。
- `client.js` 是上游模型页的改造副本。DSH 升级后需按同样几处重新同步：
  `id`、`NS$1`、`layoutOf`、`state.namespaces.get`、section `id`、中英文 `nav/title/intro`。

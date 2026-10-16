/**
 * 视觉模型的调用层。
 *
 * 这里刻意**不注册 `llm` adapter**。原因是 `ctx.llm.registerConfigurableProviders`
 * 对 provider 名做全局唯一校验，而视觉桥的 provider 与本机其它 adapter 处在同一
 * 命名空间；注册一个只为「看图」服务的 adapter，会把两套路由的生命周期绑在一起，
 * 徒增冲突面。视觉调用是单向、窄接口的一次 HTTP 往返，自己发请求比接进 seam 更稳。
 *
 * 代价是这里要自己处理两种 wire 协议。范围被刻意收窄到只有：
 *   一张或多张图 + 一段提示词 → 一段文本。
 */

/** 图片格式嗅探：只认 read_image 接受的那四种。 */
const SIGNATURES = [
  { mediaType: 'image/png', test: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mediaType: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mediaType: 'image/gif', test: (b) => b.length >= 6 && (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) },
  { mediaType: 'image/webp', test: (b) => b.length >= 12 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP') },
];

function ascii(bytes, offset, text) {
  for (let i = 0; i < text.length; i += 1) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

/**
 * 从一个字节流的魔数判断图片类型。
 * @param bytes - 文件开头的字节。
 * @returns 识别出的 media type，无法识别时返回 undefined。
 */
export function sniffImageMediaType(bytes) {
  for (const { mediaType, test } of SIGNATURES) if (test(bytes)) return mediaType;
  return undefined;
}

/** 拼接 baseURL 与端点路径，避免出现双斜杠。 */
function joinURL(base, path) {
  return base.replace(/\/+$/, '') + path;
}

/** 把一次 HTTP 往返的失败整理成可读的消息。 */
async function readFailure(response) {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 500);
  } catch {
    /* 读取响应体失败不影响报告状态码 */
  }
  return `视觉模型返回 HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
}

/**
 * 走 OpenAI chat-completions 协议请求一次视觉描述。
 * @param options - 端点、密钥、模型、提示词与图片。
 * @returns 模型输出的文本。
 */
async function callOpenAICompletions(options) {
  const { baseURL, apiKey, model, prompt, images, maxTokens, signal } = options;
  const content = [{ type: 'text', text: prompt }];
  for (const image of images) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
    });
  }
  const response = await fetch(joinURL(baseURL, '/chat/completions'), {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content }],
    }),
  });
  if (!response.ok) throw new Error(await readFailure(response));
  const payload = await response.json();
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text === 'string') return text;
  // 部分网关以分片数组返回 content。
  if (Array.isArray(text)) {
    const joined = text.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
    if (joined.length > 0) return joined;
  }
  throw new Error('视觉模型返回了空的响应体');
}

/**
 * 走 Anthropic messages 协议请求一次视觉描述。
 * @param options - 端点、密钥、模型、提示词与图片。
 * @returns 模型输出的文本。
 */
async function callAnthropicMessages(options) {
  const { baseURL, apiKey, model, prompt, images, maxTokens, signal } = options;
  const content = [];
  for (const image of images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
    });
  }
  content.push({ type: 'text', text: prompt });
  const response = await fetch(joinURL(baseURL, '/messages'), {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(apiKey === undefined ? {} : { 'x-api-key': apiKey }),
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content }] }),
  });
  if (!response.ok) throw new Error(await readFailure(response));
  const payload = await response.json();
  const parts = Array.isArray(payload?.content) ? payload.content : [];
  const text = parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  if (text.length > 0) return text;
  throw new Error('视觉模型返回了空的响应体');
}

/**
 * 调用配置好的视觉模型，把图片转成文字描述。
 * @param options - 已解析的 profile、模型 id、密钥、提示词与图片字节。
 * @returns 模型输出的描述文本。
 */
export async function callVisionModel(options) {
  const { profile, model, apiKey, bytes, prompt, maxTokens, signal } = options;
  const images = bytes.map((entry) => {
    const mediaType = entry.mediaType ?? sniffImageMediaType(entry.data);
    if (mediaType === undefined) throw new Error('无法识别的图片格式，视觉桥只接受 PNG/JPEG/WebP/GIF');
    return { mediaType, base64: Buffer.from(entry.data).toString('base64') };
  });
  if (images.length === 0) throw new Error('视觉桥没有收到任何图片');
  const shared = { baseURL: profile.baseURL, apiKey, model, prompt, images, maxTokens, signal };
  const text = profile.api === 'anthropic-messages'
    ? await callAnthropicMessages(shared)
    : await callOpenAICompletions(shared);
  return text.trim();
}

/**
 * 把一段图片字节提交给附件服务，换回持久化引用。
 *
 * 走 `ctx.llm.stream` 的已注册 route 只接受持久化附件引用（不是裸字节），
 * 所以那条路径必须先把图片存进去。
 *
 * @param attachments - 附件服务。
 * @param data - 图片字节。
 * @param mediaType - 图片媒体类型，缺省时按魔数嗅探。
 * @returns 持久化图片引用。
 */
export async function saveImage(attachments, data, mediaType) {
  const resolved = mediaType ?? sniffImageMediaType(data);
  if (resolved === undefined) throw new Error('无法识别的图片格式，视觉桥只接受 PNG/JPEG/WebP/GIF');
  if (!attachments.imageLimits.mediaTypes.includes(resolved)) {
    throw new Error(`附件服务不接受 ${resolved} 格式的图片`);
  }
  return attachments.saveImage({ data, mediaType: resolved });
}

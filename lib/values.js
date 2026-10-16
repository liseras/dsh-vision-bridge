/**
 * 读取配置字段的兼容层。
 *
 * 带 `.volatile()` 标记的字段在 cordis 里不是普通值，而是一个带 `.get()` 的
 * 包装对象（这是"可在不重新挂载的情况下热更新"的实现方式）。上游 llm-pi-ai
 * 因此写成 `config.providers.get()`。
 *
 * 但同一个 config 在别的时机又是普通对象——例如 `internal/config` 钩子里
 * 传入的原始值。这里统一两种形态，调用方不必关心自己拿到的是哪一路。
 *
 * @param config - 插件配置对象。
 * @param key - 字段名。
 * @param fallback - 字段缺失或为 null 时的返回值。
 * @returns 字段的当前值。
 */
export function readConfig(config, key, fallback) {
  const raw = config?.[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw.get === 'function') {
    const value = raw.get();
    return value === undefined || value === null ? fallback : value;
  }
  return raw;
}

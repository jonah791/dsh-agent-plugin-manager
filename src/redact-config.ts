/**
 * redact-config.ts — 插件配置的**凭据脱敏**（纯逻辑，可离线单测）
 *
 * 事故（2026-09-17 实测）：`plugin_inspect(dsh-agent-guardian)` 把插件 config **原样**渲染，
 * 于是主人的 Telegram bot token 与 chat id 当场进了工具输出 ⇒ 进我的上下文 ⇒ 进会话日志。
 * 工具面**不得**把凭据拉进会话——哪怕只是为了"看看配置"。
 *
 * 判据纪律：
 *  - 按**键名**（结构信号）判定，不猜值形态（值形态千变万化，键名是插件的自述）；
 *  - 脱敏后**连长度与前缀都不泄漏**（只留 '[redacted]'），否则等于半个泄漏；
 *  - 非密字段（port/dshHome/profile…）原样保留——配置仍是可读的，不因噎废食。
 */
export const REDACTED = '[redacted]'

/** 键名信号：命中即脱敏。覆盖我生态里实际出现过的形态（token/chatId/webhook/api key/口令/私钥/助记词）。 */
const SECRET_KEY = /(token|secret|password|passwd|pwd|api[-_]?key|apikey|credential|private[-_]?key|webhook|chat[-_]?id|signature|mnemonic|seed|auth)/i

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 递归脱敏；返回**新对象**（不改入参）。 */
export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactConfig(v))
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? REDACTED : redactConfig(v)
    }
    return out
  }
  return value
}

/** 被脱敏的键路径清单（审计/留痕用；不含值）。 */
export function redactedPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => redactedPaths(v, `${prefix}[${i}]`))
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([k, v]) => {
      const path = prefix ? `${prefix}.${k}` : k
      return SECRET_KEY.test(k) ? [path] : redactedPaths(v, path)
    })
  }
  return []
}

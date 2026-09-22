/**
 * ops-logic.ts — 插件管理器的**纯逻辑层**（无 IO、无 Date.now、无 ctx；时间/列表/路径全部注入）。
 *
 * 为什么抽出来（2026-09-14 插件可维护性补课 · 技能 `dsh-plugin-testability`）：
 * plugin-manager 的全部判据都埋在 `apply()`/`createOps()` 的闭包里——校验插件名、
 * 挑「最新活跃主会话」、判「有没有未验证的新构建」、列表分组排序、档案投影、脚手架模板。
 * 这些判据的共同点是：**错了不报错**。挑错会话 → 唤醒发给子代理（§5.18 事故形态）；
 * 构建时效判错 → 组合变更被短路（§5.11 事故形态）；分组排序错了 → 面板顺序乱但「能用」。
 *
 * 抽取纪律：判据逐字照搬（含 `> webStartMs + 1000` 的单向容差、`delegationDepth === 0` 过滤、
 * 分组 `order ?? 99` 排序、档案字段白名单），只把 `process.uptime()/ctx.sessions` 换成显式参数。
 */
import type { PluginArchive } from './registry.ts'

/** 构建时效容差（ms）：mtime 必须**晚于** web 启动 1s 以上才算「未验证的新构建」（原判据）。 */
export const BUILD_SKEW_MS = 1000

/** 插件名校验：小写字母开头，仅 [a-z0-9-]（`plugin_create` 的第一道判据）。 */
export const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/

/** 插件名是否合法（不合法即拒绝创建，不落盘）。 */
export function isValidPluginName(name: string): boolean {
  return PLUGIN_NAME_RE.test(name)
}

/**
 * 本次进程是否有「刚构建、尚未被当前实例加载验证」的插件产物。
 *
 * 语义（AGENTS.md §5.11 §1）：改代码后重启 = 组合变更，不能拿旧实例健康当免检。
 * 判据 = 任一 `lib/index.js` 的 mtime **严格晚于** `webStartMs + BUILD_SKEW_MS`。
 * 无候选（空数组）= 无未验证构建 = `false`；**调用方在扫描失败时另行保守返回 true**（宁严勿漏）。
 */
export function anyBuildNewerThan(
  builds: readonly { name: string; mtimeMs: number }[],
  webStartMs: number,
  skewMs: number = BUILD_SKEW_MS,
): boolean {
  for (const b of builds) {
    if (b.mtimeMs > webStartMs + skewMs) return true
  }
  return false
}

/** 会话列表项（duck-typing，不 import 宿主 SessionId branded 类型）。 */
export type SessionListItem = {
  id: string
  header?: { delegationDepth?: number }
  events?: readonly { time?: number }[]
}

/**
 * 目标会话解析（原 `resolveActiveSessionId`）：
 *   ① 显式配置的 mainSessionId 优先（锁定行为，兼容旧配置）
 *   ② 否则取 **delegationDepth === 0**（主会话，排除子代理裸 uuid）中最后事件 time 最大者
 *   ③ 平手保留**先出现的**（严格 `>` 才替换——顺序敏感，别改成 `>=`）
 * 无候选 → `null`（调用方走兜底/跳过，不抛）。
 */
export function pickActiveSessionId(sessions: Iterable<SessionListItem>, mainSessionId: string): string | null {
  if (mainSessionId) return mainSessionId
  let best: { id: string; time: number } | null = null
  for (const s of sessions) {
    if ((s.header?.delegationDepth ?? 0) !== 0) continue
    // 2026-09-05 防御：DSH 升级后部分 session 的 events 可能缺失（undefined）——不能直接 .length
    const events = s.events ?? []
    const lastTime = events.length > 0 ? (events[events.length - 1]?.time ?? 0) : 0
    if (best === null || lastTime > best.time) best = { id: s.id, time: lastTime }
  }
  return best?.id ?? null
}

/** 默认「在飞」窗口：10 分钟。取值理由见 `findInFlightSubagents` 的边界说明。 */
export const DEFAULT_INFLIGHT_WINDOW_MS = 10 * 60_000

/** 一个在飞分身的最小描述（只带判断与可读理由所需字段）。 */
export type InFlightSubagent = {
  id: string
  delegationDepth: number
  lastEventMs: number
  /** 距最后一次活动过去了多久（ms）。 */
  ageMs: number
}

/**
 * 「在飞分身」检测（2026-09-22 · 主人：「重启的时候会打断分身，想办法解决一下」）。
 *
 * 背景（实测）：`subagent` 工具派出的子代理与 web **同进程**。`daemon_restart` 一 kill 就把它斩断，
 * 而它**不可寻址**（`send_message` → 不是 teammate）、**不是 job**（`job_list` 为空）、
 * **无 settle 通知** ⇒ 重启即失联、整轮工作蒸发（当日实测：分身最后产出 14:57:27，我 14:57:32 重启）。
 *
 * 判据：`delegationDepth > 0`（派生会话）**且**最后事件时间在 `windowMs` 内。
 *
 * ⚠ 为什么不用「会话存在」当判据：子代理跑完仍会留在会话列表里，用「存在」判 ⇒ **永远拒绝重启**，
 * 等于把一个可恢复的小麻烦（打断一次）换成一个不可自愈的大麻烦（再也重启不了）。**宁可漏报，不可误锁。**
 *
 * 边界（诚实）：
 *  · 这是**启发式**——长 turn 期间工具事件会推进时间，但「思考很久不调工具」的分身可能被误判为已结束；
 *    窗口给到 10 分钟以降低误判率。
 *  · 取不到 events / 取不到 time 的会话按 **不在飞** 处理（同样服从「宁可漏报」）。
 *  · 时间戳在未来（负 age，时钟偏移）⇒ 按**在飞**处理（安全方向：不确定时倾向于保护）。
 *  · 与 `pickActiveSessionId` 同约定：取 events **最后一项**的 time（不是最大值）——两处口径必须一致。
 */
export function findInFlightSubagents(
  sessions: Iterable<SessionListItem>,
  nowMs: number,
  windowMs: number = DEFAULT_INFLIGHT_WINDOW_MS,
): InFlightSubagent[] {
  const out: InFlightSubagent[] = []
  for (const s of sessions) {
    // 输入不可信（会话对象来自宿主，字段形状会随版本漂移）：
    // 深度必须是**有限数字**——`'1' <= 0` 在 JS 里会被强转成 `1 <= 0`（false），
    // 字符串深度能混进来；`NaN <= 0` 同样是 false。两者都必须显式挡掉。
    const depth = s.header?.delegationDepth
    if (typeof depth !== 'number' || !Number.isFinite(depth) || depth <= 0) continue
    // 比 pickActiveSessionId 更严：这里显式要求 events 是数组、time 是有限正数
    // （那边沿用旧口径不改，避免动到已测行为的语义）。
    const events = s.events
    if (!Array.isArray(events) || events.length === 0) continue
    const rawTime = (events[events.length - 1] as { time?: unknown } | null | undefined)?.time
    if (typeof rawTime !== 'number' || !Number.isFinite(rawTime) || rawTime <= 0) continue
    const age = nowMs - rawTime
    if (age > windowMs) continue
    out.push({ id: s.id, delegationDepth: depth, lastEventMs: rawTime, ageMs: age })
  }
  return out
}

/** 把在飞清单压成一行可读理由（进拒绝消息与事件日志）。空清单 → 空串。 */
export function describeInFlight(list: readonly InFlightSubagent[]): string {
  if (list.length === 0) return ''
  const parts = list.map(
    (x) => x.id + '（深度 ' + String(x.delegationDepth) + ' · 最后活动 ' + String(Math.max(0, Math.round(x.ageMs / 1000))) + 's 前）',
  )
  return String(list.length) + ' 个分身正在跑：' + parts.join(' · ')
}

/** loader 条目（cordis loader 的鸭子类型）。 */
export type LoaderEntryLike = { options?: { name?: string }; disabled?: boolean }

/**
 * loader 快照（原 `loaderSnapshot`）：
 * **loader 是挂载状态的权威**（不吃陈旧 system-state 静态快照）；无名条目丢弃，
 * `disabled === true` 才算停用（其他值/缺失一律视为启用——保守按「在跑」呈现）。
 */
export function loaderSnapshotOf(entries: Iterable<LoaderEntryLike>): { name: string; enabled: boolean }[] {
  const out: { name: string; enabled: boolean }[] = []
  for (const entry of entries) {
    const n = entry.options?.name
    if (typeof n === 'string' && n) out.push({ name: n, enabled: entry.disabled !== true })
  }
  return out
}

import { redactConfig } from './redact-config.ts'

/** 档案投影（原 `publicArchive`）：字段白名单 + JSON 深拷贝（剥离函数/undefined，工具面安全）。
 *  ⚠ **config 必须脱敏**（2026-09-17 事故）：原先原样投影 ⇒ 守护插件的 telegram bot token 与 chat id
 *  被渲染进工具输出 ⇒ 进上下文 ⇒ 进会话日志。工具面不得把凭据拉进会话。 */
export function publicArchive(a: PluginArchive) {
  return JSON.parse(JSON.stringify({
    name: a.name, version: a.version, source: a.source,
    purpose: a.purpose, category: a.category, client: a.client,
    tools: a.tools, built: a.built,
    status: a.status, profiles: a.profiles,
    config: redactConfig(a.config),
    // 第三方档专有（§5.23）：bundle = 自述式挂载；spec = 依赖声明（含 pin，落盘前已脱敏）
    // 注：不投影 `path`（本地绝对路径不属工具面白名单）
    ...(a.bundle === undefined ? {} : { bundle: a.bundle }),
    ...(a.spec === undefined ? {} : { spec: a.spec }),
  }))
}

/** 列表过滤（`plugin_list` 的 source/status 过滤）：空条件 = 不过滤。 */
export function filterArchives<T extends { source: string; status: string }>(
  plugins: T[],
  filter: { source?: string; status?: string },
): T[] {
  let out = plugins
  if (filter.source) out = out.filter((p) => p.source === filter.source)
  if (filter.status) out = out.filter((p) => p.status === filter.status)
  return out
}

/** 分组元数据（标题 + 排序权重；未知来源归 third-party）。 */
export const GROUP_META: Record<string, { title: string; order: number }> = {
  self: { title: '▸ 自研', order: 0 },
  official: { title: '▸ 官方', order: 1 },
  'third-party': { title: '▸ 非官方（第三方）', order: 2 },
}

/**
 * 按来源分组并排序（原 render 的分组段）：
 * 未知 source 归入 `third-party`；组间按 `order` 升序（未知键 order=99 垫底）；组内保持入参顺序。
 */
export function groupOrderedPlugins<T extends { source: string }>(
  plugins: T[],
): { key: string; title: string; order: number; items: T[] }[] {
  const groups = new Map<string, T[]>()
  for (const p of plugins) {
    const key = p.source in GROUP_META ? p.source : 'third-party'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(p)
  }
  return [...groups.entries()]
    .sort((a, b) => (GROUP_META[a[0]]?.order ?? 99) - (GROUP_META[b[0]]?.order ?? 99))
    .map(([key, items]) => ({ key, title: GROUP_META[key]?.title ?? key, order: GROUP_META[key]?.order ?? 99, items }))
}

/** 档案行（一个插件一行，含「未构建」标记 / 工具 / 挂载；第三方档额外标 bundle 与 pin，§5.23）。 */
export function pluginListLines(plugins: Array<{
  source: string; name: string; version: string; status: string; built: boolean; purpose: string; tools: string[]; profiles: string[]
  bundle?: boolean; spec?: string
}>): string[] {
  const lines: string[] = []
  for (const g of groupOrderedPlugins(plugins)) {
    lines.push(g.title + '（' + g.items.length + '）')
    for (const p of g.items) {
      lines.push('  • ' + p.name + ' ' + p.version + ' [' + p.status + ']' + (p.built ? '' : ' 未构建') + (p.purpose ? ' — ' + p.purpose : '') + (p.tools.length ? '\n      工具: ' + p.tools.join(', ') : '') + (p.profiles.length ? '\n      挂载: ' + p.profiles.join(', ') : '') + (p.bundle === undefined ? '' : '\n      bundle: ' + String(p.bundle)) + (p.spec === undefined ? '' : '\n      来源: ' + p.spec))
    }
  }
  return lines
}

/** `plugin_create` 的脚手架源码模板（原 `scaffoldSource`，逐字搬移）。 */
export function scaffoldSource(name: string, description: string): string {
  const id = 'agent-' + name.replace(/^dsh-/, '')
  return [
    '/** ' + name + '：' + (description || '（待填写用途）') + ' */',
    'import type { Context } from "@deepseek-ai/cordis"',
    'import z from "@deepseek-ai/schemastery"',
    'export const name = ' + JSON.stringify(id) + '',
    'export const inject = [] as const',
    'export interface Config { enabled: boolean }',
    'export const Config = z.object({ enabled: z.boolean().default(true) })',
    'export function apply(ctx: Context, config: Config): void {',
    '  // TODO: 在此实现插件逻辑',
    '  ctx.on("ready", () => { ctx.logger(' + JSON.stringify(name) + ').info("ready") })',
    '}',
  ].join('\n') + '\n'
}

/** 生命周期动作（第三方拒绝文案按动作给不同动词）。 */
export type LifecycleAction = 'mount' | 'unmount' | 'start' | 'stop' | 'configure'

const ACTION_VERB: Record<LifecycleAction, string> = {
  mount: '挂载', unmount: '卸载', start: '启动', stop: '停用', configure: '配置',
}

/**
 * 第三方插件的生命周期拒绝文案（§5.23）。
 *
 * 判据：本工具的生命周期原语（写 `link:` 依赖 + 插 patch 行）**只对自研插件成立**；
 * 第三方是 profile 依赖（registry 版本号 / git pin / tarball / `file:`），挂载由包自带的
 * `dsh.bundle.patch` 自述完成（列进 profile 的 `dsh.profile.bundles`）。
 * 用自研路径操作它会写出错误的依赖形态与多余 patch 行——**必须显式拒绝并指路**，而不是让它
 * 走到「插件不存在 / 未挂载」这类不达意的分支。
 *
 * 纯函数（文案可离线断言）。
 */
export function thirdPartyRefusal(
  action: LifecycleAction,
  name: string,
  spec: string,
  profile: string,
  bundle: boolean,
): string {
  return [
    '拒绝：' + name + ' 是**第三方插件**，不走本工具的生命周期（' + ACTION_VERB[action] + '）。',
    '  依据：AGENTS §5.23——自研（self-plugins + patch 行）与第三方（profile 依赖 + bundle）是两条不可混用的管理路。',
    '  来源: ' + spec + (bundle ? '（bundle 形态：包自带 dsh.bundle.patch，挂载由 profile 的 dsh.profile.bundles 自述完成）' : ''),
    '  升级/回退: 改 ' + profile + ' 的 package.json 里该依赖的 pin → pnpm install → 重启；或用官方 CLI：dsh plugin --profile ' + profile + ' add <url>#<tag>',
    '  卸载: dsh plugin --profile ' + profile + ' remove ' + name + '（一并处理依赖与 bundles）',
    '  本工具只管理自研插件（self-plugins/*）；第三方盘点用 plugin_list（source=third-party）与 plugin_boot_status（thirdParty）。',
  ].join('\n')
}

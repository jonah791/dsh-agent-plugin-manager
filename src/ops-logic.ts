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

// ── 会话目录来源（2026-09-22 实证修正 · 上面那条内存判据实测无效）────────────
//
// 真机日志原文：「在飞分身检查：候选会话 2 · 命中 0（放行）」——而此刻**确有一个分身正在跑**
// （它的会话目录 mtime 正是它在写入的时刻）。⇒ **内存里的会话表不含在飞的子代理**；
// 文件系统才是真源：`<DSH_HOME>/sessions/<工作区组>/<会话id>/`。
//
// 怎么把「子代理会话」与「人类/并行实例的会话」分开？——用**本仓既有的 id 约定**：
//   子代理   = **裸 uuid**（无 `session-` 前缀；见 `pickActiveSessionId` 的测例 `5bb40b68-bare-uuid`）
//   用户会话 = `session-<uuid>`
// 据此过滤既精确（不把并行实例的会话误判成分身），又不依赖任何内存 API。

const BARE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 会话目录项（IO 层查得后**显式传入**：纯逻辑不碰文件系统）。 */
export type SessionDirEntry = { name: string; mtimeMs: number }

/** 一个在飞分身会话（只要 id 与静默时长——拒绝消息要的就是这个）。 */
export type InFlightSession = { id: string; ageMs: number }

/**
 * 从**会话目录列表**里挑出在飞的分身会话（纯函数，IO 由调用方注入）。
 *
 * 判据：名字是**裸 uuid**（子代理约定）且目录 mtime 在 `windowMs` 内。
 * 为什么用 mtime：目录 mtime 在每次追加事件时刷新 ⇒ 「还在写」≈「还在跑」；
 * 跑完的分身不再写 ⇒ 自然滑出窗口，**不需要任何清理逻辑**（无状态，最不容易坏）。
 *
 * 边界：① 名字带 `session-` 前缀的一律不算（那是用户/并行实例的会话）；
 * ② mtime 缺失/非法 ⇒ 跳过（宁可漏报）；**未来值 ⇒ 按在飞处理**（时钟偏移时倾向保护）。
 */
export function findInFlightSessionDirs(
  dirs: Iterable<SessionDirEntry>,
  nowMs: number,
  windowMs: number,
): InFlightSession[] {
  const out: InFlightSession[] = []
  for (const d of dirs) {
    if (d === null || typeof d !== 'object') continue
    if (typeof d.name !== 'string' || !BARE_UUID_RE.test(d.name)) continue
    const m = d.mtimeMs
    if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0) continue
    const age = nowMs - m
    if (age > windowMs) continue
    out.push({ id: d.name, ageMs: age })
  }
  return out
}

/** 在飞分身会话的一行可读描述（空清单 → 空串）。 */
export function describeInFlightSessions(list: readonly InFlightSession[]): string {
  if (list.length === 0) return ''
  const parts = list.map((x) => x.id + '（最后写入 ' + String(Math.max(0, Math.round(x.ageMs / 1000))) + 's 前）')
  return String(list.length) + ' 个分身会话仍在写入：' + parts.join(' · ')
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

/**
 * 插件行 id：包名去 `dsh-` 前缀；**已含 `agent-` 者不再叠加**。
 *
 * 2026-09-26 修双前缀缺陷：原式 `'agent-' + name.replace(/^dsh-/, '')` 对
 * **目录名本身已含 `agent-`** 的自研插件（全部 `dsh-agent-*`）产出 `agent-agent-*`
 * （已见四例：dsh-agent-vision / repair / skill-lifecycle …）。
 *
 * **存量无需迁移**：patch 行查找是双认的（`r.id === nm || r.name === nm`，
 * 见 index.ts:199 与 registry.ts 各处），卸载又走「已找到的 row.id」，
 * 故 id 改名后旧行仍可被 name 命中并正常卸载。
 * @param name - 插件目录名或包名（`dsh-…`）。
 * @returns 该插件在 profile patch 中的行 id。
 */
export function pluginRowId(name: string): string {
  const base = name.replace(/^dsh-/, '')
  return base.startsWith('agent-') ? base : 'agent-' + base
}

/**
 * 脚手架模板的 `pnpm-workspace.yaml`（**单一真源**：`create()` 与测试共用）。
 *
 * 为什么必须有（本机约定 2026-09-26 立）：pnpm 默认 `autoInstallPeers: true`，会把
 * `peerDependencies` 从 registry 拉回**真实副本**落到 `node_modules/@deepseek-ai`，
 * **遮蔽宿主链接层** ⇒ 同一插件内新旧版本混搭（实测物证：某插件的
 * `node_modules/@deepseek-ai.BAK-20260926-081113` 就是遮蔽后手工改名的残留）。
 * ⚠ 不要用 `.npmrc`——pnpm 11.7.0 已不再从那里读该设置（两种写法实测均无效）。
 *
 * ⚠ 这是「**模板是缺口复制器**」的又一实例（与 `SCAFFOLD_PEER_DEPS` 同形状，t-cc516d56）：
 * 既有多个插件都有这份文件，但骨架不生成 ⇒ 每个新插件都要手动补。
 */
export const SCAFFOLD_PNPM_WORKSPACE: string = [
  '# 本机约定（2026-09-26 立）：禁止把 peerDependencies 装成真实副本。',
  '#',
  '# 背景：pnpm 默认 autoInstallPeers=true，会把 peerDependencies 从 registry 拉回真实副本',
  '# 落到 node_modules/@deepseek-ai，**遮蔽宿主链接层** ⇒ 同一插件内新旧版本混搭。',
  '#',
  '# ⚠️ 不要用 .npmrc —— pnpm 11.7.0 已不再从 .npmrc 读取该设置',
  '#    （auto-install-peers 与 autoInstallPeers 两种写法实测均无效）。',
  '#    必须在 pnpm-workspace.yaml 里用 camelCase 的 autoInstallPeers。',
  'autoInstallPeers: false',
  '',
].join('\n')

/**
 * 校验脚手架产出的 `pnpm-workspace.yaml` 是否真能防住遮蔽（纯函数：喂内容给判据）。
 * @param content - 文件内容。
 * @returns 问题行；空数组 = 通过。
 */
export function workspaceFileIssues(content: string): string[] {
  const issues: string[] = []
  if (!/^autoInstallPeers:\s*false\s*$/m.test(content)) {
    issues.push('未声明 `autoInstallPeers: false` ⇒ pnpm 会把 peer 装成真实副本，遮蔽宿主链接层')
  }
  return issues
}

/**
 * 脚手架模板的 peer 依赖（**单一真源**：`create()` 与测试共用；改这里即改所有未来产物）。
 *
 * ⚠ `@deepseek-ai/dsh-tools` 必须是 `>=` 而**不是** `^`（2026-10-15 实测 · 台账 lh-ff4ea783）：
 * `^0.1.0-rc.6` 在 semver 里 = `>=0.1.0-rc.6 <0.2.0`，而宿主的兼容门
 * （`deepseek-harness/packages/boot/app-boot/src/plugin-compatibility.ts:77`）用
 * `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 比对——运行时升到
 * `0.2.1-alpha.2` 后该比较失败，宿主**静默** disable 该插件行（挂载返回成功、patch 行也在，
 * 但一行不生效；只有 `err` 级日志，不进模型视野）。实测 64 个既有插件全用 `>=`，
 * 只有本骨架产物用 `^` ⇒ 模板缺陷，不是使用者的选择错。
 */
export const SCAFFOLD_PEER_DEPS: Readonly<Record<string, string>> = {
  '@deepseek-ai/cordis': '^4.0.1',
  '@deepseek-ai/schemastery': '^3.18.1-rc.1',
  '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6',
}

/**
 * 宿主兼容门是否检查该 peer 名（`plugin-compatibility.ts:75`）：只有 `@deepseek-ai/dsh`
 * 与 `@deepseek-ai/dsh-*` 会被比对——cordis / schemastery 不在其列。判据域必须与它一致，
 * 否则会对门根本不检查的项误报。
 */
export function isDshPeerChecked(name: string): boolean {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

/** 解析后的版本（显式三字段——`noUncheckedIndexedAccess` 下元组索引访问是 `T | undefined`）。 */
type ParsedVersion = { major: number; minor: number; patch: number; pre: string[] }

/** 解析 `x.y.z[-pre]`；不可解析（含通配符/区间符）⇒ `null`。 */
function parseVersion(raw: string): ParsedVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] }
}

/**
 * semver §11 比较：`a < b` ⇒ 负数。无 prerelease 者更大；同为 prerelease 时逐段比
 * （数字段比数值，字母段比字典序，数字段 < 字母段）。
 */
function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const n = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < n; i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1
    if (xn) return -1
    if (yn) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * caret 上界（semver §7）：`^1.2.3` ⇒ `2.0.0`；`^0.2.3` ⇒ `0.3.0`；`^0.0.3` ⇒ `0.0.4`。
 * 上界带 `-0`（与 node-semver 的 `^0.1.0-rc.6` ⇒ `<0.2.0-0` 对齐）。
 */
function caretUpper(v: ParsedVersion): ParsedVersion {
  if (v.major > 0) return { major: v.major + 1, minor: 0, patch: 0, pre: ['0'] }
  if (v.minor > 0) return { major: 0, minor: v.minor + 1, patch: 0, pre: ['0'] }
  return { major: 0, minor: 0, patch: v.patch + 1, pre: ['0'] }
}

/**
 * 近似宿主兼容门的满足性判断——覆盖模板实际会用到的三种形态（`>=X` / `^X` / 精确 `X`），
 * 与宿主判据同语义（`includePrerelease: true`：prerelease 参与常规比较）。
 *
 * ⚠ **不是完整 semver 实现**：`~`、`*`、`||`、复合区间一律返回 `null` = **超出判据域**。
 * 调用方必须把 `null` 报成「未判定」，**不得**当通过（§5.9 规则 2：恒为空的输出不是证据）。
 * 域内的正确性由测试用宿主侧真实 semver 库标定（tests/scaffold-peer.test.mjs）。
 * @param range - peer 范围串。
 * @param version - 宿主运行时版本。
 * @returns 满足性；`null` = 形态超出本判据的域或版本不可解析。
 */
export function satisfiesRange(range: string, version: string): boolean | null {
  const v = parseVersion(version)
  if (!v) return null
  const raw = range.trim()
  if (raw === '' || raw === '*' || raw === 'latest') return null

  if (raw.startsWith('>=')) {
    const lo = parseVersion(raw.slice(2))
    if (!lo) return null
    return compareVersions(v, lo) >= 0
  }
  if (raw.startsWith('^')) {
    const base = parseVersion(raw.slice(1))
    if (!base) return null
    return compareVersions(v, base) >= 0 && compareVersions(v, caretUpper(base)) < 0
  }
  if (/^\d/.test(raw)) {
    const exact = parseVersion(raw)
    if (!exact) return null
    return compareVersions(v, exact) === 0
  }
  return null
}

/**
 * 脚手架 peer 范围对宿主运行时版本的对账（**纯函数**，版本由调用方注入）。
 *
 * 三类结果互不掩盖：不满足（❌）/ 未判定（⚠️：形态超域或版本读不到）/ 通过（不输出）。
 * @param deps - peer 依赖表（通常是 `SCAFFOLD_PEER_DEPS`）。
 * @param runtimeVersion - 宿主运行时版本；`null` = 读不到（⇒ 全部未判定，**不静默通过**）。
 * @returns 问题行；空数组 = 全部通过。
 */
export function peerSatisfactionIssues(
  deps: Readonly<Record<string, string>>,
  runtimeVersion: string | null,
): string[] {
  const issues: string[] = []
  for (const [name, range] of Object.entries(deps)) {
    if (!isDshPeerChecked(name)) continue
    if (runtimeVersion === null) {
      issues.push('未判定: ' + name + ' ' + range + '（宿主运行时版本读不到）')
      continue
    }
    const ok = satisfiesRange(range, runtimeVersion)
    if (ok === null) {
      issues.push('未判定: ' + name + ' ' + range + '（形态超出本判据的域，需人工核对）')
    } else if (!ok) {
      issues.push('不满足: ' + name + ' ' + range + ' 与宿主 ' + runtimeVersion
        + ' 不兼容——宿主会**静默** disable 该插件行（挂载成功但一行不生效）')
    }
  }
  return issues
}

/** `plugin_create` 的脚手架源码模板（原 `scaffoldSource`，逐字搬移）。 */
export function scaffoldSource(name: string, description: string): string {
  const id = pluginRowId(name)
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
    '  // ⚠ cordis 4 **没有 `ready` 事件**：旧骨架曾用 ctx.on("ready", …)，导致新插件**开箱即编译失败**',
    '  //   （TS2345: Argument of type \'"ready"\' is not assignable to parameter of type \'keyof Events\'）。',
    '  //   2026-10-06 移除（t-83cd062f）。可选事件见其它插件样本，如 agent/pre-step、session/event。',
    '  //   空 apply 本身即可通过类型检查 ⇒ 此处留空待实现。',
    '  void ctx',
    '  void config',
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

/**
 * 语义注册表里是否存在该 id（**精确命中**，不数正文提及）。
 *
 * 判据放纯层：输入是**已读到的** registry JSON 文本，输出 bool。
 * 解析失败 / 结构不符 / id 非字符串 ⇒ `false`（**不得抛**——调用点在退役流程上，抛会中断退役）。
 */
export function registryHasIdFromText(registryText: string, id: string): boolean {
  try {
    const d = JSON.parse(registryText) as { entries?: unknown }
    if (!Array.isArray(d.entries)) return false
    return d.entries.some(e =>
      e !== null && typeof e === 'object' && (e as { id?: unknown }).id === id)
  } catch {
    return false
  }
}

/**
 * purge 影响面的可读渲染 —— 工具 render 与离线测试**共用同一份文案**，
 * 避免「测试断言的文案」与「线上显示的文案」漂移（§5.22 判据单一真源）。
 */
export function purgeReportLines(v: {
  ok: boolean
  dryRun: boolean
  name: string
  profile: string
  error?: string
  dirExists: boolean
  dirBytes: number
  archivedTo?: string
  gitlinkMode?: string
  semanticPresent: boolean
  referenceCount: number
  traceWritten: boolean
}): string[] {
  if (v.ok !== true) return ['彻底退役失败：' + (v.error && v.error !== '' ? v.error : '(无原因)')]
  // 口径：dirBytes 是「文件 st.size 累加」，**含硬链接重复计入**——pnpm 的 node_modules 大量用硬链接，
  // 实测比 `du` 的磁盘占用大约一倍（2026-10-03 purge dsh-agent-thinking：本函数报 52.6 MB，
  // `du -sh` 为 26 MB）。⇒ 报体积必须带口径，故文案里显式标注（「读数必须自带范围标注」§5.9 规则 6）。
  const mb = (v.dirBytes / 1048576).toFixed(1)
  const lines = [
    (v.dryRun ? '【干跑】' : '【已执行】') + '彻底退役 ' + v.name + '@' + v.profile,
    '· 插件目录：' + (v.dirExists ? '在（' + mb + ' MB · 文件大小累加口径，硬链接重复计入）' : '不存在')
      + (v.archivedTo === undefined || v.archivedTo === '' ? '' : ' → 已归档 ' + v.archivedTo),
    '· gitlink：' + (v.gitlinkMode === undefined || v.gitlinkMode === ''
      ? '无' : v.gitlinkMode + '（需人工 git rm --cached）'),
    '· 语义注册表条目：' + (v.semanticPresent ? '仍在 ⇒ 需 dsh-semantic-docs 注销' : '不存在'),
    '· 待改引用：' + v.referenceCount + ' 处（未改动）',
  ]
  lines.push(v.dryRun
    ? '· 干跑：零改动；加 apply=true 执行'
    : '· 留痕：' + (v.traceWritten ? '已写入 plugin-purge-trace.jsonl' : '写入失败（见日志）'))
  return lines
}

/**
 * 工具发现（`tool_find` 的纯决策层）：从「插件 → 工具」档案里按关键词找工具。
 *
 * 存在理由（2026-10-15 实测痛点）：工具面已 **424 个**，是一张**平铺清单**。
 * 当日我为了查「灵魂字节预算」这个读数，明明有 `rewrite_status` 一条命令就报，
 * 却在 grep 与读源码里绕了一圈——**能力在，但找不到**。这正是 ANIS 论文
 * （arXiv:2610.15765v1）的 Discoverability 属性：agent 花 **24.1–36.2%** input token
 * 在 discovery 上，且论文实测「**投放文档没用**」（*shipping documentation does not help*）。
 *
 * 设计：**零手写映射**——匹配面只用档案里已有的真源（插件名 / 用途 / 工具名），
 * 不维护第二份「意图 → 域」对照表（平行真源必然漂移，§5.22 判据单一真源）。
 */

export interface ToolFindHit {
  plugin: string
  version: string
  source: string
  purpose: string
  tools: string[]
  /** 命中的工具（query 命中工具名时非空；仅插件名/用途命中时为空数组）。 */
  matchedTools: string[]
  /** 排序分：工具名精确命中 3 · 工具名子串 2 · 插件名/用途命中 1。 */
  score: number
}

/** 大小写不敏感子串匹配（needle 为空 ⇒ 恒真，用于概览）。 */
function hit(haystack: string, needle: string): boolean {
  if (needle === '') return true
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

/** 按关键词筛插件（无命中 ⇒ 空数组，**不回落成全部**）。 */
export function findPluginsByToolQuery(
  plugins: Array<{ name: string; version: string; source: string; purpose: string; tools: string[] }>,
  query: string,
): ToolFindHit[] {
  const q = query.trim()
  const out: ToolFindHit[] = []
  for (const p of plugins) {
    // 空 query = 概览：**不算工具级命中**——否则 `hit()` 恒真会让每域都拿 score=2，
    // 概览与「工具级命中」就分不开了（2026-10-15 由 tests/ops-logic.test.mjs 的空 query 用例抓出）。
    const matchedTools = q === '' ? [] : p.tools.filter((t) => hit(t, q))
    const exactTool = q !== '' && p.tools.some((t) => t.toLowerCase() === q.toLowerCase())
    const nameOrPurpose = hit(p.name, q) || hit(p.purpose, q)
    if (matchedTools.length === 0 && !nameOrPurpose) continue
    const score = exactTool ? 3 : (matchedTools.length > 0 ? 2 : 1)
    out.push({
      plugin: p.name, version: p.version, source: p.source, purpose: p.purpose,
      tools: p.tools, matchedTools, score,
    })
  }
  return out.sort((a, b) => (b.score - a.score) || a.plugin.localeCompare(b.plugin))
}

/**
 * 行格式 —— 工具 render 与离线测试**共用同一份文案**（§5.22 判据单一真源）。
 * 无 query ⇒ 只列域与工具数（概览）；有 query ⇒ 列命中工具（未命中工具名时列全部工具）。
 */
export function toolFindLines(hits: ToolFindHit[], query: string): string[] {
  const q = query.trim()
  if (hits.length === 0) {
    return q === ''
      ? ['工具发现：档案为空——没有任何插件登记工具。']
      : [`工具发现：「${q}」无命中。`,
         '⚠ 这是**有界搜索**：只说明档案里没有含该词的插件名/用途/工具名，**不等于该能力不存在**',
         '   （可能是档案未登记，或它在一个未挂载的插件里）。换更短或更常见的词再试。']
  }
  const totalTools = hits.reduce((n, h) => n + h.tools.length, 0)
  const head = q === ''
    ? `工具发现：${hits.length} 个域 · ${totalTools} 个工具（无 query ⇒ 全域概览，不展开工具名）`
    : `工具发现：「${q}」命中 ${hits.length} 个域 · 共 ${totalTools} 个工具`
  const lines = [head, '']
  for (const h of hits) {
    lines.push(`${h.plugin} ${h.version} [${h.source}] — ${h.purpose || '(无用途描述)'}`)
    if (q === '') {
      lines.push(`    工具 ${h.tools.length} 个`)
    } else {
      const list = h.matchedTools.length > 0 ? h.matchedTools : h.tools
      const tag = h.matchedTools.length > 0 ? '命中' : '该域全部'
      lines.push(`    ${tag}: ${list.join(', ')}`)
    }
  }
  return lines
}

/**
 * dsh-agent-plugin-manager：插件管理器。
 *
 * 用途（主人定调）：① 插件清单与用途认知（档案库：来源/版本/用途/工具/配置/状态）
 * ② 生命周期管理：创建（脚手架）/启停/删除/改配置——host 工具面给爱丽丝，
 * client 以「插件管理」tab 挂在官方设置页的 Plugins 页面。
 *
 * 安全：每次 profile 文件修改先备份；哨兵触发前沙盒预检（失败回滚不重启）；
 * 卸载保留插件数据目录。与 watch 守护三件套分工：guardian/sentinel/preflight 管进程，
 * 本插件管插件（2026-08-30 对齐：旧 dsh-agent-watch 已退役拆分）。
 * @module dsh-agent-plugin-manager
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync, readdirSync, renameSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-session'
import { buildRegistry, alignWithLoader, readPatch, parsePatchRows, type PluginArchive } from './registry.ts'
import { detectDrift } from './drift.ts'
import { patchInsert, patchRemove, patchSetDisabled, patchSetConfig, packageAddLinkDep, packageRemoveDep, installProfile, preflight, rollbackFile } from './profile.ts'
import { decidePreflightGate, extractCaller, callerComparison, describeCaller, type CallerInfo, type GateDecision, type PreflightRecord } from './preflight-gate.ts'
// 纯逻辑层（可离线单测，见 tests/ops-logic.test.mjs）+ 事件日志薄壳（tests/event-log.test.mjs）
import {
  anyBuildNewerThan,
  DEFAULT_INFLIGHT_WINDOW_MS,
  describeInFlight,
  describeInFlightSessions,
  filterArchives,
  findInFlightSessionDirs,
  findInFlightSubagents,
  isValidPluginName,
  loaderSnapshotOf,
  peerSatisfactionIssues,
  pickActiveSessionId,
  pluginListLines,
  pluginRowId,
  publicArchive,
  purgeReportLines,
  registryHasIdFromText,
  SCAFFOLD_PEER_DEPS,
  SCAFFOLD_PNPM_WORKSPACE,
  scaffoldSource,
  thirdPartyRefusal,
  workspaceFileIssues,
  type LifecycleAction,
  type SessionDirEntry,
  type SessionListItem,
} from './ops-logic.ts'
import { appendLineSafe, formatEventLine } from './event-log.ts'
// 第三方插件上游更新检查（§5.23 盲区补齐）：判据在纯层，网络/文件在 IO 层
import { updateLine, type UpdateVerdict } from './update-check.ts'
import { runUpdateCheck } from './update-io.ts'
// MCP 服务器专项支持：它们住在 cordis.patch.yml 的 config.args 里（不在 profile 依赖中）
import { mcpLine } from './mcp-check.ts'
import { runMcpCheck } from './mcp-io.ts'
import { writeSentinel } from './sentinel.ts'

export { publicArchive } from './ops-logic.ts'

export const name = 'agent-plugin-manager'
export const inject = ['tools', 'loader', 'sessions'] as const

export interface Config {
  dshHome: string
  selfPluginsDir: string
  profilesDir: string
  bin: string
  /** 可选：显式锁定目标会话（缺省=追踪最新活跃主会话，写入哨兵供 watch 唤醒） */
  mainSessionId: string
  defaultWorkspace: string
  registryFile: string
  installTimeoutMs: number
  /**
   * 「在飞分身」判定窗口（ms，2026-09-22 新增）：派生会话最后一次活动在这个窗口内
   * ⇒ 视为正在跑，`daemon_restart` 将被拒绝（除非传 `force: true`）。
   * 设 `0` = 关闭该门控（**不建议**：关掉后重启会静默斩断分身，且日志会写明是「按配置关闭」）。
   */
  inflightWindowMs: number
}
export const Config = z.object({
  dshHome: z.string().default(process.env.DSH_HOME || ''),
  selfPluginsDir: z.string().default(''),
  profilesDir: z.string().default(''),
  bin: z.string().default(''),
  mainSessionId: z.string().default(''),
  defaultWorkspace: z.string().default(''),
  registryFile: z.string().default(''),
  installTimeoutMs: z.number().default(600000),
  inflightWindowMs: z.number().default(DEFAULT_INFLIGHT_WINDOW_MS),
})

export type { PluginArchive } from './registry.ts'

/**
 * 组合变更检测（2026-09-05 主人反思「预检为何没拦 inject 缺失」修复）：
 * self-plugins 任一插件的 lib/index.js mtime 晚于当前 web 进程启动时间 =
 * 「刚构建、尚未被当前实例加载验证」→ preflight 必须强制完整试运行（probeExistingFirst=false），
 * 不能靠「现有实例健康」短路（现有实例跑的是旧代码，健康不代表新组合可加载）。
 * 本插件挂 web profile（进程即 web 实例）→ 用 process.uptime() 反推本进程启动时间。
 * 扫描失败/无 self-plugins → 保守返回 true（走完整试运行，宁严勿漏）。
 * 判据本体 = anyBuildNewerThan（ops-logic.ts，纯函数：mtime 与启动时刻显式传入）。
 */
function hasUnverifiedBuilds(dshHome: string): boolean {
  try {
    // 本进程即 web 实例（plugin-manager 挂 web profile）——启动时间 = now - uptime
    const webStartMs = Date.now() - process.uptime() * 1000

    // 扫 self-plugins：lib/index.js mtime > web 启动 = 未验证的新构建
    const candidates = [
      join(dshHome, '..', 'self-plugins'), // E:\alice\.dsh → E:\alice\self-plugins
      join(process.cwd(), 'self-plugins'),
      join(dshHome, 'self-plugins'),
    ]
    const seen = new Set<string>()
    const builds: Array<{ name: string; mtimeMs: number }> = []
    for (const dir of candidates) {
      const real = dir // 不 resolve 符号链接，避免重复
      if (seen.has(real) || !existsSync(dir)) continue
      seen.add(real)
      let entries: string[] = []
      try { entries = readdirSync(dir) } catch { continue }
      for (const name of entries) {
        if (name.startsWith('.')) continue
        const lib = join(dir, name, 'lib', 'index.js')
        try {
          if (existsSync(lib)) builds.push({ name, mtimeMs: statSync(lib).mtimeMs })
        } catch { /* 单插件不可读跳过 */ }
      }
    }
    return anyBuildNewerThan(builds, webStartMs)
  } catch {
    return true // 异常保守：走完整试运行
  }
}

/** 档案投影实现见 ops-logic.ts（纯函数，可离线单测）；此处经 `export { publicArchive }` 保持公共 API 不变。 */

export interface PluginManagerOps {
  list(): PluginArchive[]
  inspect(name: string): PluginArchive | null
  mount(name: string, profile: string, cfg?: Record<string, unknown>, caller?: CallerInfo | null): Promise<{ ok: boolean; error?: string; note?: string }>
  setEnabled(name: string, profile: string, enabled: boolean, caller?: CallerInfo | null): Promise<{ ok: boolean; error?: string; note?: string; bak?: string }>
  remove(name: string, profile: string, caller?: CallerInfo | null): Promise<{ ok: boolean; error?: string; note?: string }>
  /**
   * 彻底退役（purge）：`remove` 之外，把插件目录归档、并报告其余残留面。
   *
   * `remove` 只清「挂载点 + profile 依赖」两处；实测（2026-10-03，14 个历史卸载样本）
   * 退役后 13/14 仍有残留：目录 + gitlink（1）、语义注册表条目（11）、技能引用（8）。
   * 本方法是**两段式**：默认 `dryRun` 只出影响面；`apply: true` 才动手。
   *
   * 边界（明确不越界）：
   * - **目录移入归档区**（`<dshHome>/archive/plugin-purge/`），**不物理删除** ⇒ 可回退；
   * - **语义注册表条目与文档/技能引用只报告不改**——前者归 `dsh-semantic-docs`（它是 registry 的
   *   owner），后者改指哪个新名需要判断，不能自动化；
   * - **gitlink 只报告**（改主仓索引属"重"操作，给出命令由主体决定）。
   */
  purge(name: string, profile: string, opts: PurgeOptions, caller?: CallerInfo | null): Promise<PurgeResult>
  configure(name: string, profile: string, cfg: Record<string, unknown>, caller?: CallerInfo | null): Promise<{ ok: boolean; error?: string; note?: string }>
  create(name: string, description: string): { ok: boolean; error?: string; dir?: string; warning?: string }
}

/** purge 的入参。 */
export interface PurgeOptions {
  /** true = 真正执行（卸载 + 归档）；缺省/false = 只出影响面（dry-run）。 */
  apply?: boolean
}

/** purge 的影响面与结果（一次测量可判真假，见 docs/plans/deletion-capability-plan.md）。 */
export interface PurgeResult {
  ok: boolean
  /** 本次是干跑还是真执行。 */
  dryRun: boolean
  name: string
  profile: string
  error?: string
  note?: string
  /** ① 插件目录（含 node_modules）——purge 的**唯一**执行动作。 */
  dir: { exists: boolean; path: string; bytes: number; archivedTo?: string }
  /** ② 主仓 gitlink（160000）。只报告：改索引属重操作。 */
  gitlink: { mode: string | null; hint: string }
  /** ③ 语义注册表条目（id 精确命中）。只报告：registry 的 owner 是 dsh-semantic-docs。 */
  semantic: { entryId: string; present: boolean; hint: string }
  /** ④ 技能/文档引用。只报告：改指需判断。 */
  references: Array<{ where: string; hits: number }>
  /** 是否写入 `<dshHome>/plugin-purge-trace.jsonl`。 */
  traceWritten: boolean
}
// 脚手架模板实现见 ops-logic.ts（scaffoldSource，纯字符串生成，可离线单测）。

// 目标会话解析：不绑定固定会话——追踪最新活跃主会话（delegationDepth===0 且最后事件 time 最大）；
// 显式配置 mainSessionId 时仍尊重锁定（兼容旧行为，写入哨兵供 watch 唤醒）。
// 判据本体 = pickActiveSessionId（ops-logic.ts，纯函数：会话列表由调用方注入）。
function resolveActiveSessionId(ctx: Context, mainSessionId: string): string | null {
  const list = (ctx as Context & { sessions?: { list(): SessionListItem[] } }).sessions?.list() ?? []
  return pickActiveSessionId(list, mainSessionId)
}

/**
 * 扫会话目录（IO 层）：`<dshHome>/sessions/<工作区组>/<会话 id>/` → `{ name, mtimeMs }`。
 *
 * 扫**全部**工作区组：任何工作区里的子代理都活在同一个 web 进程里，重启一样会斩断它们。
 * 目录不存在 / 不可读 ⇒ 空数组（调用方按「不命中」处理并留痕，**绝不抛**——这里跑在重启决策路径上）。
 * 名字先做粗筛（`session-` 前缀或 hex 开头）以减少 stat 次数；精确判据在纯函数里。
 */
function listInflightScanDirs(dshHome: string): SessionDirEntry[] {
  const out: SessionDirEntry[] = []
  if (dshHome === '') return out
  const root = join(dshHome, 'sessions')
  let groups: string[]
  try {
    groups = readdirSync(root)
  } catch {
    return out
  }
  for (const g of groups) {
    if (!g.startsWith('--')) continue
    let names: string[]
    try {
      names = readdirSync(join(root, g))
    } catch {
      continue
    }
    for (const n of names) {
      if (!n.startsWith('session-') && !/^[0-9a-f]{8}-/i.test(n)) continue
      try {
        out.push({ name: n, mtimeMs: statSync(join(root, g, n)).mtimeMs })
      } catch { /* 扫描间隙消失 / 不可读 ⇒ 跳过该条 */ }
    }
  }
  return out
}

/** 递归求目录占用字节（IO）。失败/无权限的子树按 0 计——审计用途，不为统计精度中断退役。 */
function dirSizeBytes(dir: string): number {
  let total = 0
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    const p = join(dir, name)
    try {
      const st = statSync(p)
      if (st.isDirectory()) total += dirSizeBytes(p)
      else total += st.size
    } catch { /* 扫描间隙消失 / 不可读 ⇒ 跳过 */ }
  }
  return total
}

/** 主仓索引里该路径的 git mode（160000=gitlink；null=未纳管）。 */
function gitIndexMode(cwd: string, rel: string): string | null {
  try {
    const out = execFileSync('git', ['ls-files', '-s', rel], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const first = out.split('\n').find(l => l.trim() !== '')
    return first === undefined ? null : first.split(/\s+/)[0] ?? null
  } catch {
    return null
  }
}

/** 语义注册表里是否存在该 id（读文件 + 纯判据 `registryHasIdFromText`）。 */
function registryHasId(registryPath: string, id: string): boolean {
  try {
    return registryHasIdFromText(readFileSync(registryPath, 'utf8'), id)
  } catch {
    return false
  }
}

/** 扫「技能 / 文档」里对该插件名的引用（**只报告**：改指需判断）。 */
function scanReferences(workspace: string, name: string): Array<{ where: string; hits: number }> {
  const out: Array<{ where: string; hits: number }> = []
  const targets: Array<{ where: string; dir: string }> = []
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
  if (home !== '') targets.push({ where: '用户级技能', dir: join(home, '.agents', 'skills') })
  try {
    for (const g of readdirSync(join(workspace, 'docs'))) {
      if (g.endsWith('.md')) targets.push({ where: `docs/${g}`, dir: '' })
    }
  } catch { /* docs 不存在 ⇒ 跳过 */ }

  // 技能目录：逐技能读 SKILL.md
  const skillTarget = targets.find(t => t.where === '用户级技能')
  if (skillTarget !== undefined) {
    let hits = 0
    try {
      for (const s of readdirSync(skillTarget.dir)) {
        try {
          if (readFileSync(join(skillTarget.dir, s, 'SKILL.md'), 'utf8').includes(name)) hits += 1
        } catch { /* 无 SKILL.md ⇒ 跳过 */ }
      }
    } catch { /* 技能目录不存在 ⇒ 跳过 */ }
    if (hits > 0) out.push({ where: '用户级技能', hits })
  }
  // docs 顶层 .md
  let docHits = 0
  try {
    for (const f of readdirSync(join(workspace, 'docs'))) {
      if (!f.endsWith('.md')) continue
      try {
        if (readFileSync(join(workspace, 'docs', f), 'utf8').includes(name)) docHits += 1
      } catch { /* 忽略 */ }
    }
  } catch { /* 忽略 */ }
  if (docHits > 0) out.push({ where: 'docs/*.md', hits: docHits })
  return out
}

/** 时间戳（归档目录名用；本地可读，避免 UTC 日界混淆）。 */
function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 追加一行退役留痕。吞错返回 false（观测不反噬）。 */
function appendPurgeTrace(dshHome: string, row: Record<string, unknown>): boolean {
  try {
    mkdirSync(dshHome, { recursive: true })
    appendFileSync(join(dshHome, 'plugin-purge-trace.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

export function createOps(ctx: Context, config: Config, loader: { entries(): Iterable<{ options: { name?: string }; disabled?: boolean }> }): PluginManagerOps {
  const logger = ctx.logger('plugin-manager')
  const require = createRequire(import.meta.url)
  /**
   * 宿主运行时版本——与兼容门**同源**：宿主的 `getDshRuntimeVersion()`
   * （app-boot/src/plugin-compatibility.ts:44）读的就是 app-boot 自己的 package.json。
   * 读不到 ⇒ `null`：对账时全部报「未判定」，**不静默通过**，也不回退到别的包猜版本。
   * 吞错理由：解析失败是可预期的环境差异（不是所有 profile 都链了 app-boot），
   * 而「读不到」本身就是要报出去的事实，不该抛。
   */
  const hostRuntimeVersion = (): string | null => {
    try {
      const pkgPath = require.resolve('@deepseek-ai/dsh-app-boot/package.json')
      const v: unknown = JSON.parse(readFileSync(pkgPath, 'utf8')).version
      return typeof v === 'string' && v.trim() !== '' ? v : null
    } catch {
      return null
    }
  }
  const dshHome = config.dshHome || process.env.DSH_HOME || ''
  const selfPluginsDir = config.selfPluginsDir || join(dshHome, 'self-plugins')
  const profilesDir = config.profilesDir || join(dshHome, 'profiles')
  let bin = config.bin
  if (!bin) { try { bin = require.resolve('@deepseek-ai/dsh/lib/bin.js') } catch { bin = '' } }
  const workspace = config.defaultWorkspace || process.cwd()
  const sessionId = config.mainSessionId

  const eventLog = (msg: string) => {
    appendLineSafe(join(dshHome || process.cwd(), '.plugin-manager-events.log'), formatEventLine(new Date(), msg))
  }

  const findRow = (profileDir: string, nm: string) =>
    parsePatchRows(readPatch(profileDir)).find((r) => r.id === nm || r.name === nm) ?? null

  const findArchive = (nm: string): PluginArchive | null => {
    // 与 list() 同源：用运行时 Loader 状态对齐（loader 是权威），避免吃陈旧 system-state 静态快照
    // 误判 mounted/unmounted（2026-08-30：compact 归一后 dsh-agent-compact 仍被旧快照标 mounted）
    const arch = buildRegistry(selfPluginsDir, profilesDir).find((a) => a.name === nm)
    if (!arch) return null
    return alignWithLoader([arch], loaderSnapshot())[0] ?? null
  }

  /**
   * 写哨兵并绑定**触发者会话**（主人 2026-09-14 定调：「那个会话触发的，提醒就发到那个会话」）。
   *
   * 旧实现写 `resolveActiveSessionId`（猜出来的「活跃会话」）——猜错就把重启提醒投到别的会话：
   * 实测 2026-09-14 18:17 的重启，主人所在会话只跑了长 turn（工具事件不推进 updatedAt）就被
   * 哨兵判「锚点腐化」，提醒落到另一个会话，主人永远收不到。
   *
   * 规则：调用者会话（`exec.agent`）是用户会话（`session-*`）→ 用它；
   * 不可得或是派生会话（裸 uuid 不可 prompt）→ 回退旧判据，并把来源写进哨兵 note（可诊断）。
   */
  const triggerReload = (note: string, caller?: CallerInfo | null) => {
    const callerSid = caller?.sessionId ?? null
    const useCaller = typeof callerSid === 'string' && callerSid.startsWith('session-')
    let sid: string | undefined
    let src: string
    if (useCaller) {
      sid = callerSid
      src = 'caller'
    } else {
      try {
        sid = resolveActiveSessionId(ctx, config.mainSessionId) ?? undefined
        src = 'fallback-active(无调用者或非用户会话)'
      } catch {
        sid = undefined
        src = 'unavailable'
      }
    }
    const file = writeSentinel(dshHome, { workspace, sessionId: sid, note: note + ' | trigger=' + src })
    eventLog('哨兵已写: ' + file + ' | ' + note + ' | trigger=' + src + ' sid=' + String(sid ?? '（无）'))
  }

  /**
   * 第三方插件的生命周期拦截（§5.23）：返回拒绝对象（`{ok:false,error}`）或 null（放行）。
   * 自研走 link 依赖 + patch 行；第三方走 profile 依赖（registry/git pin）+ 包自带 bundle patch——
   * 用自研路径操作第三方会写出错误形态，故**显式拒绝并指路**。
   */
  const refuseThirdParty = (arch: PluginArchive | null, action: LifecycleAction, nm: string, profile: string) => {
    if (arch === null || arch.source !== 'third-party') return null
    return {
      ok: false as const,
      error: thirdPartyRefusal(action, nm, arch.spec ?? '(依赖声明未记录)', profile, arch.bundle === true),
    }
  }

  const mount = async (nm: string, profile: string, cfg?: Record<string, unknown>, caller?: CallerInfo | null) => {
    const arch = findArchive(nm)
    if (!arch) return { ok: false, error: '插件不存在: ' + nm }
    if (arch.source === 'official') return { ok: false, error: '官方 bundle 无需挂载（bundles 列表自带）' }
    const tp = refuseThirdParty(arch, 'mount', nm, profile)
    if (tp) return tp
    if (arch.status !== 'unmounted') return { ok: false, error: '已挂载到 ' + arch.profiles.join(', ') + '（如需换 profile 请先卸载）' }
    const dir = arch.path
    if (!dir) return { ok: false, error: '插件目录缺失' }
    const profileDir = join(profilesDir, profile)
    if (!existsSync(join(profileDir, 'cordis.patch.yml'))) return { ok: false, error: 'profile 不存在: ' + profile }
    const r1 = packageAddLinkDep(profileDir, nm, dir)
    if (!r1.ok) return { ok: false, error: '依赖写入失败' }
    const inst = await installProfile(profileDir, config.installTimeoutMs)
    if (!inst.ok) {
      if (r1.bak) rollbackFile(join(profileDir, 'package.json'), r1.bak)
      return { ok: false, error: 'pnpm install 失败，已回滚: ' + inst.output.slice(-200) }
    }
    const r2 = patchInsert(profileDir, pluginRowId(nm), nm, cfg)
    if (!r2.inserted) {
      if (r1.bak) rollbackFile(join(profileDir, 'package.json'), r1.bak)
      return { ok: false, error: 'patch 已存在同名行（依赖已回滚）' }
    }
    if (bin) {
      // D1：组合变更后预检必须强制完整试运行（现有实例健康 ≠ 新组合可加载）
      const pr = await preflight({ bin, profile, workspace, dshHome, probeExistingFirst: false })
      if (!pr.pass) {
        if (r2.bak) rollbackFile(join(profileDir, 'cordis.patch.yml'), r2.bak)
        if (r1.bak) rollbackFile(join(profileDir, 'package.json'), r1.bak)
        return { ok: false, error: '预检失败，已回滚：' + pr.detail.slice(0, 800) }
      }
    }
    triggerReload('plugin_mount ' + nm + '@' + profile, caller)
    eventLog('挂载 ' + nm + '@' + profile + ' 完成')
    return { ok: true, note: '已挂载 ' + nm + '@' + profile + '；哨兵已写，web 将重启生效' }
  }

  const loaderSnapshot = (): Array<{ name: string; enabled: boolean }> => {
    // 映射逻辑 = loaderSnapshotOf（ops-logic.ts，纯函数）；loader 访问本身仍在此处兜错
    try { return loaderSnapshotOf(loader.entries()) } catch { return [] }
  }

  return {
    list() { return alignWithLoader(buildRegistry(selfPluginsDir, profilesDir), loaderSnapshot()) },
    inspect(nm) { return findArchive(nm) },
    mount,

    async setEnabled(nm: string, profile: string, enabled: boolean, caller?: CallerInfo | null) {
      const arch = findArchive(nm)
      if (!arch) return { ok: false, error: '插件不存在: ' + nm }
      const tp = refuseThirdParty(arch, enabled ? 'start' : 'stop', nm, profile)
      if (tp) return tp
      const profileDir = join(profilesDir, profile)
      if (!existsSync(join(profileDir, 'cordis.patch.yml'))) return { ok: false, error: 'profile 不存在: ' + profile }
      const row = findRow(profileDir, nm)
      if (!row) return { ok: false, error: '插件未挂载到 ' + profile + '（先 plugin_mount）' }
      if (row.disabled === !enabled) return { ok: false, error: '已是目标状态' }
      const r = patchSetDisabled(profileDir, row.id, !enabled)
      if (!r.ok) return { ok: false, error: 'patch 写入失败' }
      if (bin) {
        // D1：组合变更后预检必须强制完整试运行
        const pr = await preflight({ bin, profile, workspace, dshHome, probeExistingFirst: false })
        if (!pr.pass) {
          if (r.bak) rollbackFile(join(profileDir, 'cordis.patch.yml'), r.bak)
          eventLog('启停预检失败已回滚: ' + nm)
          return { ok: false, error: '预检失败，已回滚：' + pr.detail.slice(0, 800) }
        }
      }
      triggerReload('plugin_' + (enabled ? 'start' : 'stop') + ' ' + nm + '@' + profile, caller)
      eventLog((enabled ? '启动' : '停用') + ' ' + nm + '@' + profile + ' 完成')
      return { ok: true, note: (enabled ? '已启用' : '已停用') + ' ' + nm + '@' + profile + '；哨兵已写，web 将重启生效' }
    },

    async remove(nm: string, profile: string, caller?: CallerInfo | null) {
      const arch = findArchive(nm)
      if (!arch) return { ok: false, error: '插件不存在: ' + nm }
      const tp = refuseThirdParty(arch, 'unmount', nm, profile)
      if (tp) return tp
      const profileDir = join(profilesDir, profile)
      const row = findRow(profileDir, nm)
      if (!row) return { ok: false, error: '插件未挂载到 ' + profile }
      const r = patchRemove(profileDir, row.id)
      if (!r.removed) return { ok: false, error: 'patch 移除失败' }
      let depBak: string | null = null
      if (arch.source === 'self') {
        const dr = packageRemoveDep(profileDir, nm)
        depBak = dr.bak
        const inst = await installProfile(profileDir, config.installTimeoutMs)
        if (!inst.ok) {
          if (r.bak) rollbackFile(join(profileDir, 'cordis.patch.yml'), r.bak)
          if (depBak) rollbackFile(join(profileDir, 'package.json'), depBak)
          return { ok: false, error: 'pnpm install 失败，已回滚: ' + inst.output.slice(-200) }
        }
      }
      if (bin) {
        // D1：组合变更后预检必须强制完整试运行
        const pr = await preflight({ bin, profile, workspace, dshHome, probeExistingFirst: false })
        if (!pr.pass) {
          if (r.bak) rollbackFile(join(profileDir, 'cordis.patch.yml'), r.bak)
          if (depBak) rollbackFile(join(profileDir, 'package.json'), depBak)
          eventLog('卸载预检失败已回滚: ' + nm)
          return { ok: false, error: '预检失败，已回滚：' + pr.detail.slice(0, 800) }
        }
      }
      triggerReload('plugin_remove ' + nm + '@' + profile, caller)
      eventLog('卸载 ' + nm + '@' + profile + ' 完成（数据目录保留）')
      return { ok: true, note: '已卸载 ' + nm + '@' + profile + '；数据目录保留；哨兵已写，web 将重启生效' }
    },

    async purge(nm: string, profile: string, opts: PurgeOptions, caller?: CallerInfo | null): Promise<PurgeResult> {
      const apply = opts?.apply === true
      const semId = nm.replace(/^dsh-/, '')
      const scaffold = (over: Partial<PurgeResult> = {}): PurgeResult => ({
        ok: false, dryRun: !apply, name: nm, profile,
        dir: { exists: false, path: join(selfPluginsDir, nm), bytes: 0 },
        gitlink: { mode: null, hint: '' },
        semantic: { entryId: semId, present: false, hint: '' },
        references: [],
        traceWritten: false,
        ...over,
      })

      const arch = findArchive(nm)
      if (!arch) return scaffold({ error: '插件不存在: ' + nm })
      const tp = refuseThirdParty(arch, 'unmount', nm, profile)
      if (tp !== null && tp !== undefined) return scaffold({ error: tp.error ?? '第三方插件不支持彻底退役' })

      // ── 影响面（干跑与真跑共用同一份读数）
      const dirPath = join(selfPluginsDir, nm)
      const dirExists = existsSync(dirPath)
      const semPresent = registryHasId(join(workspace, 'docs', 'semantics', 'registry.json'), semId)
      const gitMode = gitIndexMode(workspace, 'self-plugins/' + nm)
      const refs = scanReferences(workspace, nm)
      const impact: PurgeResult = scaffold({
        ok: true,
        dir: { exists: dirExists, path: dirPath, bytes: dirExists ? dirSizeBytes(dirPath) : 0 },
        gitlink: {
          mode: gitMode,
          hint: gitMode === null ? '' : `git rm --cached self-plugins/${nm}（改主仓索引，由主体决定）`,
        },
        semantic: {
          entryId: semId,
          present: semPresent,
          hint: semPresent
            ? 'registry.json 的 owner 是 dsh-semantic-docs ⇒ 经它注销（或手工改条目后跑 semantic_check）'
            : '',
        },
        references: refs,
      })
      if (!apply) {
        return { ...impact, note: '干跑：未做任何改动。传 apply=true 执行（卸载 + 目录归档）。' }
      }

      // ── 执行 ①：若仍挂载，先走 remove（复用其预检与回滚保护）
      const row = findRow(join(profilesDir, profile), nm)
      if (row !== undefined && row !== null) {
        const r = await this.remove(nm, profile, caller)
        if (!r.ok) return { ...impact, ok: false, error: '卸载失败，未归档: ' + (r.error ?? '(无原因)') }
      }

      // ── 执行 ②：目录移入归档区（**不物理删除** ⇒ 可回退）
      let archivedTo: string | undefined
      if (dirExists) {
        try {
          const dest = join(dshHome, 'archive', 'plugin-purge', `${nm}-${stamp()}`)
          mkdirSync(dirname(dest), { recursive: true })
          renameSync(dirPath, dest)
          archivedTo = dest
        } catch (err) {
          return { ...impact, ok: false, error: '目录归档失败（原目录未动）: ' + (err as Error).message }
        }
      }

      // ── 执行 ③：留痕
      const traceWritten = appendPurgeTrace(dshHome, {
        action: 'purge', name: nm, profile, archivedTo: archivedTo ?? null,
        bytes: impact.dir.bytes, gitlink: gitMode, semanticPresent: semPresent,
        references: refs, caller: caller ?? null,
      })
      eventLog(`彻底退役 ${nm}@${profile}：目录 → ${archivedTo ?? '(无目录)'}；语义条目与引用未动（见影响面）`)
      return {
        ...impact,
        dir: { ...impact.dir, archivedTo },
        traceWritten,
        note: `已彻底退役：目录归档至 ${archivedTo ?? '(无目录可归档)'}。`
          + `语义条目${semPresent ? `仍在（${semId}，需 dsh-semantic-docs 注销）` : '不存在'}；`
          + `引用 ${refs.length} 处未改动（改指需判断）。`,
      }
    },

    async configure(nm: string, profile: string, cfg: Record<string, unknown>, caller?: CallerInfo | null) {
      const arch = findArchive(nm)
      if (!arch) return { ok: false, error: '插件不存在: ' + nm }
      const tp = refuseThirdParty(arch, 'configure', nm, profile)
      if (tp) return tp
      const profileDir = join(profilesDir, profile)
      const row = findRow(profileDir, nm)
      if (!row) return { ok: false, error: '插件未挂载到 ' + profile }
      const r = patchSetConfig(profileDir, row.id, cfg)
      if (!r.ok) return { ok: false, error: 'patch 配置写入失败' }
      if (bin) {
        // D1：组合变更后预检必须强制完整试运行
        const pr = await preflight({ bin, profile, workspace, dshHome, probeExistingFirst: false })
        if (!pr.pass) {
          if (r.bak) rollbackFile(join(profileDir, 'cordis.patch.yml'), r.bak)
          return { ok: false, error: '预检失败，已回滚：' + pr.detail.slice(0, 800) }
        }
      }
      triggerReload('plugin_configure ' + nm + '@' + profile, caller)
      eventLog('配置更新 ' + nm + '@' + profile + '：' + JSON.stringify(cfg).slice(0, 200))
      return { ok: true, note: '配置已更新；哨兵已写，web 将重启生效' }
    },

    create(nm, description) {
      if (!isValidPluginName(nm)) return { ok: false, error: '插件名须为小写字母开头，仅 [a-z0-9-]' }
      const dir = join(selfPluginsDir, nm)
      if (existsSync(dir)) return { ok: false, error: '目录已存在: ' + dir }
      try {
        mkdirSync(join(dir, 'src'), { recursive: true })
        writeFileSync(join(dir, 'package.json'), JSON.stringify({
          name: nm, version: '0.1.0', description: description || '（待填写用途）', type: 'module',
          main: 'lib/index.js', types: 'lib/types/index.d.ts',
          exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' }, './package.json': './package.json' },
          files: ['lib', 'README.md'], license: 'MIT',
          // ⚠ 单一真源常量：范围写成 `^0.x` 会被宿主兼容门**静默** disable（见 SCAFFOLD_PEER_DEPS 的注释）
          peerDependencies: SCAFFOLD_PEER_DEPS,
          devDependencies: { '@types/node': '^22.0.0', typescript: '^5.9.3' },
          scripts: { build: 'tsc -p tsconfig.json', typecheck: 'tsc -p tsconfig.json --noEmit' },
        }, null, 2) + '\n', 'utf8')
        writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2022'],
            strict: true, noImplicitAny: true, noUncheckedIndexedAccess: true, declaration: true,
            declarationDir: 'lib/types', outDir: 'lib', rootDir: 'src', esModuleInterop: true,
            skipLibCheck: true, forceConsistentCasingInFileNames: true, allowImportingTsExtensions: true,
            rewriteRelativeImportExtensions: true, types: ['node'] },
          include: ['src'], exclude: [],
        }, null, 2) + '\n', 'utf8')
        writeFileSync(join(dir, 'src/index.ts'), scaffoldSource(nm, description || ''), 'utf8')
        writeFileSync(join(dir, 'README.md'), '# ' + nm + '\n\n' + (description || '（待填写用途）') + '\n', 'utf8')
        // pnpm-workspace.yaml：防 peer 被装成真实副本（遮蔽宿主链接层）——本机约定 2026-09-26 立。
        writeFileSync(join(dir, 'pnpm-workspace.yaml'), SCAFFOLD_PNPM_WORKSPACE, 'utf8')
        eventLog('创建插件 ' + nm + ' @ ' + dir)
        // 守卫：新建即断言（**模板是缺口复制器**——不在这里拦，每个未来产物都会带着同一个缺陷出去）。
        // ⚠ 不阻断创建：判据自身也可能读不到宿主版本，「未判定」必须报出来，而不是让创建失败。
        const peerIssues = peerSatisfactionIssues(SCAFFOLD_PEER_DEPS, hostRuntimeVersion())
        // 第二道守卫：**读回**刚写的 pnpm-workspace.yaml，确认它真能防住遮蔽（写失败/内容被改都能抓到）。
        let workspaceIssues: string[] = []
        try {
          workspaceIssues = workspaceFileIssues(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'))
        } catch (err) {
          workspaceIssues = ['pnpm-workspace.yaml 读不回（写入可能失败）：' + String(err)]
        }
        if (peerIssues.length === 0 && workspaceIssues.length === 0) return { ok: true, dir }
        const parts: string[] = []
        if (peerIssues.length > 0) {
          parts.push('脚手架 peer 范围与宿主运行时**不匹配**（该插件挂载后会被宿主静默 disable：'
            + '挂载返回成功、patch 行也在，但一行不生效）：\n  ' + peerIssues.join('\n  '))
        }
        if (workspaceIssues.length > 0) {
          parts.push('脚手架 pnpm-workspace.yaml 有问题（依赖会被装成真实副本、遮蔽宿主链接层）：\n  '
            + workspaceIssues.join('\n  '))
        }
        return { ok: true, dir, warning: parts.join('\n\n') }
      } catch (err) {
        return { ok: false, error: '创建失败: ' + String(err) }
      }
    },
  }
}
/** client UI 数据通道（Typert Gateway）。 */
export class PluginManagerRemoteService extends TypertRemoteService {
  static inject = []
  constructor(ctx: Context, private readonly o: PluginManagerOps) {
    // namespace 必须与 client descriptor 一致（'pluginManager'）
    super(ctx, 'pluginManagerRemote', { namespace: 'pluginManager' })
  }
  @Remote('list')
  list(): { plugins: ReturnType<typeof publicArchive>[] } {
    return { plugins: this.o.list().map(publicArchive) }
  }
  @Remote('inspect')
  inspect(req: { name: string }): { plugin: ReturnType<typeof publicArchive> | null } {
    const p = this.o.inspect(req.name)
    return { plugin: p ? publicArchive(p) : null }
  }
  @Remote('start')
  start(req: { name: string; profile?: string }): Promise<{ ok: boolean; error?: string; note?: string }> {
    return this.o.setEnabled(req.name, req.profile || 'web', true)
  }
  @Remote('stop')
  stop(req: { name: string; profile?: string }): Promise<{ ok: boolean; error?: string; note?: string }> {
    return this.o.setEnabled(req.name, req.profile || 'web', false)
  }
  // 方法名避开命名空间保留方法（'remove' 与官方 gateway 冲突——2026-08-16 实测）
  @Remote('unmount')
  unmount(req: { name: string; profile?: string }): Promise<{ ok: boolean; error?: string; note?: string }> {
    return this.o.remove(req.name, req.profile || 'web')
  }
  @Remote('create')
  create(req: { name: string; description?: string }): Promise<{ ok: boolean; error?: string; dir?: string }> {
    return Promise.resolve(this.o.create(req.name, req.description || ''))
  }
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('plugin-manager')
  // ctx.loader 类型声明来自 @deepseek-ai/cordis-plugin-loader 的 declare module（副作用 type import）；
  // 个别 tsc 解析下不生效，这里用结构断言（运行时 inject 'loader' 保证存在）。
  const loader = (ctx as unknown as { loader: { entries(): Iterable<{ options: { name?: string }; disabled?: boolean }> } }).loader
  const ops = createOps(ctx, config, loader)
  ctx.plugin(PluginManagerRemoteService, ops)

  const require = createRequire(import.meta.url)

  // ---------- 预检调用记录 + 重启前校验（主人 2026-08-30：重启前必须检查会话中是否调用过预检工具） ----------
  // 预检工具（preflight_check）被调用时落盘一条记录；daemon_restart 写哨兵前读取并校验。
  // 「会话过程中」= 记录时间不早于本次 web 进程启动（用 process.uptime 反推）。
  const dshHome = config.dshHome || process.env.DSH_HOME || ''
  const invokedFile = join(dshHome, '.preflight-invoked.json')
  const webStartMs = Date.now() - process.uptime() * 1000
  const recordPreflightInvoked = (pass: boolean, mode: string, caller: CallerInfo | null): void => {
    // 2026-09-05 修复：会话解析失败（cordis 严格代理下 ctx.sessions 访问抛错）不得阻断写盘——
    // 原实现把 resolveActiveSessionId 与 writeFileSync 放在同一 try，解析抛错则记录从未落盘，
    // preflight_check 却返回「已记录」，导致 daemon_restart 门控误判「非本会话调用」。
    // 2026-09-12（t-a2385a9f）：`sessionId` 是**历史遗留字段**——它等于 resolveActiveSessionId 的结果
    // （当前活跃/主会话），**不是调用者**；**真实调用者记在 `caller`**（来自 exec.agent），排查看 caller。
    let sid: string | null = null
    try { sid = resolveActiveSessionId(ctx, config.mainSessionId) ?? null } catch { sid = null }
    try {
      writeFileSync(invokedFile, JSON.stringify({
        at: new Date().toISOString(), atMs: Date.now(),
        workspace: config.defaultWorkspace || process.cwd(),
        sessionId: sid, pass, mode, caller: caller ?? null,
      }, null, 2), 'utf8')
    } catch (e) { logger.warn('预检记录落盘失败: ' + String(e)) }
  }
  /** 读取落盘记录（**不吞异常**：读盘/解析问题经 issue 显式返回，不伪装成「没调用过」）。 */
  const readPreflightRecord = (): { rec: PreflightRecord | null; issue?: string } => {
    try {
      if (!existsSync(invokedFile)) return { rec: null }
      return { rec: JSON.parse(readFileSync(invokedFile, 'utf8')) as PreflightRecord }
    } catch (e) {
      return { rec: null, issue: '读取/解析失败: ' + String(e) }
    }
  }
  /**
   * 门控裁决（**进程级判据**，见 AGENTS.md §5.11 §3：不比对 sessionId——这是设计如此，不是漏洞）。
   * 2026-09-12 修复（t-a2385a9f）：① 记录真实调用者（exec.agent）② 文案不再冒充「本会话」
   * ③ 每次裁决带证据行（谁按的按钮），让「为什么我的重启能过闸」可回答。
   */
  const preflightInvokedInProcess = (): GateDecision => {
    const { rec, issue } = readPreflightRecord()
    if (issue !== undefined) return { ok: false, reason: '预检记录不可读（' + issue + '）', evidence: '记录不可读' }
    return decidePreflightGate(rec, {
      workspace: config.defaultWorkspace || process.cwd(),
      webStartMs,
    })
  }

  ctx.tools.register(defineTool({
    name: 'plugin_list',
    description: '列出全部插件档案（来源/版本/用途/工具/挂载状态/配置摘要）——按「自研 / 官方 / 非官方」分组。可选按来源/状态过滤。',
    parameters: {
      source: { type: 'string', enum: ['self', 'official', 'third-party'], description: '来源过滤（self=自研, official=官方, third-party=非官方）' },
      status: { type: 'string', enum: ['mounted', 'disabled', 'unmounted'], description: '状态过滤' }
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { count: { type: 'number', required: true }, plugins: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } } } }, render: (_a: any, v: any) => {
      // 分组/排序/行格式 = pluginListLines（ops-logic.ts，纯函数，可离线单测）
      return [{ type: 'text', text: pluginListLines(v.plugins).join('\n') }]
    } },
    async execute(args: { source?: string; status?: string }) {
      const plugins = filterArchives(ops.list(), { source: args.source, status: args.status })
      return { count: plugins.length, plugins: plugins.map(publicArchive) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_update_check',
    description: '第三方插件上游更新检查（只读·只报告）：枚举本机已装第三方插件 → 解析各自上游（spec 的 github 短写 / package.json repository / homepage）→ 查上游最新版本（npm registry latest → GitHub release → GitHub tag）→ 版本比较。**六档互不掩盖**：有更新 / 已最新 / 不可比（如 prerelease 标识不同）/ 无上游源 / 查询失败 / 已跳过——网络失败绝不读成「没更新」。不做自动升级：第三方升级要走「读上游 CHANGELOG → 换 pin → 重装 → 重启 → 黑盒验收」（§5.23）。',
    parameters: {
      only: { type: 'string', description: '只看某个插件名（可选）' },
      timeoutMs: { type: 'number', description: '单个上游查询超时（ms，缺省 8000）' }
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          checkedAt: { type: 'string', required: true },
          counts: { type: 'object', additionalProperties: true, required: true },
          coverage: { type: 'object', additionalProperties: true, required: true },
          rows: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_a: any, v: any) => {
        const r = v.rows as Array<{ name: string; local: string; latest: string | null; verdict: string; note: string }>
        const head = `第三方插件上游更新检查 @ ${v.checkedAt}`
        const cov = `覆盖度：应查 ${v.coverage.expected} · 实查 ${v.coverage.queried}` +
          (v.coverage.missing.length > 0 ? ` · ⚠ 漏查 ${v.coverage.missing.join(', ')}` : '')
        const cnt = Object.entries(v.counts as Record<string, number>)
          .filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' · ')
        const lines = r.map((x) => updateLine({
          name: x.name, local: x.local, latest: x.latest,
          verdict: x.verdict as UpdateVerdict, note: x.note,
        }))
        return [{ type: 'text', text: [head, cov, cnt, '', ...lines].join('\n') }]
      },
    },
    async execute(args: { only?: string; timeoutMs?: number }) {
      const report = await runUpdateCheck({
        profilesDir: config.profilesDir || join(dshHome, 'profiles'),
        selfPluginsDir: config.selfPluginsDir || join(dshHome, 'self-plugins'),
        ...(args.only === undefined ? {} : { only: args.only }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      })
      logger.info(`更新检查：应查 ${report.coverage.expected} 实查 ${report.coverage.queried}` +
        (report.coverage.missing.length > 0 ? ` 漏查 ${report.coverage.missing.join(',')}` : ''))
      return report as any
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_mcp_check',
    description: 'MCP 服务器专项体检（只读·只报告）：枚举各 profile 里 `@deepseek-ai/dsh-mcp-client` 注册行 → 解析在跑的是哪个包/哪个版本（npx/bunx 的 args）→ 判定健康档位 → 可选查上游最新版。**为什么 MCP 需要单独一档**：它们不在 profile 依赖里（住在 cordis.patch.yml 的 config.args），所以依赖扫描器结构上看不见；且有四档互不掩盖的健康状态——`active`（在跑）/ `disabled-in-patch`（配置有意停用）/ **`denied-runtime`（★ 配置启用但被 DSH 兼容性预检静默停用——只往 stderr 打一行，不进上下文）**/ `unknown`（缺日志证据，不猜）。另标出**浮动版本**（`@latest`/无版本 ⇒ 配置里不存在确定版本，每次启动可能换）。不写任何配置、不动任何 pin。',
    parameters: {
      profile: { type: 'string', description: '只看某个 profile（缺省=全部）' },
      probeUpstream: { type: 'boolean', description: '是否查上游最新版（缺省 true；离线体检传 false）' },
      timeoutMs: { type: 'number', description: '上游查询超时（ms，缺省 8000）' }
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          checkedAt: { type: 'string', required: true },
          log: { type: 'object', additionalProperties: true, required: true },
          counts: { type: 'object', additionalProperties: true, required: true },
          rows: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_a: any, v: any) => {
        const rows = v.rows as Array<Parameters<typeof mcpLine>[0] & { health: string; note: string }>
        const head = `MCP 服务器体检 @ ${v.checkedAt}`
        const logLine = v.log.available
          ? `启动日志证据：${v.log.path}（尾部 ${v.log.bytesRead} 字节）`
          : '启动日志证据：⚠ 读不到 ⇒ 健康档位判 unknown（不猜「在跑」）'
        const cnt = Object.entries(v.counts as Record<string, number>)
          .map(([k, n]) => `${k}=${n}`).join(' · ')
        const lines = rows.length === 0
          ? ['（本机没有注册任何 MCP 服务器）']
          : rows.map((r) => (r.health === 'denied-runtime' ? `${mcpLine(r)}\n      ↳ ${r.note}` : mcpLine(r)))
        return [{ type: 'text', text: [head, logLine, cnt, '', ...lines].join('\n') }]
      },
    },
    async execute(args: { profile?: string; probeUpstream?: boolean; timeoutMs?: number }) {
      const report = await runMcpCheck({
        dshHome,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        ...(args.probeUpstream === undefined ? {} : { probeUpstream: args.probeUpstream }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      })
      const denied = report.rows.filter((r) => r.health === 'denied-runtime').map((r) => r.id)
      logger.info(`MCP 体检：${report.rows.length} 个` +
        (denied.length > 0 ? ` · ⚠ 运行时被拒 ${denied.join(',')}` : ''))
      return report as any
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_inspect',
    description: '查看单个插件的深度档案（用途/工具/配置/挂载详情）。',
    parameters: { name: { type: 'string', required: true, description: '插件名' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, plugin: { type: 'object', additionalProperties: true }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? JSON.stringify(v.plugin, null, 1) : (v.error ?? '') }] },
    async execute(args: { name: string }) {
      const p = ops.inspect(args.name)
      return p ? { ok: true, plugin: publicArchive(p) } : { ok: false, error: '插件不存在: ' + args.name }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_audit',
    description: '插件档案漂移审计（只读）：比对「自述」与「档案事实」——自述工具数 ≠ 清单长度 / 声称有工具但清单为空 / 无用途描述 / 声明挂载但未构建 / 挂载零工具未声称。抓的是「描述改了、工具面没同步」这类漂移（2026-09-17 事故：dsh-blue-team 档案 tools=[] 而自称 8 个、dsh-search-pro 列 1 而自称 23）。边界：**看不见运行时真实工具面**——那要靠 toolface status 与实调验证。',
    parameters: { only: { type: 'string', description: '只看某个插件（可选）' } },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          count: { type: 'number' },
          findings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_a: any, v: any) => [{ type: 'text', text: v.count === 0 ? '✓ 无漂移：自述与档案事实一致' : v.findings.join('\n') }],
    },
    async execute(args: { only?: string }) {
      const all = ops.list() as PluginArchive[]
      const archives = args.only ? all.filter((a) => a.name === args.only) : all
      const findings = detectDrift(archives).map((f) => `⚠ ${f.name} · ${f.kind} — ${f.detail}`)
      return { ok: true, count: findings.length, findings }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_create',
    description: '创建新插件（脚手架）：在 self-plugins 生成 package.json/tsconfig/src 骨架，随后可 plugin_mount 挂载。',
    parameters: {
      name: { type: 'string', required: true, description: '插件名（小写字母开头，仅 [a-z0-9-]）' },
      description: { type: 'string', description: '一句话用途（写入 description 与 README）' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          dir: { type: 'string' },
          error: { type: 'string' },
          warning: { type: 'string' },
        },
      },
      render: (_a: any, v: any) => [{
        type: 'text',
        text: v.ok
          ? ('已创建: ' + v.dir + (v.warning ? `
⚠ ` + v.warning : ''))
          : (v.error ?? ''),
      }],
    },
    async execute(args: { name: string; description?: string }) {
      return ops.create(args.name, args.description ?? '')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_mount',
    description: '挂载插件到 profile：写 link 依赖 + pnpm install + patch insert + 沙盒预检 + 哨兵重启（全自动闭环）。',
    parameters: {
      name: { type: 'string', required: true, description: '插件名（self-plugins 目录名）' },
      profile: { type: 'string', description: '目标 profile（默认 web）' },
      config: { type: 'object', additionalProperties: true, description: '初始配置（patch config，可选）' }
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, note: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? (v.note ?? 'ok') : (v.error ?? '') }] },
    async execute(args: { name: string; profile?: string; config?: Record<string, unknown> }, exec) {
      return ops.mount(args.name, args.profile || 'web', args.config, extractCaller(exec))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_unmount',
    description: '卸载插件（与 plugin_remove 相同）：patch 移除 + 依赖移除 + 预检 + 哨兵重启；保留插件数据目录。',
    parameters: {
      name: { type: 'string', required: true, description: '插件名' },
      profile: { type: 'string', description: '目标 profile（默认 web）' }
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, note: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? (v.note ?? 'ok') : (v.error ?? '') }] },
    async execute(args: { name: string; profile?: string }, exec) {
      return ops.remove(args.name, args.profile || 'web', extractCaller(exec))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plugin_purge',
    description:
      '彻底退役一个自研插件：**先出影响面，再执行**。'
      + '为什么需要它：`plugin_unmount` 只清「挂载点 + profile 依赖」两处，实测（2026-10-03，14 个历史卸载样本）'
      + '退役后 13/14 仍留残留——插件目录 + gitlink（1）、语义注册表条目（11）、技能/文档引用（8）。'
      + '执行面：目录**移入** `${DSH_HOME}/archive/plugin-purge/`（不物理删除，可回退），每次留痕 `plugin-purge-trace.jsonl`。'
      + '边界：语义注册表条目与文档/技能引用**只报告不改**（前者归 dsh-semantic-docs，后者改指需判断）；gitlink 只报告并给出命令。'
      + '**默认干跑**：apply 缺省 false，只列影响面，零改动。',
    parameters: {
      name: { type: 'string', required: true, description: '插件名（自研，dsh- 前缀）' },
      profile: { type: 'string', description: '目标 profile（默认 web）' },
      apply: { type: 'boolean', description: '缺省 false = 干跑只出影响面；true = 执行（卸载 + 目录归档）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          dryRun: { type: 'boolean', required: true },
          name: { type: 'string', required: true },
          profile: { type: 'string', required: true },
          note: { type: 'string', required: true },
          error: { type: 'string', required: true },
          dirExists: { type: 'boolean', required: true },
          dirBytes: { type: 'number', required: true },
          archivedTo: { type: 'string', required: true },
          gitlinkMode: { type: 'string', required: true },
          semanticPresent: { type: 'boolean', required: true },
          referenceCount: { type: 'number', required: true },
          traceWritten: { type: 'boolean', required: true },
        },
      },
      render: (_a: unknown, v: any) => {
        // 渲染文案 = 纯层 purgeReportLines（工具与测试共用，防漂移）
        return [{ type: 'text', text: purgeReportLines({
          ok: v.ok === true,
          dryRun: v.dryRun === true,
          name: String(v.name ?? ''),
          profile: String(v.profile ?? ''),
          error: typeof v.error === 'string' ? v.error : undefined,
          dirExists: v.dirExists === true,
          dirBytes: typeof v.dirBytes === 'number' ? v.dirBytes : 0,
          archivedTo: typeof v.archivedTo === 'string' ? v.archivedTo : undefined,
          gitlinkMode: typeof v.gitlinkMode === 'string' ? v.gitlinkMode : undefined,
          semanticPresent: v.semanticPresent === true,
          referenceCount: typeof v.referenceCount === 'number' ? v.referenceCount : 0,
          traceWritten: v.traceWritten === true,
        }).join('\n') }]
      },
    },
    async execute(args: { name: string; profile?: string; apply?: boolean }, exec) {
      const r = await ops.purge(args.name, args.profile || 'web', { apply: args.apply === true }, extractCaller(exec))
      return {
        ok: r.ok,
        dryRun: r.dryRun,
        name: r.name,
        profile: r.profile,
        note: r.note ?? '',
        error: r.error ?? '',
        dirExists: r.dir.exists,
        dirBytes: r.dir.bytes,
        archivedTo: r.dir.archivedTo ?? '',
        gitlinkMode: r.gitlink.mode ?? '',
        semanticPresent: r.semantic.present,
        referenceCount: r.references.reduce((n, x) => n + x.hits, 0),
        traceWritten: r.traceWritten,
      }
    },
  }))

  for (const [toolName, enabled, verb] of [['plugin_start', true, '启动'], ['plugin_stop', false, '停用']] as const) {
    ctx.tools.register(defineTool({
      name: toolName,
      description: verb + '插件（patch disabled 切换 + 预检 + 哨兵重启）。',
      parameters: {
        name: { type: 'string', required: true, description: '插件名' },
        profile: { type: 'string', description: '目标 profile（默认 web）' }
      },
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, note: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? (v.note ?? 'ok') : (v.error ?? '') }] },
      async execute(args: { name: string; profile?: string }, exec) {
        return ops.setEnabled(args.name, args.profile || 'web', enabled, extractCaller(exec))
      },
    }))
  }

  ctx.tools.register(defineTool({
    name: 'plugin_configure',
    description: '更新插件配置（patch config 整体替换）+ 预检 + 哨兵重启。',
    parameters: {
      name: { type: 'string', required: true, description: '插件名' },
      profile: { type: 'string', description: '目标 profile（默认 web）' },
      config: { type: 'object', additionalProperties: true, required: true, description: '新配置（整体替换）' }
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, note: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? (v.note ?? 'ok') : (v.error ?? '') }] },
    async execute(args: { name: string; profile?: string; config: Record<string, unknown> }, exec) {
      return ops.configure(args.name, args.profile || 'web', args.config, extractCaller(exec))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'preflight_check',
    description: '预检工具：执行组合试运行预检并落盘「本 web 进程内已调用预检」记录（.preflight-invoked.json，含**真实调用者**）。重启（daemon_restart）前必须先调用本工具且预检通过——否则重启会被拒绝。判据是进程级（§5.11 §3），调用者身份作证据留痕。mode=full 完整试运行（~20s），quick 快速（~8s）。',
    parameters: {
      mode: { type: 'string', enum: ['full', 'quick'], description: '预检模式（默认 full）' },
      profile: { type: 'string', description: '目标 profile（默认 web）' }
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, pass: { type: 'boolean' }, note: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? (v.pass ? '预检通过，已记录（可重启）' : '预检未通过（已记录，重启将被拒绝）：' + (v.note ?? '')) : (v.error ?? '') }] },
    async execute(args: { mode?: string; profile?: string }, exec) {
      const mode = args.mode === 'quick' ? 'quick' : 'full'
      const profile = args.profile || 'web'
      let bin = config.bin
      if (!bin) { try { bin = require.resolve('@deepseek-ai/dsh/lib/bin.js') } catch { bin = '' } }
      if (!bin) return { ok: false, error: 'bin 未定位，无法执行预检' }
      // D1：preflight_check 是「当前组合」检查——目标 profile 是当前 web 实例（默认）时，
      // 现有实例健康即组合可加载 → probeExistingFirst=true 毫秒级短路；quick 模式无试运行。
      // 2026-09-05 主人反思修复：改代码后重启 = 组合变更，不能短路——
      // self-plugins 任一插件的 lib 比当前 web 启动晚（刚构建未验证）→ 强制完整试运行验证新组合。
      const probeFirst = profile === 'web' && !hasUnverifiedBuilds(dshHome)
      const pr = await preflight({
        bin, profile,
        workspace: config.defaultWorkspace || process.cwd(),
        dshHome,
        mode,
        probeExistingFirst: probeFirst,
      })
      const caller = extractCaller(exec)
      recordPreflightInvoked(pr.pass, mode, caller)
      return { ok: true, pass: pr.pass, note: (mode + ' 预检 ' + (pr.pass ? 'PASS' : 'FAIL') + '\n调用者: ' + describeCaller(caller) + (pr.pass ? '' : '\n' + pr.detail.slice(0, 600))) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'daemon_restart',
    description: '重启 web 守护服务（哨兵协议：预检 → kill+重启 → 唤醒 → 清哨兵）。爱丽丝自主决策用：内存回收/状态清理/任意原因；reason 必填留痕。不改组合，组合预检由守护 v2.3 门控兜底（失败不 kill 旧 web）。两道门控：① **本 web 进程内**是否调用过预检工具（preflight_check），未调用则拒绝（进程级判据，§5.11 §3）；② **是否有在飞分身**（派生会话最近仍在活动）——它们与 web 同进程，重启会直接斩断且无法恢复，故拒绝，除非传 force: true。',
    parameters: {
      reason: { type: 'string', required: true, description: '重启原因（决策记录，记入日志）' },
      profile: { type: 'string', description: '目标 profile（默认 web）' },
      force: { type: 'boolean', description: '有在飞分身时仍强制重启（后果：那些分身的工作会丢失，且它们不可恢复）' }
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, note: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? (v.note ?? 'ok') : (v.error ?? '') }] },
    async execute(args: { reason: string; profile?: string; force?: boolean }, exec) {
      if (!args.reason || !args.reason.trim()) return { ok: false, error: 'reason 必填（重启是自主决策，必须留痕）' }
      // 【重启前预检校验 · 主人 2026-08-30】本 web 进程内必须调用过预检工具且通过，否则拒绝重启。
      // 判据是**进程级**（AGENTS.md §5.11 §3：不比对 sessionId，这是设计如此）；调用者身份只作证据留痕。
      const gate = preflightInvokedInProcess()
      const caller = extractCaller(exec)
      const evLine = 'daemon_restart 门控证据：' + gate.evidence + ' · 调用者比对：' + callerComparison(readPreflightRecord().rec, caller) + ' · 结论=' + (gate.ok ? '放行' : '拒绝（' + (gate.reason ?? '') + '）')
      logger.info(evLine)
      try {
        const fs = await import('node:fs')
        const dir = config.dshHome || process.env.DSH_HOME || ''
        if (dir) fs.appendFileSync(join(dir, '.plugin-manager-events.log'), '[' + new Date().toISOString() + '] ' + evLine + '\n')
      } catch { /* 证据行落盘失败不阻断重启判定 */ }
      if (!gate.ok) {
        return { ok: false, error: '重启被拒绝：' + gate.reason + '。请先调用 preflight_check 预检工具（通过后）再重启。' }
      }
      // 【在飞分身门控 · 2026-09-22 主人：「重启的时候会打断分身，想办法解决一下」】
      // 子代理与 web **同进程**：kill 即斩断，而它不可寻址（不是 teammate）、不是 job、无 settle 通知
      // ⇒ 重启 = 整轮工作蒸发（当日实测：分身最后产出 14:57:27，我 14:57:32 重启）。
      // 判据本体 = findInFlightSubagents（纯函数，含对照组测例：超窗/无事件/主会话必须放行）。
      let inflight: ReturnType<typeof findInFlightSubagents> = []
      let inflightDirs: ReturnType<typeof findInFlightSessionDirs> = []
      let inflightLine: string
      if (config.inflightWindowMs > 0) {
        const nowMs = Date.now()
        const notes: string[] = []
        // 来源①：内存会话表。⚠ **实测不含在飞子代理**（真机日志：候选会话 2 · 命中 0，而分身确在跑），
        // 保留它成本近零、且能覆盖别的形态，但**不能**作为唯一判据。
        try {
          const sessions = (ctx as Context & { sessions?: { list(): SessionListItem[] } }).sessions?.list() ?? []
          inflight = findInFlightSubagents(sessions, nowMs, config.inflightWindowMs)
          notes.push('内存会话表 ' + String(sessions.length) + ' 个→命中 ' + String(inflight.length))
        } catch (e) {
          notes.push('内存会话表 查询失败→按不命中（' + (e instanceof Error ? e.message : String(e)) + '）')
        }
        // 来源②：**会话目录**（真源）——子代理会话以**裸 uuid** 命名落在磁盘上，目录 mtime = 最后写入。
        try {
          const dirs = listInflightScanDirs(config.dshHome || process.env.DSH_HOME || '')
          inflightDirs = findInFlightSessionDirs(dirs, nowMs, config.inflightWindowMs)
          notes.push('会话目录 ' + String(dirs.length) + ' 个→命中 ' + String(inflightDirs.length))
        } catch (e) {
          notes.push('会话目录 扫描失败→按不命中（' + (e instanceof Error ? e.message : String(e)) + '）')
        }
        const hit = inflight.length + inflightDirs.length
        inflightLine = '在飞分身检查：' + notes.join(' · ') + (hit > 0 ? ' ⇒ 拒绝' : ' ⇒ 放行')
      } else {
        inflightLine = '在飞分身检查：已按配置关闭（inflightWindowMs=0）——重启将不检查在飞分身'
      }
      logger.info(inflightLine)
      try {
        const fs = await import('node:fs')
        const dir = config.dshHome || process.env.DSH_HOME || ''
        if (dir) fs.appendFileSync(join(dir, '.plugin-manager-events.log'), '[' + new Date().toISOString() + '] ' + inflightLine + '\n')
      } catch { /* 证据行落盘失败不阻断重启判定 */ }
      if ((inflight.length > 0 || inflightDirs.length > 0) && args.force !== true) {
        const why = [describeInFlight(inflight), describeInFlightSessions(inflightDirs)].filter((s) => s !== '').join('；')
        return {
          ok: false,
          error: '重启被拒绝：' + why + '。它们与 web **同进程**，重启会直接斩断且**无法恢复**（不是 teammate、不是 job、也没有完成通知）。请等它们收工；确要立刻重启请传 force: true（后果：这些分身的工作会丢失）。',
        }
      }
      const dshHome = config.dshHome || process.env.DSH_HOME || ''
      // 【触发者绑定 · 主人 2026-09-14】唤醒目标 = **发起本次重启的那个会话**（exec.agent），
      // 不再用 resolveActiveSessionId 猜「活跃会话」——猜错就把提醒投到别的会话（实测 2026-09-14：
      // A 会话触发、提醒落到 B 会话，A 永远收不到）。2026-09-05 容错保留：解析失败不得阻断写哨兵。
      const callerSid = caller.sessionId
      const useCaller = typeof callerSid === 'string' && callerSid.startsWith('session-')
      let sid: string | undefined
      let sidSource: string
      if (useCaller) {
        sid = callerSid
        sidSource = 'caller'
      } else {
        try {
          sid = resolveActiveSessionId(ctx, config.mainSessionId) ?? undefined
          sidSource = 'fallback-active(无调用者或非用户会话)'
        } catch {
          sid = undefined
          sidSource = 'unavailable'
        }
      }
      const file = writeSentinel(dshHome, {
        workspace: config.defaultWorkspace || process.cwd(),
        sessionId: sid,
        note: 'daemon_restart: ' + args.reason.trim() + (args.profile ? ' @' + args.profile : '') + ' | trigger=' + sidSource,
      })
      try {
        const fs = await import('node:fs')
        fs.appendFileSync(join(dshHome, '.plugin-manager-events.log'), '[' + new Date().toISOString() + '] daemon_restart: ' + args.reason.trim() + ' -> ' + file + '\n')
      } catch { /* 忽略 */ }
      return { ok: true, note: '哨兵已写，守护将预检并重启 web（' + args.reason.trim() + '）' }
    },
  }))

  logger.info('dsh-agent-plugin-manager 就绪')
}
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
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
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
  filterArchives,
  isValidPluginName,
  loaderSnapshotOf,
  pickActiveSessionId,
  pluginListLines,
  publicArchive,
  scaffoldSource,
  thirdPartyRefusal,
  type LifecycleAction,
  type SessionListItem,
} from './ops-logic.ts'
import { appendLineSafe, formatEventLine } from './event-log.ts'
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
  configure(name: string, profile: string, cfg: Record<string, unknown>, caller?: CallerInfo | null): Promise<{ ok: boolean; error?: string; note?: string }>
  create(name: string, description: string): { ok: boolean; error?: string; dir?: string }
}
// 脚手架模板实现见 ops-logic.ts（scaffoldSource，纯字符串生成，可离线单测）。

// 目标会话解析：不绑定固定会话——追踪最新活跃主会话（delegationDepth===0 且最后事件 time 最大）；
// 显式配置 mainSessionId 时仍尊重锁定（兼容旧行为，写入哨兵供 watch 唤醒）。
// 判据本体 = pickActiveSessionId（ops-logic.ts，纯函数：会话列表由调用方注入）。
function resolveActiveSessionId(ctx: Context, mainSessionId: string): string | null {
  const list = (ctx as Context & { sessions?: { list(): SessionListItem[] } }).sessions?.list() ?? []
  return pickActiveSessionId(list, mainSessionId)
}

export function createOps(ctx: Context, config: Config, loader: { entries(): Iterable<{ options: { name?: string }; disabled?: boolean }> }): PluginManagerOps {
  const logger = ctx.logger('plugin-manager')
  const require = createRequire(import.meta.url)
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
    const r2 = patchInsert(profileDir, 'agent-' + nm.replace(/^dsh-/, ''), nm, cfg)
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
          peerDependencies: { '@deepseek-ai/cordis': '^4.0.1', '@deepseek-ai/schemastery': '^3.18.1-rc.1', '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' },
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
        eventLog('创建插件 ' + nm + ' @ ' + dir)
        return { ok: true, dir }
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
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, dir: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? '已创建: ' + v.dir : (v.error ?? '') }] },
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
    description: '重启 web 守护服务（哨兵协议：预检 → kill+重启 → 唤醒 → 清哨兵）。爱丽丝自主决策用：内存回收/状态清理/任意原因；reason 必填留痕。不改组合，组合预检由守护 v2.3 门控兜底（失败不 kill 旧 web）。重启前检查**本 web 进程内**是否调用过预检工具（preflight_check）——未调用则拒绝（进程级判据，§5.11 §3）。',
    parameters: {
      reason: { type: 'string', required: true, description: '重启原因（决策记录，记入日志）' },
      profile: { type: 'string', description: '目标 profile（默认 web）' }
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, note: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? (v.note ?? 'ok') : (v.error ?? '') }] },
    async execute(args: { reason: string; profile?: string }, exec) {
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
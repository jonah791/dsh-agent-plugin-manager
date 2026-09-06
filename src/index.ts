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
import { patchInsert, patchRemove, patchSetDisabled, patchSetConfig, packageAddLinkDep, packageRemoveDep, installProfile, preflight, rollbackFile } from './profile.ts'
import { writeSentinel } from './sentinel.ts'

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
          if (existsSync(lib) && statSync(lib).mtimeMs > webStartMs + 1000) {
            return true
          }
        } catch { /* 单插件不可读跳过 */ }
      }
    }
    return false
  } catch {
    return true // 异常保守：走完整试运行
  }
}

export function publicArchive(a: PluginArchive) {
  return JSON.parse(JSON.stringify({
    name: a.name, version: a.version, source: a.source,
    purpose: a.purpose, category: a.category, client: a.client,
    tools: a.tools, built: a.built,
    status: a.status, profiles: a.profiles, config: a.config,
  }))
}

export interface PluginManagerOps {
  list(): PluginArchive[]
  inspect(name: string): PluginArchive | null
  mount(name: string, profile: string, cfg?: Record<string, unknown>): Promise<{ ok: boolean; error?: string; note?: string }>
  setEnabled(name: string, profile: string, enabled: boolean): Promise<{ ok: boolean; error?: string; note?: string; bak?: string }>
  remove(name: string, profile: string): Promise<{ ok: boolean; error?: string; note?: string }>
  configure(name: string, profile: string, cfg: Record<string, unknown>): Promise<{ ok: boolean; error?: string; note?: string }>
  create(name: string, description: string): { ok: boolean; error?: string; dir?: string }
}
function scaffoldSource(name: string, description: string): string {
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

// 目标会话解析：不绑定固定会话——追踪最新活跃主会话（delegationDepth===0 且最后事件 time 最大）；
// 显式配置 mainSessionId 时仍尊重锁定（兼容旧行为，写入哨兵供 watch 唤醒）。
function resolveActiveSessionId(ctx: Context, mainSessionId: string): string | null {
  if (mainSessionId) return mainSessionId
  let best: { id: string; time: number } | null = null
  for (const s of (ctx as Context & { sessions?: { list(): { id: string; header?: { delegationDepth?: number }; events: { time: number }[] }[] } }).sessions?.list() ?? []) {
    if ((s.header?.delegationDepth ?? 0) !== 0) continue
    // 2026-09-05 防御：DSH 升级后部分 session 的 events 可能缺失（undefined）——不能直接 .length
    const events = s.events ?? []
    const lastTime = events.length > 0 ? (events[events.length - 1]?.time ?? 0) : 0
    if (best === null || lastTime > best.time) best = { id: s.id, time: lastTime }
  }
  return best?.id ?? null
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
    try {
      const fs = require('node:fs')
      fs.appendFileSync(join(dshHome || process.cwd(), '.plugin-manager-events.log'), '[' + new Date().toISOString() + '] ' + msg + '\n')
    } catch { /* 忽略 */ }
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

  const triggerReload = (note: string) => {
    const file = writeSentinel(dshHome, { workspace, sessionId: resolveActiveSessionId(ctx, config.mainSessionId) ?? undefined, note })
    eventLog('哨兵已写: ' + file + ' | ' + note)
  }

  const mount = async (nm: string, profile: string, cfg?: Record<string, unknown>) => {
    const arch = findArchive(nm)
    if (!arch) return { ok: false, error: '插件不存在: ' + nm }
    if (arch.source === 'official') return { ok: false, error: '官方 bundle 无需挂载（bundles 列表自带）' }
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
    triggerReload('plugin_mount ' + nm + '@' + profile)
    eventLog('挂载 ' + nm + '@' + profile + ' 完成')
    return { ok: true, note: '已挂载 ' + nm + '@' + profile + '；哨兵已写，web 将重启生效' }
  }

  const loaderSnapshot = (): Array<{ name: string; enabled: boolean }> => {
    try {
      const out: Array<{ name: string; enabled: boolean }> = []
      for (const entry of loader.entries()) {
        const n = entry.options?.name
        if (typeof n === 'string' && n) out.push({ name: n, enabled: entry.disabled !== true })
      }
      return out
    } catch { return [] }
  }

  return {
    list() { return alignWithLoader(buildRegistry(selfPluginsDir, profilesDir), loaderSnapshot()) },
    inspect(nm) { return findArchive(nm) },
    mount,

    async setEnabled(nm, profile, enabled) {
      const arch = findArchive(nm)
      if (!arch) return { ok: false, error: '插件不存在: ' + nm }
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
      triggerReload('plugin_' + (enabled ? 'start' : 'stop') + ' ' + nm + '@' + profile)
      eventLog((enabled ? '启动' : '停用') + ' ' + nm + '@' + profile + ' 完成')
      return { ok: true, note: (enabled ? '已启用' : '已停用') + ' ' + nm + '@' + profile + '；哨兵已写，web 将重启生效' }
    },

    async remove(nm, profile) {
      const arch = findArchive(nm)
      if (!arch) return { ok: false, error: '插件不存在: ' + nm }
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
      triggerReload('plugin_remove ' + nm + '@' + profile)
      eventLog('卸载 ' + nm + '@' + profile + ' 完成（数据目录保留）')
      return { ok: true, note: '已卸载 ' + nm + '@' + profile + '；数据目录保留；哨兵已写，web 将重启生效' }
    },

    async configure(nm, profile, cfg) {
      const arch = findArchive(nm)
      if (!arch) return { ok: false, error: '插件不存在: ' + nm }
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
      triggerReload('plugin_configure ' + nm + '@' + profile)
      eventLog('配置更新 ' + nm + '@' + profile + '：' + JSON.stringify(cfg).slice(0, 200))
      return { ok: true, note: '配置已更新；哨兵已写，web 将重启生效' }
    },

    create(nm, description) {
      if (!/^[a-z][a-z0-9-]*$/.test(nm)) return { ok: false, error: '插件名须为小写字母开头，仅 [a-z0-9-]' }
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
  const recordPreflightInvoked = (pass: boolean, mode: string): void => {
    // 2026-09-05 修复：会话解析失败（cordis 严格代理下 ctx.sessions 访问抛错）不得阻断写盘——
    // 原实现把 resolveActiveSessionId 与 writeFileSync 放在同一 try，解析抛错则记录从未落盘，
    // preflight_check 却返回「已记录」，导致 daemon_restart 门控误判「非本会话调用」。
    let sid: string | null = null
    try { sid = resolveActiveSessionId(ctx, config.mainSessionId) ?? null } catch { sid = null }
    try {
      writeFileSync(invokedFile, JSON.stringify({
        at: new Date().toISOString(), atMs: Date.now(),
        workspace: config.defaultWorkspace || process.cwd(),
        sessionId: sid, pass, mode,
      }, null, 2), 'utf8')
    } catch (e) { logger.warn('预检记录落盘失败: ' + String(e)) }
  }
  const preflightInvokedThisSession = (): { ok: boolean; reason?: string } => {
    try {
      if (!existsSync(invokedFile)) {
        return { ok: false, reason: '本会话未调用过预检工具（preflight_check）' }
      }
      const rec = JSON.parse(readFileSync(invokedFile, 'utf8')) as { atMs?: number; workspace?: string; pass?: boolean }
      if (typeof rec.atMs !== 'number') return { ok: false, reason: '预检记录无效（缺 atMs）' }
      if (rec.workspace !== (config.defaultWorkspace || process.cwd())) {
        return { ok: false, reason: '预检记录 workspace 不匹配（记录=' + rec.workspace + '）' }
      }
      if (rec.atMs < webStartMs) {
        return { ok: false, reason: '预检记录早于本次 web 启动（非本会话调用，请先重新调用 preflight_check）' }
      }
      if (rec.pass !== true) {
        return { ok: false, reason: '本会话最近一次预检未通过——重启会被拒绝，请先修复后重新 preflight_check' }
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: '读取预检记录失败: ' + String(e) }
    }
  }

  ctx.tools.register(defineTool({
    name: 'plugin_list',
    description: '列出全部插件档案（来源/版本/用途/工具/挂载状态/配置摘要）——按「自研 / 官方 / 非官方」分组。可选按来源/状态过滤。',
    parameters: {
      source: { type: 'string', enum: ['self', 'official', 'third-party'], description: '来源过滤（self=自研, official=官方, third-party=非官方）' },
      status: { type: 'string', enum: ['mounted', 'disabled', 'unmounted'], description: '状态过滤' }
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { count: { type: 'number', required: true }, plugins: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } } } }, render: (_a: any, v: any) => {
      const groupMeta: Record<string, { title: string; order: number }> = {
        self: { title: '▸ 自研', order: 0 },
        official: { title: '▸ 官方', order: 1 },
        'third-party': { title: '▸ 非官方（第三方）', order: 2 },
      }
      const groups = new Map<string, any[]>()
      for (const p of v.plugins) {
        const key = p.source in groupMeta ? p.source : 'third-party'
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(p)
      }
      const lines: string[] = []
      for (const [key, list] of [...groups.entries()].sort((a, b) => (groupMeta[a[0]]?.order ?? 99) - (groupMeta[b[0]]?.order ?? 99))) {
        lines.push((groupMeta[key]?.title ?? key) + '（' + list.length + '）')
        for (const p of list) {
          lines.push('  • ' + p.name + ' ' + p.version + ' [' + p.status + ']' + (p.built ? '' : ' 未构建') + (p.purpose ? ' — ' + p.purpose : '') + (p.tools.length ? '\n      工具: ' + p.tools.join(', ') : '') + (p.profiles.length ? '\n      挂载: ' + p.profiles.join(', ') : ''))
        }
      }
      return [{ type: 'text', text: lines.join('\n') }]
    } },
    async execute(args: { source?: string; status?: string }) {
      let plugins = ops.list()
      if (args.source) plugins = plugins.filter((p) => p.source === args.source)
      if (args.status) plugins = plugins.filter((p) => p.status === args.status)
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
    async execute(args: { name: string; profile?: string; config?: Record<string, unknown> }) {
      return ops.mount(args.name, args.profile || 'web', args.config)
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
    async execute(args: { name: string; profile?: string }) {
      return ops.remove(args.name, args.profile || 'web')
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
      async execute(args: { name: string; profile?: string }) {
        return ops.setEnabled(args.name, args.profile || 'web', enabled)
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
    async execute(args: { name: string; profile?: string; config: Record<string, unknown> }) {
      return ops.configure(args.name, args.profile || 'web', args.config)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'preflight_check',
    description: '预检工具：执行组合试运行预检并落盘「本会话已调用预检」记录（.preflight-invoked.json）。重启（daemon_restart）前必须先调用本工具且预检通过——否则重启会被拒绝。mode=full 完整试运行（~20s），quick 快速（~8s）。',
    parameters: {
      mode: { type: 'string', enum: ['full', 'quick'], description: '预检模式（默认 full）' },
      profile: { type: 'string', description: '目标 profile（默认 web）' }
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, pass: { type: 'boolean' }, note: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? (v.pass ? '预检通过，已记录（可重启）' : '预检未通过（已记录，重启将被拒绝）：' + (v.note ?? '')) : (v.error ?? '') }] },
    async execute(args: { mode?: string; profile?: string }) {
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
      recordPreflightInvoked(pr.pass, mode)
      return { ok: true, pass: pr.pass, note: (mode + ' 预检 ' + (pr.pass ? 'PASS' : 'FAIL') + (pr.pass ? '' : '\n' + pr.detail.slice(0, 600))) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'daemon_restart',
    description: '重启 web 守护服务（哨兵协议：预检 → kill+重启 → 唤醒 → 清哨兵）。爱丽丝自主决策用：内存回收/状态清理/任意原因；reason 必填留痕。不改组合，组合预检由守护 v2.3 门控兜底（失败不 kill 旧 web）。重启前会检查本会话是否调用过预检工具（preflight_check）——未调用则拒绝。',
    parameters: {
      reason: { type: 'string', required: true, description: '重启原因（决策记录，记入日志）' },
      profile: { type: 'string', description: '目标 profile（默认 web）' }
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, note: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? (v.note ?? 'ok') : (v.error ?? '') }] },
    async execute(args: { reason: string; profile?: string }) {
      if (!args.reason || !args.reason.trim()) return { ok: false, error: 'reason 必填（重启是自主决策，必须留痕）' }
      // 【重启前预检校验 · 主人 2026-08-30】本会话必须调用过预检工具且通过，否则拒绝重启
      const gate = preflightInvokedThisSession()
      if (!gate.ok) {
        return { ok: false, error: '重启被拒绝：' + gate.reason + '。请先调用 preflight_check 预检工具（通过后）再重启。' }
      }
      const dshHome = config.dshHome || process.env.DSH_HOME || ''
      // 2026-09-05 容错：会话解析失败（events 缺失/代理抛错）不得阻断写哨兵
      let sid: string | undefined
      try { sid = resolveActiveSessionId(ctx, config.mainSessionId) ?? undefined } catch { sid = undefined }
      const file = writeSentinel(dshHome, {
        workspace: config.defaultWorkspace || process.cwd(),
        sessionId: sid,
        note: 'daemon_restart: ' + args.reason.trim() + (args.profile ? ' @' + args.profile : ''),
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
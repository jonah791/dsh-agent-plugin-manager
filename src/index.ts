/**
 * dsh-agent-plugin-manager：插件管理器。
 *
 * 用途（主人定调）：① 插件清单与用途认知（档案库：来源/版本/用途/工具/配置/状态）
 * ② 生命周期管理：创建（脚手架）/启停/删除/改配置——host 工具面给爱丽丝，
 * client 以「插件管理」tab 挂在官方设置页的 Plugins 页面。
 *
 * 安全：每次 profile 文件修改先备份；哨兵触发前沙盒预检（失败回滚不重启）；
 * 卸载保留插件数据目录。与 dsh-agent-watch 分工：watch 管进程，本插件管插件。
 * @module dsh-agent-plugin-manager
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
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
    const events = s.events
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

  const findArchive = (nm: string): PluginArchive | null =>
    buildRegistry(selfPluginsDir, profilesDir).find((a) => a.name === nm) ?? null

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
      const pass = await preflight(bin, profile, workspace)
      if (!pass) {
        if (r2.bak) rollbackFile(join(profileDir, 'cordis.patch.yml'), r2.bak)
        if (r1.bak) rollbackFile(join(profileDir, 'package.json'), r1.bak)
        return { ok: false, error: '预检失败，已回滚（组合无法加载）' }
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
        const pass = await preflight(bin, profile, workspace)
        if (!pass) {
          if (r.bak) rollbackFile(join(profileDir, 'cordis.patch.yml'), r.bak)
          eventLog('启停预检失败已回滚: ' + nm)
          return { ok: false, error: '预检失败，已回滚（组合无法加载）' }
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
        const pass = await preflight(bin, profile, workspace)
        if (!pass) {
          if (r.bak) rollbackFile(join(profileDir, 'cordis.patch.yml'), r.bak)
          if (depBak) rollbackFile(join(profileDir, 'package.json'), depBak)
          eventLog('卸载预检失败已回滚: ' + nm)
          return { ok: false, error: '预检失败，已回滚（组合无法加载）' }
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
        const pass = await preflight(bin, profile, workspace)
        if (!pass) {
          if (r.bak) rollbackFile(join(profileDir, 'cordis.patch.yml'), r.bak)
          return { ok: false, error: '预检失败，已回滚' }
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
  const ops = createOps(ctx, config, ctx.loader)
  ctx.plugin(PluginManagerRemoteService, ops)

  ctx.tools.register(defineTool({
    name: 'plugin_list',
    description: '列出全部插件档案（来源/版本/用途/工具/挂载状态/配置摘要）——查看有哪些自研或官方插件、各自用途。可选按来源/状态过滤。',
    parameters: {
      source: { type: 'string', enum: ['self', 'official'], description: '来源过滤' },
      status: { type: 'string', enum: ['mounted', 'disabled', 'unmounted'], description: '状态过滤' }
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { count: { type: 'number', required: true }, plugins: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.plugins.map((p: any) => '• ' + p.name + ' ' + p.version + ' [' + p.source + '/' + p.status + ']' + (p.built ? '' : ' 未构建') + '\n  ' + p.purpose + (p.tools.length ? '\n  工具: ' + p.tools.join(', ') : '') + (p.profiles.length ? '\n  挂载: ' + p.profiles.join(', ') : '')).join('\n') }] },
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
    name: 'daemon_restart',
    description: '重启 web 守护服务（哨兵协议：预检 → kill+重启 → 唤醒 → 清哨兵）。爱丽丝自主决策用：内存回收/状态清理/任意原因；reason 必填留痕。不改组合，组合预检由守护 v2.3 门控兜底（失败不 kill 旧 web）。',
    parameters: {
      reason: { type: 'string', required: true, description: '重启原因（决策记录，记入日志）' },
      profile: { type: 'string', description: '目标 profile（默认 web）' }
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, note: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? (v.note ?? 'ok') : (v.error ?? '') }] },
    async execute(args: { reason: string; profile?: string }) {
      if (!args.reason || !args.reason.trim()) return { ok: false, error: 'reason 必填（重启是自主决策，必须留痕）' }
      const dshHome = config.dshHome || process.env.DSH_HOME || ''
      const file = writeSentinel(dshHome, {
        workspace: config.defaultWorkspace || process.cwd(),
        sessionId: resolveActiveSessionId(ctx, config.mainSessionId) ?? undefined,
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
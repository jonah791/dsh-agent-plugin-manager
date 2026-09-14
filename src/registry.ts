/**
 * 插件档案库：扫描 self-plugins + 官方 bundle，与 profile patch 对账，
 * 生成每个插件的档案（用途/工具/构建状态/挂载状态/配置摘要）。
 * 纯函数模块（可单测）；文件系统路径全部由调用方传入。
 * @module dsh-agent-plugin-manager/registry
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import yaml from 'js-yaml'

export type PluginSource = 'self' | 'official' | 'third-party'
export type PluginStatus = 'mounted' | 'disabled' | 'unmounted'

/**
 * 来源分组（主人 2026-08-27 定调：自研 / 非自研，非自研下分官方 / 非官方）：
 * - self = 自研（self-plugins 目录）
 * - official = 非自研·官方（@deepseek-ai/*）
 * - third-party = 非自研·非官方（link 到 self-plugins 之外目录的第三方插件，如 dsh-agent-teams @ _tmp_review）
 */

export interface PluginArchive {
  name: string
  version: string
  source: PluginSource
  /** self 插件目录（official 为 null）。 */
  path: string | null
  /** 一句话用途（package.json.description → README 首段；官方用目录数据的中文简介）。 */
  purpose: string
  /** 功能类别（core/client-ui/tool/storage/...；官方来自目录数据）。 */
  category: string
  /** 是否 client 插件（浏览器端）。 */
  client: boolean
  /** 暴露的工具名列表（源码 defineTool 提取）。 */
  tools: string[]
  /** lib 产物是否新于 src。 */
  built: boolean
  status: PluginStatus
  /** 挂载的 profile 列表。 */
  profiles: string[]
  /** patch 中的配置快照。 */
  config: Record<string, unknown>
  updatedAt: string
  /** 第三方专用：是否以 bundle 形态挂载（列在 profile 的 `dsh.profile.bundles`）。 */
  bundle?: boolean
  /** 第三方专用：依赖声明原文（含 pin；**已脱敏**）——升级/回退靠它。 */
  spec?: string
}

/**
 * 依赖声明的档位（纯函数判定；`third-party-*` 四档 = 非自研、非官方）。
 *
 * 2026-09-14 修（主人「我安装了一个第三方插件」暴露的仪器缺陷）：
 * 原实现只认 **`link:` 形态**的第三方（`spec.startsWith('link:')` 之外一律 `continue`），
 * 于是 `github:owner/repo#commit` 这类 **git pin / bundle 形态**的第三方被整条跳过——
 * 「非自研插件」的盘点因此不完整。现在四种安装形态都认。
 */
export type DepKind =
  | 'self-link'            // link: → self-plugins/<name>
  | 'local-link'           // link: → 其他本地路径
  | 'official'             // @deepseek-ai/*
  | 'third-party-git'      // github:owner/repo#ref / git+ / git@ / *.git
  | 'third-party-tarball'  // https://…/tar.gz#<sha>
  | 'third-party-local'    // file:
  | 'third-party-registry' // 版本号（npm registry）

export function classifyDependency(name: string, spec: string): DepKind {
  const s = spec.trim()
  if (name.startsWith('@deepseek-ai/')) return 'official'
  if (s.startsWith('link:')) return /(^|[\\/])self-plugins[\\/]/.test(s) ? 'self-link' : 'local-link'
  if (s.startsWith('file:')) return 'third-party-local'
  if (s.startsWith('github:') || s.startsWith('git+') || s.startsWith('git:') || s.startsWith('git@')) return 'third-party-git'
  if (/^https?:\/\//i.test(s)) return /\.git(#|$)/i.test(s) ? 'third-party-git' : 'third-party-tarball'
  return 'third-party-registry'
}

export function isThirdPartyDep(kind: DepKind): boolean {
  return kind.startsWith('third-party-')
}

/** 脱敏依赖声明（URL userinfo / token 类参数不落盘；pin 本身必须留）。 */
export function redactSpec(spec: string): string {
  return spec
    .replace(/\/\/[^/@\s]+@/g, '//')
    .replace(/([?&](?:token|access_token|auth|api_?key|password|secret)=)[^&\s]+/gi, '$1[redacted]')
}

/** patch 中的一行插件（id/name/disabled/config）。 */
export interface PatchRow {
  id: string
  name?: string
  disabled?: boolean
  config?: Record<string, unknown>
}

/** 解析 cordis.patch.yml 文本 → 插件行列表（js-yaml；失败回退文本扫描）。 */
export function parsePatchRows(patchText: string): PatchRow[] {
  const rows: PatchRow[] = []
  try {
    const doc = yaml.load(patchText)
    if (Array.isArray(doc)) {
      for (const entry of doc) {
        if (!entry || typeof entry !== 'object') continue
        const e = entry as Record<string, unknown>
        if (Array.isArray(e.insert)) {
          for (const it of e.insert as Array<Record<string, unknown>>) {
            if (it && typeof it.id === 'string') {
              rows.push({
                id: it.id,
                name: typeof it.name === 'string' ? it.name : undefined,
                disabled: it.disabled === true,
                config: it.config && typeof it.config === 'object' ? it.config as Record<string, unknown> : undefined,
              })
            }
          }
        } else if (typeof e.id === 'string') {
          rows.push({
            id: e.id,
            name: typeof e.name === 'string' ? e.name : undefined,
            disabled: e.disabled === true,
            config: e.config && typeof e.config === 'object' ? e.config as Record<string, unknown> : undefined,
          })
        }
      }
    }
  } catch { /* 回退文本扫描 */ }
  if (rows.length === 0) {
    for (const line of patchText.split(/\r?\n/)) {
      const m = line.match(/^\s*- id:\s*([\w@./-]+)/)
      if (m && m[1]) rows.push({ id: m[1] })
    }
  }
  return rows
}

/** 递归收集 src/ 与 lib/ 下的源码文件（工具可拆分到任意文件，如 lib/tools.js、src/pruner.ts）。 */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    let entries: string[] = []
    try { entries = readdirSync(d) } catch { return }
    for (const e of entries) {
      if (e.startsWith('.')) continue
      const p = join(d, e)
      try {
        if (statSync(p).isDirectory()) {
          // 只进 src/ 与 lib/（node_modules 等噪音不进）
          if (e === 'src' || e === 'lib' || (d.endsWith('src') || d.endsWith('lib'))) walk(p)
        } else if (e.endsWith('.ts') || e.endsWith('.js') || e.endsWith('.mjs')) {
          out.push(p)
        }
      } catch { /* 跳过 */ }
    }
  }
  walk(dir)
  return out
}

/** 判断 text 中 index 位置是否处于注释行（行首 * / // / /*，覆盖文档注释与行注释的 name 示例）。 */
function isCommentLine(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1
  const line = text.slice(lineStart, index)
  const trimmed = line.trim()
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')
}

/** 从源码提取 defineTool 注册的工具名。
 * 覆盖三种注册形态（2026-09-06 审查修复，见记忆 b6ffdb64）：
 *  1. 直接字面量：defineTool({ name: 'xxx' })——单/双引号均支持（原只匹配单引号，vision 双引号漏）
 *  2. 工厂/变量模式：defineTool(tool) + reg({ name: 'xxx' })——文件含 defineTool(变量) 时，
 *     额外收集该文件所有 name: 'xxx'（排除 export const name = 插件名行；blue-team/red-team 等 6 插件）
 *  3. 工具拆到其他文件：递归扫 src/ 与 lib/ 全部 .ts/.js（memory→lib/tools.js、context→src/pruner.ts）
 */
export function extractTools(dir: string): string[] {
  const tools: string[] = []
  for (const p of collectSourceFiles(dir)) {
    let text = ''
    try { text = readFileSync(p, 'utf8') } catch { continue }
    // 形态 1：直接字面量（单双引号）
    const re = /defineTool\s*\(\s*\{[\s\S]{0,500}?name:\s*['"]([a-zA-Z_][\w]*)['"]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      if (m[1] && !tools.includes(m[1]) && !isCommentLine(text, m.index)) tools.push(m[1])
    }
    // 形态 2：工厂/变量模式（defineTool(某标识符) 而非 {）
    if (/defineTool\s*\(\s*[a-zA-Z_$]/.test(text)) {
      const re2 = /name:\s*['"]([a-zA-Z_][\w]*)['"]/g
      while ((m = re2.exec(text))) {
        if (!m[1] || tools.includes(m[1])) continue
        if (isCommentLine(text, m.index)) continue // 注释里的 name 示例（如本文档注释）
        const lineStart = text.lastIndexOf('\n', m.index) + 1
        const line = text.slice(lineStart, m.index)
        if (/export\s+const\s+name\b|const\s+name\s*=/.test(line)) continue // 插件名（如 export const name = 'agent-xxx'）
        tools.push(m[1])
      }
    }
  }
  return tools.sort()
}

/** 用途摘要：package.json.description → README 首个非标题段。 */
export function extractPurpose(dir: string, fallback = ''): string {
  const pkgPath = join(dir, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { description?: unknown }
      if (typeof pkg.description === 'string' && pkg.description.trim()) return pkg.description.trim()
    } catch { /* 忽略 */ }
  }
  const readmePath = join(dir, 'README.md')
  if (existsSync(readmePath)) {
    try {
      const text = readFileSync(readmePath, 'utf8')
      const first = text.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#'))
      if (first) return first.trim().slice(0, 200)
    } catch { /* 忽略 */ }
  }
  return fallback
}

/** lib 是否已构建且不旧于 src（src 不存在时视为已构建）。 */
export function isBuilt(dir: string): boolean {
  const lib = join(dir, 'lib')
  if (!existsSync(lib)) return false
  const src = join(dir, 'src')
  if (!existsSync(src)) return true
  let libNewest = 0
  let srcNewest = 0
  const walk = (d: string, cb: (t: number) => void) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      const st = statSync(p)
      if (st.isDirectory()) walk(p, cb)
      else cb(st.mtimeMs)
    }
  }
  try { walk(lib, (t) => { if (t > libNewest) libNewest = t }) } catch { return false }
  try { walk(src, (t) => { if (t > srcNewest) srcNewest = t }) } catch { /* 忽略 */ }
  return libNewest >= srcNewest
}

/** 读取目录下所有含 package.json 的插件目录。 */
export function listPluginDirs(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    try {
      if (statSync(p).isDirectory() && existsSync(join(p, 'package.json'))) out.push(name)
    } catch { /* 跳过 */ }
  }
  return out.sort()
}

/** 扫描 self-plugins → 基础档案（未对账状态）。 */
export function scanSelfPlugins(selfPluginsDir: string): PluginArchive[] {
  const out: PluginArchive[] = []
  for (const name of listPluginDirs(selfPluginsDir)) {
    const p = join(selfPluginsDir, name)
    try {
      const pkg = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
      out.push({
        name: typeof pkg.name === 'string' ? pkg.name : name,
        version: typeof pkg.version === 'string' ? pkg.version : '',
        source: 'self',
        path: p,
        purpose: extractPurpose(p),
        category: '',
        client: false,
        tools: extractTools(p),
        built: isBuilt(p),
        status: 'unmounted',
        profiles: [],
        config: {},
        updatedAt: new Date().toISOString(),
      })
    } catch { /* 跳过坏包 */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 读取 profile 的 cordis.patch.yml 文本（不存在返回 ''）。 */
export function readPatch(profileDir: string): string {
  try { return readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8') } catch { return '' }
}

/** 读取 profile 的 package.json（不存在返回 null）。 */
export function readProfilePackage(profileDir: string): { name?: string; dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } } | null {
  try { return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) } catch { return null }
}

export interface ProfilePatchInfo {
  profile: string
  rows: PatchRow[]
  bundles: string[]
}

/** 扫描 profiles 目录 → 各 profile 的 patch 行 + bundles。 */
export function listProfiles(profilesDir: string): ProfilePatchInfo[] {
  if (!existsSync(profilesDir)) return []
  const out: ProfilePatchInfo[] = []
  for (const name of readdirSync(profilesDir)) {
    const dir = join(profilesDir, name)
    try {
      if (!statSync(dir).isDirectory()) continue
      if (!existsSync(join(dir, 'cordis.patch.yml'))) continue
      const pkg = readProfilePackage(dir)
      out.push({
        profile: name,
        rows: parsePatchRows(readPatch(dir)),
        bundles: pkg?.dsh?.profile?.bundles ?? [],
      })
    } catch { /* 跳过 */ }
  }
  return out.sort((a, b) => a.profile.localeCompare(b.profile))
}

/** 官方 bundle 档案（从 profiles 的 bundles 列表提取；只读元数据）。 */
export function scanOfficialBundles(profilesDir: string): PluginArchive[] {
  const map = new Map<string, PluginArchive>()
  for (const info of listProfiles(profilesDir)) {
    for (const bundle of info.bundles) {
      if (!bundle.startsWith('@deepseek-ai/')) continue
      const existing = map.get(bundle)
      const row = info.rows.find((r) => r.name === bundle || r.id === bundle)
      const archive: PluginArchive = existing ?? {
        name: bundle,
        version: '',
        source: 'official',
        path: null,
        purpose: '',
        category: '',
        client: false,
        tools: [],
        built: true,
        status: 'unmounted',
        profiles: [],
        config: {},
        updatedAt: new Date().toISOString(),
      }
      // 版本/用途从 profile node_modules 的 package.json 取
      const pkgPath = join(profilesDir, info.profile, 'node_modules', bundle.replace('/', '/'), 'package.json')
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown; description?: unknown }
          if (!archive.version && typeof pkg.version === 'string') archive.version = pkg.version
          if (!archive.purpose && typeof pkg.description === 'string') archive.purpose = pkg.description
        } catch { /* 忽略 */ }
      }
      if (row) {
        archive.status = row.disabled ? 'disabled' : 'mounted'
        if (!archive.profiles.includes(info.profile)) archive.profiles.push(info.profile)
        if (row.config) archive.config = { ...archive.config, ...row.config }
      } else if (!existing) {
        // bundles 列表自带 = 已挂载（无 patch 行）
        archive.status = 'mounted'
        archive.profiles = [info.profile]
      }
      map.set(bundle, archive)
    }
    // patch 中出现的官方 name 行（不在 bundles 里也记录）
    for (const row of info.rows) {
      if (row.name && row.name.startsWith('@deepseek-ai/') && !map.has(row.name)) {
        map.set(row.name, {
          name: row.name,
          version: '',
          source: 'official',
          path: null,
          purpose: '',
          category: '',
          client: false,
          tools: [],
          built: true,
          status: row.disabled ? 'disabled' : 'mounted',
          profiles: [info.profile],
          config: row.config ?? {},
          updatedAt: new Date().toISOString(),
        })
      }
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 非官方第三方插件档案（主人 2026-08-27：非自研下分官方/非官方）。
 * 扫描各 profile 的 link: 依赖——目标不在 self-plugins 目录且包名非 @deepseek-ai/ 前缀 = 第三方
 * （如 dsh-agent-teams @ E:/alice/_tmp_review/）。从 link 目标读 package.json 元数据。
 */
export function scanThirdParty(profilesDir: string, selfPluginsDir: string): PluginArchive[] {
  const map = new Map<string, PluginArchive>()
  const selfReal = resolve(selfPluginsDir)
  // 统一正斜杠比较，避免 Windows 反斜杠分隔符不匹配
  // （2026-08-27 修复：resolve 在 Windows 下产出反斜杠路径，原判断 selfReal+'/' 混分隔符导致
  //   compact/memory 等被误判为第三方）。
  const selfNorm = selfReal.replaceAll('\\', '/')
  for (const info of listProfiles(profilesDir)) {
    const profileDir = join(profilesDir, info.profile)
    const pkg = readProfilePackage(profileDir)
    if (!pkg?.dependencies) continue
    for (const [name, spec] of Object.entries(pkg.dependencies)) {
      if (typeof spec !== 'string') continue
      const kind = classifyDependency(name, spec)
      if (!isThirdPartyDep(kind)) continue
      // 落点解析：link: → 目标目录；其余形态（git pin / tarball / registry / file）→ 装在该 profile 的 node_modules 下
      const isLink = spec.startsWith('link:')
      const target = isLink ? resolve(spec.slice(5).replaceAll('\\', '/')) : join(profileDir, 'node_modules', name)
      if (isLink) {
        const targetNorm = target.replaceAll('\\', '/')
        if (targetNorm === selfNorm || targetNorm.startsWith(selfNorm + '/')) continue // 自研，跳过
      }
      // bundle 形态 = 自述式挂载（包自带 dsh.bundle.patch，列进 dsh.profile.bundles）
      const bundle = info.bundles.includes(name)
      const row = info.rows.find((r) => r.id === name || r.name === name)
      const mounted = bundle || (row !== undefined && !row.disabled)
      const existing = map.get(name)
      if (existing) {
        if (row !== undefined) {
          existing.status = row.disabled ? 'disabled' : 'mounted'
          if (row.config) existing.config = { ...existing.config, ...row.config }
        } else if (bundle) {
          existing.status = 'mounted'
        }
        if (mounted && !existing.profiles.includes(info.profile)) existing.profiles.push(info.profile)
        continue
      }
      let version = ''
      let purpose = ''
      const pkgPath = join(target, 'package.json')
      if (existsSync(pkgPath)) {
        try {
          const p = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown; description?: unknown }
          if (typeof p.version === 'string') version = p.version
          if (typeof p.description === 'string') purpose = p.description
        } catch { /* 忽略 */ }
      }
      map.set(name, {
        name,
        version,
        source: 'third-party',
        path: target,
        purpose,
        category: 'third-party',
        client: false,
        tools: [],
        built: existsSync(pkgPath),
        status: row?.disabled === true ? 'disabled' : (mounted ? 'mounted' : 'unmounted'),
        profiles: mounted ? [info.profile] : [],
        config: row?.config ?? {},
        updatedAt: new Date().toISOString(),
        bundle,
        spec: redactSpec(spec),
      })
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** 官方插件目录条目（探索数据：中文简介/类别/client/工具）。 */
export interface OfficialCatalogEntry {
  name: string
  group: string
  purpose: string
  category: string
  client: boolean
  tools: string[]
}

/** 读取官方插件目录数据（data/official-plugins.json，探索生成的中文简介全量清单）。 */
export function loadOfficialCatalog(): OfficialCatalogEntry[] {
  const candidates = [
    new URL('../data/official-plugins.json', import.meta.url),
    new URL('../../data/official-plugins.json', import.meta.url),
  ]
  for (const url of candidates) {
    try {
      const text = readFileSync(url, 'utf8')
      const arr = JSON.parse(text) as OfficialCatalogEntry[]
      if (Array.isArray(arr)) return arr.filter((x) => typeof x.name === 'string')
    } catch { /* 下一个候选 */ }
  }
  return []
}

/** 读取系统插件状态（data/system-state.json——来自设置-插件列表的 loader 真实状态）。 */
export function loadSystemState(): Record<string, string> {
  const candidates = [
    new URL('../data/system-state.json', import.meta.url),
    new URL('../../data/system-state.json', import.meta.url),
  ]
  for (const url of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(url, 'utf8')) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') {
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v
        return out
      }
    } catch { /* 下一个候选 */ }
  }
  return {}
}

/** 全量档案：self 扫描 + 对账 + 官方（全量目录 + 挂载状态；系统状态优先对齐）。 */
export function buildRegistry(selfPluginsDir: string, profilesDir: string): PluginArchive[] {
  const profiles = listProfiles(profilesDir)
  const archives = scanSelfPlugins(selfPluginsDir)
  for (const arch of archives) {
    for (const info of profiles) {
      const row = info.rows.find((r) => r.id === arch.name || r.name === arch.name)
      if (row) {
        arch.status = row.disabled ? 'disabled' : 'mounted'
        if (!arch.profiles.includes(info.profile)) arch.profiles.push(info.profile)
        if (row.config) arch.config = { ...arch.config, ...row.config }
      }
    }
  }
  const officialMap = new Map<string, PluginArchive>(scanOfficialBundles(profilesDir).map((a) => [a.name, a]))
  // 官方全量目录（探索数据）：补全未挂载的官方插件 + 中文简介/类别
  for (const c of loadOfficialCatalog()) {
    const existing = officialMap.get(c.name)
    if (existing) {
      if (!existing.purpose) existing.purpose = c.purpose
      existing.category = c.category
      existing.client = c.client
      if (existing.tools.length === 0 && Array.isArray(c.tools)) existing.tools = c.tools
    } else {
      officialMap.set(c.name, {
        name: c.name,
        version: '',
        source: 'official',
        path: null,
        purpose: c.purpose,
        category: c.category,
        client: c.client,
        tools: Array.isArray(c.tools) ? c.tools : [],
        built: true,
        status: 'unmounted',
        profiles: [],
        config: {},
        updatedAt: new Date().toISOString(),
      })
    }
  }
  const systemState = loadSystemState()
  // 非官方第三方（link 到 self-plugins 之外）：主人 2026-08-27 分类（自研/官方/非官方）
  // 2026-08-27 修复：thirdParty 排除已在 self archives 里的包名——其他 profile（如 at-test）的 link
  // 可能指向旧路径（C:/Users/tr/Documents/...），导致 compact/memory 被误判第三方。包名已在自研库 =
  // 自研优先（一个插件只有一个来源归属）。
  const selfNames = new Set(archives.map((a) => a.name))
  const thirdParty = scanThirdParty(profilesDir, selfPluginsDir).filter((a) => !selfNames.has(a.name))
  const all = [...archives, ...officialMap.values(), ...thirdParty]
  for (const arch of all) {
    const st = systemState[arch.name]
    if (st === 'enabled') { arch.status = 'mounted'; if (!arch.profiles.includes('web')) arch.profiles.push('web') }
    else if (st === 'disabled') arch.status = 'disabled'
  }
  return all.sort((a, b) => a.name.localeCompare(b.name))
}

/** Loader 条目（动态系统状态——按包名匹配，无需短 id 映射）。 */
export interface LoaderEntryState {
  name: string
  enabled: boolean
}

/**
 * 用运行时 Loader 状态对齐插件档案（动态：插件启停立即反映，无需静态快照）。
 * 覆盖 buildRegistry 的静态推断（loader 是权威）。
 */
export function alignWithLoader(archives: PluginArchive[], entries: LoaderEntryState[]): PluginArchive[] {
  const byName = new Map<string, boolean>()
  for (const e of entries) if (e.name) byName.set(e.name, e.enabled)
  for (const arch of archives) {
    const enabled = byName.get(arch.name)
    if (enabled === undefined) continue
    if (enabled) {
      arch.status = 'mounted'
      if (!arch.profiles.includes('web')) arch.profiles.push('web')
    } else {
      arch.status = 'disabled'
    }
  }
  return archives
}

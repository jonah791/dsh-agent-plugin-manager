#!/usr/bin/env node
/**
 * scan-plugin-residue —— 插件「退役残留面」扫描器。
 *
 * 为什么存在
 * ----------
 * `plugin_unmount` 只做三件事：删 patch 行、删 profile 依赖、重装依赖。
 * 它**不碰**插件目录、gitlink、语义注册表条目、技能与文档引用、数据目录。
 * ⇒ 一次「退役」要手工清若干处；本脚本把「要清哪些处」变成一次测量。
 *
 * 定位：它是 `plugin_purge`（彻底退役）的**前置件与验收器**——
 *   · 事前：purge 之前先跑它，得到影响面清单（dry-run 的输入）；
 *   · 事后：purge 之后再跑它，判据是「残留面全部归零」。
 *
 * 用法
 *   node scripts/scan-plugin-residue.mjs                 # 从事件日志提取卸载过的插件
 *   node scripts/scan-plugin-residue.mjs a b c           # 指定插件名
 *   node scripts/scan-plugin-residue.mjs --json          # 机器可读输出
 *
 * 口径（**必须与读数同读**）
 *   · 仓库根取自脚本位置的上溯（`self-plugins/<pkg>/scripts/` → 仓库根）
 *   · 「语义表」查的是 registry.json 里 **id 精确等于** `<name去掉 dsh- 前缀>` 的条目，
 *     不是正文提及 ⇒ 正文提及单列为「提及数」以免混淆（2026-10-03 一次误读的教训）
 *   · 技能引用只扫用户级技能目录（`%USERPROFILE%/.agents/skills`），项目级未纳入
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../..')            // self-plugins/<pkg>/scripts → 仓库根
const DSH = process.env.DSH_HOME || join(REPO, '.dsh')
const PROFILE = join(DSH, 'profiles', 'web')

/** 安全读文本；不存在返回空串。 */
function readText(p) {
  try { return readFileSync(p, 'utf8') } catch { return '' }
}

/** 从 plugin-manager 事件日志提取「卸载 <name>@<profile> 完成」的插件名。 */
function unloadedFromLog() {
  const log = readText(join(DSH, '.plugin-manager-events.log'))
  const names = new Set()
  for (const m of log.matchAll(/卸载\s+([a-z0-9-]+)@[a-z0-9-]+\s+完成/g)) names.add(m[1])
  return [...names].sort()
}

/** 主仓中该路径的 git mode（160000=gitlink / 040000=目录 / null=未跟踪）。 */
function gitMode(rel) {
  try {
    const out = execFileSync('git', ['ls-files', '-s', rel], { cwd: REPO, encoding: 'utf8' })
    const first = out.split('\n').find(l => l.trim() !== '')
    return first ? first.split(/\s+/)[0] : null
  } catch { return null }
}

/** 语义注册表里的**条目标题**（id 精确匹配）。 */
function semanticEntry(name) {
  const raw = readText(join(REPO, 'docs', 'semantics', 'registry.json'))
  if (!raw) return { exact: false, mention: 0, id: '', idSource: 'none' }
  let mention = 0
  try {
    const d = JSON.parse(raw)
    const entries = d.entries ?? d
    const list = Array.isArray(entries) ? entries : Object.values(entries)
    // 注册 id 的真源 = 插件语义文档的自述（`| 语义注册 id | xxx |`），**不是**从插件名推导：
    // 2026-10-03 实测教训——dsh-engagement 的自述 id 是 `security-engagement`，
    // 推导出 `engagement` 会误报「漏登记」。读不到自述才回退推导。
    const doc = readText(join(REPO, 'self-plugins', name, 'docs', 'semantic.md'))
    const m = doc.match(/语义注册\s*id\s*\|\s*`?([^`|\n]+)`?/)
    const selfDeclared = m === null ? '' : m[1].trim()
    const id = selfDeclared !== '' ? selfDeclared : name.replace(/^dsh-/, '')
    const idSource = selfDeclared !== '' ? 'semantic.md 自述' : '由插件名推导'
    const exact = list.some(e => e && (e.id === id || e.id === name))
    mention = (raw.match(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
    return { exact, mention, id, idSource }
  } catch { return { exact: false, mention: 0, id: '', idSource: 'none' } }
}

/** 技能目录下引用了该名字的技能文件数。 */
function skillRefs(name) {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const dir = join(home, '.agents', 'skills')
  if (!existsSync(dir)) return 0
  let n = 0
  for (const entry of readdirSync(dir)) {
    const f = join(dir, entry, 'SKILL.md')
    if (existsSync(f) && readText(f).includes(name)) n += 1
  }
  return n
}

function scan(name) {
  const dirPath = join(REPO, 'self-plugins', name)
  const patchText = readText(join(PROFILE, 'cordis.patch.yml'))
  const pkgText = readText(join(PROFILE, 'package.json'))
  const sem = semanticEntry(name)
  return {
    name,
    dir: existsSync(dirPath),
    dirHasNodeModules: existsSync(join(dirPath, 'node_modules')),
    gitlink: gitMode(`self-plugins/${name}`),
    patchRows: (patchText.match(new RegExp(`^\\s*-\\s*name:\\s*${name}\\s*$`, 'gm')) || []).length,
    profileDep: pkgText.includes(`"${name}"`),
    semanticEntry: sem.exact,
    semanticMention: sem.mention,
    skillRefs: skillRefs(name),
  }
}

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const explicit = args.filter(a => !a.startsWith('--'))
const names = explicit.length > 0 ? explicit : unloadedFromLog()

if (names.length === 0) {
  console.error('[scan-plugin-residue] 没有目标：既未指定插件名，事件日志里也没有卸载记录')
  process.exit(2)
}

const rows = names.map(scan)

if (asJson) {
  console.log(JSON.stringify({ repo: REPO, dsh: DSH, count: rows.length, rows }, null, 2))
} else {
  const pad = (s, n) => String(s).padEnd(n)
  console.log(`# 插件退役残留面 —— 仓库 ${REPO}`)
  console.log(`# 样本来源：${explicit.length > 0 ? '命令行指定' : `事件日志卸载记录（${rows.length} 个）`}`)
  console.log()
  console.log(pad('插件', 28) + pad('目录', 6) + pad('nm', 5) + pad('gitlink', 9)
    + pad('patch行', 8) + pad('profile依赖', 12) + pad('语义条目', 9) + pad('语义提及', 9) + '技能引用')
  console.log('-'.repeat(105))
  for (const r of rows) {
    console.log(pad(r.name, 28) + pad(r.dir ? '在' : '-', 6) + pad(r.dirHasNodeModules ? '有' : '-', 5)
      + pad(r.gitlink ?? '-', 9) + pad(r.patchRows, 8) + pad(r.profileDep ? '在' : '-', 12)
      + pad(r.semanticEntry ? '在' : '-', 9) + pad(r.semanticMention, 9) + r.skillRefs)
  }
  const dirty = rows.filter(r => r.dir || r.gitlink || r.patchRows > 0 || r.profileDep
    || r.semanticEntry || r.skillRefs > 0)
  console.log()
  console.log(`残留（有任一项未清）: ${dirty.length}/${rows.length}`)
  if (dirty.length > 0) {
    console.log('未清项明细：')
    for (const r of dirty) {
      const parts = []
      if (r.dir) parts.push(`目录${r.dirHasNodeModules ? '(含 node_modules)' : ''}`)
      if (r.gitlink) parts.push(`gitlink=${r.gitlink}`)
      if (r.patchRows > 0) parts.push(`patch ${r.patchRows} 行`)
      if (r.profileDep) parts.push('profile 依赖')
      if (r.semanticEntry) parts.push('语义条目')
      if (r.skillRefs > 0) parts.push(`技能 ${r.skillRefs}`)
      console.log(`  · ${r.name}: ${parts.join(' / ')}`)
    }
  }
}

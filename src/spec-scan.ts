/**
 * 自研插件规范自检的采集层（2026-10-30）
 *
 * 与 `spec-check.ts` 的分工：那边是纯判据（可测），这边只负责把磁盘读成 `PluginSpecInput`。
 * 目录读不到、package.json 解析失败一律**显式返回**，不静默跳过——「跳过」与「通过」在报告里必须能分开。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginSpecInput } from './spec-check.ts'

/** 采集结果：要么拿到完整形态，要么拿到一条失败原因。 */
export type SpecCollectResult =
  | { name: string; input: PluginSpecInput }
  | { name: string; parseError: string }

// 跳过非插件目录：node_modules 是依赖；docs 是自研插件的共享文档目录（无 package.json），
// 不跳过它会在报告里多出一条「解析失败」，让未来的我误以为有个插件坏了。
const SKIP_DIRS = new Set(['node_modules', 'docs'])

/** 递归收集 JSON 值里的全部字符串（`exports` 可以是字符串、对象、数组，形态不固定）。 */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out)
  }
}

/** 目录下最新文件的 mtime；目录不存在或为空返回 null。 */
function newestMtime(dir: string, accept: (name: string) => boolean = () => true): number | null {
  let newest: number | null = null
  const walk = (cur: string): void => {
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const full = join(cur, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!accept(entry.name)) continue
      try {
        const mtime = statSync(full).mtimeMs
        if (newest === null || mtime > newest) newest = mtime
      } catch {
        // 单个文件读不到不影响整体新鲜度判定；报告以目录级结论为准。
      }
    }
  }
  walk(dir)
  return newest
}

/** 目录下条目数；不存在返回 0。 */
function countEntries(dir: string): number {
  try {
    return readdirSync(dir).length
  } catch {
    return 0
  }
}

/** 文件字节数；不存在返回 0。 */
function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/**
 * 读取单个插件目录，产出判据需要的形态。
 *
 * @param root self-plugins 根目录
 * @param name 插件目录名
 * @returns 完整形态，或一条解析失败原因（不静默跳过）
 */
export function collectPluginSpec(root: string, name: string): SpecCollectResult {
  const dir = join(root, name)
  let raw: string
  try {
    raw = readFileSync(join(dir, 'package.json'), 'utf8')
  } catch {
    return { name, parseError: 'package.json 不存在或读不动' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { name, parseError: 'package.json 不是合法 JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { name, parseError: 'package.json 顶层不是对象' }
  }
  const pkg = parsed as Record<string, unknown>

  const entryPaths: string[] = []
  collectStrings(pkg.main, entryPaths)
  collectStrings(pkg.exports, entryPaths)

  const deps = pkg.dependencies
  const dependencyKeys = deps !== null && typeof deps === 'object' && !Array.isArray(deps) ? Object.keys(deps) : []

  // dsh.bundle.patch 是 bundle 形态的标志；三层都可能缺，逐层 typeof 而不是断言。
  let bundlePatch: string | undefined
  const dsh = pkg.dsh
  if (dsh !== null && typeof dsh === 'object' && !Array.isArray(dsh)) {
    const bundle = (dsh as Record<string, unknown>).bundle
    if (bundle !== null && typeof bundle === 'object' && !Array.isArray(bundle)) {
      const patch = (bundle as Record<string, unknown>).patch
      if (typeof patch === 'string') bundlePatch = patch
    }
  }

  const hasLib = countEntries(join(dir, 'lib')) > 0
  const libNewestMs = hasLib ? newestMtime(join(dir, 'lib')) : null
  const srcNewestMs = newestMtime(join(dir, 'src'))

  return {
    name,
    input: {
      name,
      type: typeof pkg.type === 'string' ? pkg.type : undefined,
      entryPaths,
      dependencyKeys,
      bundlePatch,
      bundlePatchExists: bundlePatch === undefined ? false : fileSize(join(dir, bundlePatch)) > 0,
      testCount: countEntries(join(dir, 'tests')),
      readmeBytes: fileSize(join(dir, 'README.md')),
      hasLib,
      libNewestMs,
      srcNewestMs,
    },
  }
}

/**
 * 扫描 self-plugins 下的全部插件目录（跳过隐藏目录与 node_modules）。
 *
 * @param root self-plugins 根目录
 * @returns 每个目录一条采集结果，含解析失败的那些
 */
export function scanSelfPlugins(root: string): SpecCollectResult[] {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => collectPluginSpec(root, name))
}

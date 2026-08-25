/**
 * profile 操作：cordis.patch.yml 行级编辑（保留注释）、package.json 依赖、
 * pnpm install、沙盒预检、备份回滚。全部操作先备份，失败可恢复。
 * @module dsh-agent-plugin-manager/profile
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import yaml from 'js-yaml'

function backupFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const bak = path + '.bak-' + ts
    copyFileSync(path, bak)
    return bak
  } catch { return null }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^$()|[\]\\]/g, '\\$&')
}

/** 追加一个 insert 块到 patch 尾部（幂等：同 id 已存在则返回 inserted=false）。 */
export function patchInsert(profileDir: string, id: string, name: string, config?: Record<string, unknown>): { bak: string | null; inserted: boolean } {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const bak = backupFile(patchPath)
  let text = ''
  try { text = readFileSync(patchPath, 'utf8') } catch { text = '' }
  const idRe = new RegExp('^\\s*- id:\\s*' + escapeRe(id) + '\\s*$', 'm')
  if (idRe.test(text)) return { bak, inserted: false }
  let block = '- insert:\n    - id: ' + id + '\n      name: ' + name
  if (config && Object.keys(config).length > 0) {
    const dumped = yaml.dump(config, { indent: 2, noRefs: true })
    block += '\n      config:\n' + dumped.split('\n').map((l) => '        ' + l).join('\n')
  }
  if (text.trim()) text = text.replace(/\s*$/, '') + '\n' + block + '\n'
  else text = block + '\n'
  writeFileSync(patchPath, text, 'utf8')
  return { bak, inserted: true }
}

/** 移除 patch 中指定 id 的行（整块移除；含其 config/disabled）。 */
export function patchRemove(profileDir: string, id: string): { bak: string | null; removed: boolean } {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const bak = backupFile(patchPath)
  let text = ''
  try { text = readFileSync(patchPath, 'utf8') } catch { return { bak, removed: false } }
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let skipping = false
  let removed = false
  let sawOtherId = false
  let idIndent = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (!skipping) {
      const m = line.match(/^(\s*)- id:\s*([\w@./-]+)/)
      if (m && m[2] === id) {
        skipping = true
        removed = true
        idIndent = (m[1] ?? '').length
        continue
      }
      out.push(line)
      continue
    }
    // 跳过中：遇到下一个顶层条目（缩进 <= 2 的 "- "）结束跳过
    const nm = line.match(/^(\s*)- /)
    if (nm && (nm[1] ?? '').length <= 2) {
      skipping = false
      out.push(line)
    } else if (/^\s*- id:/.test(line)) {
      sawOtherId = true
    }
  }
  if (!removed) return { bak, removed: false }
  // insert 块内且无其他条目：删除块头空壳（- insert:）
  if (!sawOtherId && idIndent > 2) {
    const last = out[out.length - 1] ?? ''
    if (/^-\s*insert:/.test(last.trimStart())) out.pop()
  }
  writeFileSync(patchPath, out.join('\n'), 'utf8')
  return { bak, removed: true }
}

/** 设置/清除 disabled（启停）。id 行存在时在其后插入或替换 disabled 行。 */
export function patchSetDisabled(profileDir: string, id: string, disabled: boolean): { bak: string | null; ok: boolean } {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const bak = backupFile(patchPath)
  let text = ''
  try { text = readFileSync(patchPath, 'utf8') } catch { return { bak, ok: false } }
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let ok = false
  let pendingId = false
  let idIndent = 2
  const disabledLine = (indent: number) => ' '.repeat(indent) + 'disabled: ' + (disabled ? 'true' : 'false')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (pendingId) {
      pendingId = false
      if (/^\s*disabled:\s*(true|false)/.test(line)) {
        // 替换已有 disabled 行
        out.push(disabledLine(idIndent + 2))
        continue
      }
      // 本行不是 disabled → 先补插 disabled 再处理本行
      out.push(disabledLine(idIndent + 2))
    }
    const m = line.match(/^(\s*)- id:\s*([\w@./-]+)/)
    if (m && m[2] === id) {
      pendingId = true
      idIndent = (m[1] ?? '').length
      ok = true
    }
    out.push(line)
  }
  // id 行是文件最后一行 → 末尾补插
  if (pendingId) out.push(disabledLine(idIndent + 2))
  if (!ok) return { bak, ok: false }
  writeFileSync(patchPath, out.join('\n'), 'utf8')
  return { bak, ok: true }
}

/** 替换指定 id 行的 config 块（无则插入；空对象则删除 config 段）。 */
export function patchSetConfig(profileDir: string, id: string, config: Record<string, unknown>): { bak: string | null; ok: boolean } {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const bak = backupFile(patchPath)
  let text = ''
  try { text = readFileSync(patchPath, 'utf8') } catch { return { bak, ok: false } }
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let ok = false
  let found = false
  let skippingConfig = false
  let idIndent = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (skippingConfig) {
      const cm = line.match(/^(\s*)\S/)
      if (cm && (cm[1] ?? '').length <= idIndent) skippingConfig = false
      else continue
    }
    const m = line.match(/^(\s*)- id:\s*([\w@./-]+)/)
    if (m && m[2] === id) {
      found = true
      idIndent = (m[1] ?? '').length
      out.push(line)
      // 保留 id 行后的 name 行（如存在）——2026-08-16 修复：此前被当 config 跳过导致 loader 读 undefined
      for (let j = i + 1; j < lines.length; j += 1) {
        const nl = lines[j] ?? ''
        const nm = nl.match(/^(\s*)name:\s*\S+/)
        if (nm && (nm[1] ?? '').length > idIndent) { out.push(nl); i = j } else break
      }
      let hasConfig = false
      for (let j = i + 1; j < lines.length; j += 1) {
        const nl = lines[j] ?? ''
        if (/^\s*config:\s*$/.test(nl)) { hasConfig = true; break }
        const cm2 = nl.match(/^(\s*)\S/)
        if (cm2 && (cm2[1] ?? '').length <= idIndent) break
      }
      if (Object.keys(config).length > 0) {
        const dumped = yaml.dump(config, { indent: 2, noRefs: true })
        const inner = '      config:\n' + dumped.split('\n').map((l) => '        ' + l).join('\n')
        out.push(inner)
        if (hasConfig) skippingConfig = true
      } else if (hasConfig) {
        skippingConfig = true
      }
      ok = true
      continue
    }
    out.push(line)
  }
  if (!found) return { bak, ok: false }
  writeFileSync(patchPath, out.join('\n'), 'utf8')
  return { bak, ok: true }
}

/** package.json 依赖增删（link 形式）。 */
export function packageAddLinkDep(profileDir: string, depName: string, linkTarget: string): { bak: string | null; ok: boolean } {
  const pkgPath = join(profileDir, 'package.json')
  if (!existsSync(pkgPath)) return { bak: null, ok: false }
  const bak = backupFile(pkgPath)
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    const deps = (pkg.dependencies ?? {}) as Record<string, string>
    const target = 'link:' + linkTarget.replace(/\\/g, '/')
    if (deps[depName] === target) return { bak, ok: true }
    deps[depName] = target
    pkg.dependencies = deps
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    return { bak, ok: true }
  } catch { return { bak, ok: false } }
}

export function packageRemoveDep(profileDir: string, depName: string): { bak: string | null; ok: boolean } {
  const pkgPath = join(profileDir, 'package.json')
  if (!existsSync(pkgPath)) return { bak: null, ok: false }
  const bak = backupFile(pkgPath)
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    const deps = (pkg.dependencies ?? {}) as Record<string, string>
    if (!(depName in deps)) return { bak, ok: true }
    delete deps[depName]
    pkg.dependencies = deps
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    return { bak, ok: true }
  } catch { return { bak, ok: false } }
}

/** pnpm install（copy 导入方式，绕开 Windows rename EPERM）。 */
export function installProfile(profileDir: string, timeoutMs = 600000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn('pnpm', ['install', '--package-import-method=copy'], { cwd: profileDir, shell: true })
    let output = ''
    child.stdout.on('data', (d: Buffer) => { output += d })
    child.stderr.on('data', (d: Buffer) => { output += d })
    const timer = setTimeout(() => { child.kill(); resolvePromise({ ok: false, output: output.slice(-2000) + '\n[timeout]' }) }, timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolvePromise({ ok: code === 0, output: output.slice(-2000) })
    })
  })
}

/** 沙盒预检：试运行目标 profile @随机端口，存活 readyMs 即 PASS。失败时打印试运行输出（诊断）。 */
export function preflight(bin: string, profile: string, workspace: string, readyMs = 20000): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['--expose-internals', bin, '--profile', profile, '--port', '0'], { cwd: workspace })
    let out = ''
    child.stdout.on('data', (d: Buffer) => { out += d })
    child.stderr.on('data', (d: Buffer) => { out += d })
    const timer = setTimeout(() => { child.kill(); resolvePromise(true) }, readyMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      // 失败必须可见：把试运行输出（含崩溃前的报错）打到日志，不再静默吞
      if (out.length > 0) {
        console.error(`[plugin-manager:preflight] 试运行退出 code=${code}（${profile}），输出尾部：\n${out.slice(-4000)}`)
      } else {
        console.error(`[plugin-manager:preflight] 试运行退出 code=${code}（${profile}），无输出`)
      }
      resolvePromise(false)
    })
  })
}

/** 从 .bak 恢复文件。 */
export function rollbackFile(path: string, bak: string): boolean {
  try {
    if (!existsSync(bak)) return false
    copyFileSync(bak, path)
    return true
  } catch { return false }
}
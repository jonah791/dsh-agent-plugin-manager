/**
 * patch-remove-container.test.mjs — 「空壳 `- insert:` 是否该跟着删」必须看结构，不能看缩进常数
 *
 * 2026-11-12，全域缩进硬编码扫描的收口。`profile.ts:patchRemove` 原判据是 `idIndent > 2`：
 *
 * ① **漏**：YAML 允许 `- insert:` 与它的列表项**同缩进**——
 *        - insert:
 *          - id: lone-row
 *    此时 idIndent = 2 ⇒ 常数判「不在容器里」⇒ 空壳留着，patch 多一个孤儿 `- insert:`。
 * ② **误判**：顶层任何 indent 2 的列表项都会被当成容器内部 ⇒ 会去 pop 上一条 `- insert:` 字样的行。
 *
 * ⇒ 判据改成「往回找最近一条比它更浅的行，看它是不是 `- insert:`」。本测试就钉这两个方向。
 *
 * 运行：npm test（夹具全部在 os.tmpdir，不碰真实 profile）
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { patchRemove } from '../lib/profile.js'

/** 在临时 profile 目录里放一份 patch，跑 patchRemove，返回结果文本与清理器。 */
function withPatch(text, id) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pm-remove-'))
  const file = join(dir, 'cordis.patch.yml')
  writeFileSync(file, text, 'utf8')
  const result = patchRemove(dir, id)
  const out = readFileSync(file, 'utf8')
  return { result, out, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('空壳判定：容器同缩进写法（id indent 2）⇒ 空壳必须跟着删', () => {
  const { result, out, cleanup } = withPatch(['- insert:', '  - id: lone-row', '    name: lone', ''].join('\n'), 'lone-row')
  try {
    assert.equal(result.removed, true)
    assert.ok(!/insert:/.test(out), `空壳没删掉：${JSON.stringify(out)}`)
  } finally {
    cleanup()
  }
})

test('空壳判定：容器深缩进写法（id indent 4）⇒ 空壳必须跟着删', () => {
  const { result, out, cleanup } = withPatch(['- insert:', '    - id: deep-row', '      name: deep', ''].join('\n'), 'deep-row')
  try {
    assert.equal(result.removed, true)
    assert.ok(!/insert:/.test(out), `空壳没删掉：${JSON.stringify(out)}`)
  } finally {
    cleanup()
  }
})

test('空壳判定：顶层 indent 2 的列表项不在容器里 ⇒ 不许 pop 掉外层键', () => {
  const { result, out, cleanup } = withPatch(['plugins:', '  - id: top-row', '    name: top', ''].join('\n'), 'top-row')
  try {
    assert.equal(result.removed, true)
    assert.ok(out.includes('plugins:'), `外层键被误删：${JSON.stringify(out)}`)
  } finally {
    cleanup()
  }
})

test('空壳判定：容器里还有兄弟 ⇒ 空壳保留，兄弟一个不少', () => {
  const src = ['- insert:', '  - id: keep-me', '    name: keep', '  - id: drop-me', '    name: drop', ''].join('\n')
  const { result, out, cleanup } = withPatch(src, 'drop-me')
  try {
    assert.equal(result.removed, true)
    assert.ok(out.includes('insert:'), '容器里还有兄弟，空壳不该删')
    assert.ok(out.includes('keep-me'))
    assert.ok(!out.includes('drop-me'))
  } finally {
    cleanup()
  }
})

test('回归：真正只是「没这条 id」时 removed=false 且文件一字不动', () => {
  const src = ['- insert:', '  - id: other', '    name: other', ''].join('\n')
  const { result, out, cleanup } = withPatch(src, 'ghost')
  try {
    assert.equal(result.removed, false)
    assert.equal(out, src)
  } finally {
    cleanup()
  }
})

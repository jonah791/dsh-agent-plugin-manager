/**
 * tests/event-log.test.mjs — 事件日志薄壳的回归测试（准则 C4：观测失败不反噬主流程）。
 *
 * 覆盖：行格式契约（`[ISO 时刻] 消息`）／追加成功／失败路径（父路径是普通文件 = 不可写 →
 * 返回 false **不抛**）／多行追加顺序。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendLineSafe, formatEventLine } from '../lib/event-log.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'pm-events-'))

test('formatEventLine: `[ISO 时刻] 消息\\n`（与既有日志契约一致）', () => {
  const line = formatEventLine(new Date('2026-09-14T00:00:00.000Z'), '哨兵已写: x')
  assert.equal(line, '[2026-09-14T00:00:00.000Z] 哨兵已写: x\n')
})

test('appendLineSafe: 追加成功返回 true，多行按顺序累积', () => {
  const dir = tmp()
  try {
    const file = join(dir, '.plugin-manager-events.log')
    assert.equal(appendLineSafe(file, formatEventLine(new Date('2026-09-14T00:00:00.000Z'), '第一条')), true)
    assert.equal(appendLineSafe(file, formatEventLine(new Date('2026-09-14T00:00:01.000Z'), '第二条')), true)
    const rows = readFileSync(file, 'utf-8').trim().split('\n')
    assert.equal(rows.length, 2)
    assert.ok(rows[0].endsWith('第一条'))
    assert.ok(rows[1].endsWith('第二条'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('appendLineSafe: 不可写路径（父路径是普通文件）→ 返回 false 且不抛', () => {
  const dir = tmp()
  try {
    const blocker = join(dir, 'blocker-file')
    writeFileSync(blocker, 'x', 'utf-8')
    let ok
    assert.doesNotThrow(() => { ok = appendLineSafe(join(blocker, 'events.log'), 'line\n') })
    assert.equal(ok, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('appendLineSafe: 空路径/空行都不抛（退化输入保守返回）', () => {
  let ok
  assert.doesNotThrow(() => { ok = appendLineSafe('', 'x\n') })
  assert.equal(ok, false)
})

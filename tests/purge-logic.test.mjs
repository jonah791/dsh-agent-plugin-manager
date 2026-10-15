/**
 * tests/purge-logic.test.mjs —— 「彻底退役」判据的离线回归（纯层，跑 lib 产物，与运行时同源）。
 *
 * 为什么测这两条：
 *   · `registryHasIdFromText` —— 退役残留里**最大的一类**（14 个样本中 11 个语义条目未清）。
 *     它的判据必须**精确**（id 命中，不是正文提及），否则会报假残留或漏报真残留。
 *   · `purgeReportLines` —— 工具 render 与测试**共用同一份文案**，防「测试断言的」与「线上显示的」漂移。
 *
 * 跑法：node --test tests/purge-logic.test.mjs（先 tsc -p tsconfig.json 构建）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registryHasIdFromText, purgeReportLines } from '../lib/ops-logic.js'

// ── registryHasIdFromText：精确命中，且**永不抛**（调用点在退役流程上）────────
test('registryHasIdFromText：精确命中 id 为真；子串与未知名为假', () => {
  const text = JSON.stringify({ entries: [{ id: 'engagement' }, { id: 'model-test' }] })
  assert.equal(registryHasIdFromText(text, 'model-test'), true)
  assert.equal(registryHasIdFromText(text, 'model'), false, '子串不算命中')
  assert.equal(registryHasIdFromText(text, 'dream-tavern'), false)
})

test('registryHasIdFromText：正文提及该名字但无该 id ⇒ false（防「提及=条目」误读）', () => {
  const text = JSON.stringify({ entries: [{ id: 'engagement', notes: 'dsh-red-team 已并入本件' }] })
  assert.equal(registryHasIdFromText(text, 'red-team'), false)
})

test('registryHasIdFromText：坏 JSON / 结构不符 / 空串 ⇒ false 且不抛', () => {
  assert.equal(registryHasIdFromText('{ 这不是 json', 'x'), false)
  assert.equal(registryHasIdFromText('{"entries":"不是数组"}', 'x'), false)
  assert.equal(registryHasIdFromText('{}', 'x'), false)
  assert.equal(registryHasIdFromText('', 'x'), false)
  assert.equal(registryHasIdFromText('null', 'x'), false)
})

test('registryHasIdFromText：entries 混 null / 原始值 ⇒ 不抛且判据仍正确', () => {
  const text = JSON.stringify({ entries: [null, 42, 'str', { id: 'wanted' }] })
  assert.equal(registryHasIdFromText(text, 'wanted'), true)
  assert.equal(registryHasIdFromText(text, 'other'), false)
})

// ── purgeReportLines：渲染与判据同源 ──────────────────────────────────────
test('purgeReportLines：干跑文案含四项影响面 + 零改动提示', () => {
  const lines = purgeReportLines({
    ok: true, dryRun: true, name: 'dsh-x', profile: 'web',
    dirExists: true, dirBytes: 2097152, gitlinkMode: '160000',
    semanticPresent: true, referenceCount: 3, traceWritten: false,
  })
  const s = lines.join('\n')
  assert.match(s, /【干跑】彻底退役 dsh-x@web/)
  assert.match(s, /在（2\.0 MB · 文件大小累加口径，硬链接重复计入）/)
  assert.match(s, /160000/)
  assert.match(s, /语义注册表条目：仍在 ⇒ 需 dsh-semantic-docs 注销/)
  assert.match(s, /待改引用：3 处/)
  assert.match(s, /干跑：零改动/)
})

test('purgeReportLines：已执行文案显示归档路径与留痕状态', () => {
  const lines = purgeReportLines({
    ok: true, dryRun: false, name: 'dsh-x', profile: 'web',
    dirExists: true, dirBytes: 0,
    archivedTo: 'E:/alice/.dsh/archive/plugin-purge/dsh-x-20261003-2227',
    semanticPresent: false, referenceCount: 0, traceWritten: true,
  })
  const s = lines.join('\n')
  assert.match(s, /【已执行】/)
  assert.match(s, /→ 已归档/)
  assert.match(s, /语义注册表条目：不存在/)
  assert.match(s, /已写入 plugin-purge-trace\.jsonl/)
})

test('purgeReportLines：无目录 / 无 gitlink 时不出现空壳文案', () => {
  const s = purgeReportLines({
    ok: true, dryRun: true, name: 'dsh-x', profile: 'web',
    dirExists: false, dirBytes: 0, semanticPresent: false, referenceCount: 0, traceWritten: false,
  }).join('\n')
  assert.match(s, /插件目录：不存在/)
  assert.match(s, /gitlink：无/)
})

test('purgeReportLines：ok=false ⇒ 只回一行失败原因（不假装成功）', () => {
  const lines = purgeReportLines({
    ok: false, dryRun: true, name: 'dsh-x', profile: 'web', error: '插件不存在: dsh-x',
    dirExists: false, dirBytes: 0, semanticPresent: false, referenceCount: 0, traceWritten: false,
  })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /失败：插件不存在/)
})

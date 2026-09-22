// 在飞分身检测（**会话目录来源**）—— 判据来源：2026-09-22 真机日志实证
//
// 为什么需要第二条来源：内存会话表那条判据在真机上写着「候选会话 2 · 命中 0（放行）」，
// 而当时**确有一个分身正在跑**（它的会话目录 mtime 就是它在写入的时刻）。
// ⇒ 子代理会话不在内存会话表里；磁盘才是真源。
//
// 纪律：对照组是本文件的重点——尤其是「`session-` 前缀不命中」（防并行实例假阳性）
// 与「超窗不命中」（防「永远命中」把重启永久锁死）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { describeInFlightSessions, findInFlightSessionDirs } from '../lib/ops-logic.js'

const NOW = Date.parse('2026-09-22T07:30:00Z')
const W = 10 * 60_000
const sub = (id, ageMs) => ({ name: id, mtimeMs: NOW - ageMs })
const SUB_A = 'e6c29e72-e19a-42b7-926f-0984cfdf8e30'
const SUB_B = '4ac89b6f-77eb-4dcf-a76f-ed17829ccc9b'
const USER = 'session-005ddf46-13b3-4b73-9779-269daadaf57b'

test('对照组①：空列表 ⇒ 无在飞', () => {
  assert.deepEqual(findInFlightSessionDirs([], NOW, W), [])
})

test('对照组②：用户会话（session- 前缀）**不**命中 —— 防并行实例假阳性', () => {
  assert.deepEqual(findInFlightSessionDirs([sub(USER, 5_000)], NOW, W), [],
    '用户会话不是分身；若命中，任何并行实例在聊天都会拦住我的重启')
})

test('对照组③：分身会话但**超出窗口** ⇒ 不命中（防「永远命中」锁死重启）', () => {
  assert.deepEqual(findInFlightSessionDirs([sub(SUB_A, W + 1)], NOW, W), [])
  // 边界：正好等于窗口 ⇒ 仍算在飞
  assert.equal(findInFlightSessionDirs([sub(SUB_A, W)], NOW, W).length, 1)
})

test('命中：裸 uuid 且刚写入 ⇒ 识别为在飞分身，带上静默秒数', () => {
  const got = findInFlightSessionDirs([sub(SUB_A, 12_000)], NOW, W)
  assert.equal(got.length, 1)
  assert.equal(got[0].id, SUB_A)
  assert.equal(got[0].ageMs, 12_000)
})

test('混合：用户会话 + 在飞分身 + 陈旧分身 ⇒ 只命中在飞那个', () => {
  const got = findInFlightSessionDirs([sub(USER, 1000), sub(SUB_A, 3000), sub(SUB_B, W + 60_000)], NOW, W)
  assert.deepEqual(got.map((x) => x.id), [SUB_A])
})

test('对照组④：名字不是裸 uuid 一律不算（短形/带前缀/带空白/纯字母）', () => {
  const junk = ['abc', 'e6c29e72', 'session-' + SUB_A, ' ' + SUB_A, SUB_A + ' ', 'sub-' + SUB_A, '']
  assert.deepEqual(findInFlightSessionDirs(junk.map((n) => ({ name: n, mtimeMs: NOW })), NOW, W), [])
})

test('uuid 大小写不敏感（Windows 文件名不区分大小写，判据也不该区分）', () => {
  assert.equal(findInFlightSessionDirs([{ name: SUB_A.toUpperCase(), mtimeMs: NOW }], NOW, W).length, 1)
})

test('mtime 缺失/非法 ⇒ 跳过（宁可漏报）；未来值 ⇒ 按在飞处理（时钟偏移时倾向保护）', () => {
  const bad = [
    { name: SUB_A },
    { name: SUB_B, mtimeMs: 0 },
    { name: 'aaaaaaaa-1111-2222-3333-444444444444', mtimeMs: Number.NaN },
    { name: 'bbbbbbbb-1111-2222-3333-444444444444', mtimeMs: 'now' },
  ]
  assert.deepEqual(findInFlightSessionDirs(bad, NOW, W), [])
  const future = findInFlightSessionDirs([{ name: SUB_A, mtimeMs: NOW + 60_000 }], NOW, W)
  assert.equal(future.length, 1)
  assert.ok(future[0].ageMs < 0, '未来 mtime ⇒ 负 age，但仍在飞')
})

test('敌意输入不抛：null / 字符串 / 数字元素', () => {
  const got = findInFlightSessionDirs([null, 'x', 42, undefined, { name: SUB_A, mtimeMs: NOW }], NOW, W)
  assert.ok(Array.isArray(got))
  assert.deepEqual(got.map((x) => x.id), [SUB_A])
})

test('describeInFlightSessions：空 → 空串；非空含 id 与秒数，且**不出现负数秒**', () => {
  assert.equal(describeInFlightSessions([]), '')
  const line = describeInFlightSessions(findInFlightSessionDirs([sub(SUB_A, 12_000), { name: SUB_B, mtimeMs: NOW + 60_000 }], NOW, W))
  assert.ok(line.includes('2 个分身会话'))
  assert.ok(line.includes(SUB_A))
  assert.ok(line.includes('12s 前'))
  assert.ok(!/-\d+s 前/.test(line), '不许出现负数秒：' + line)
})

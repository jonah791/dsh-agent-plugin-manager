// 在飞分身检测 —— 判据来源任务板 t-68ce39fb 与 AGENTS.md §5.14（并行实例不夺权）
//
// 纪律：**每一条「命中」都必须配一条「该放行的放行」**（§5.9·2）。
// 这里最危险的失效不是漏报，而是**误锁**——一个「永远返回命中」的实现也能让所有命中断言全绿，
// 却会让 daemon_restart 永久不可用。所以对照组（超窗 / 无事件 / 主会话）是本文件的重点。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_INFLIGHT_WINDOW_MS, describeInFlight, findInFlightSubagents } from '../lib/ops-logic.js'

const NOW = Date.parse('2026-09-22T07:00:00Z')
const sub = (id, lastTime, depth = 1) => ({ id, header: { delegationDepth: depth }, events: [{ time: lastTime }] })
const main = (id, lastTime) => ({ id, header: { delegationDepth: 0 }, events: [{ time: lastTime }] })

test('对照组①：空列表 ⇒ 无在飞', () => {
  assert.deepEqual(findInFlightSubagents([], NOW, DEFAULT_INFLIGHT_WINDOW_MS), [])
})

test('对照组②：只有主会话（depth=0）⇒ 无在飞（否则每次重启都被自己拦下）', () => {
  assert.deepEqual(findInFlightSubagents([main('session-a', NOW - 1000)], NOW, DEFAULT_INFLIGHT_WINDOW_MS), [])
})

test('对照组③：分身但最后活动**超出窗口** ⇒ 放行（这条是防「永远命中」的关键）', () => {
  const old = sub('stale-sub', NOW - DEFAULT_INFLIGHT_WINDOW_MS - 1)
  assert.deepEqual(findInFlightSubagents([old], NOW, DEFAULT_INFLIGHT_WINDOW_MS), [])
  // 边界：正好等于窗口 ⇒ 仍算在飞（`age > window` 才剔除）
  const edge = sub('edge-sub', NOW - DEFAULT_INFLIGHT_WINDOW_MS)
  assert.equal(findInFlightSubagents([edge], NOW, DEFAULT_INFLIGHT_WINDOW_MS).length, 1)
})

test('对照组④：分身但取不到 events / time ⇒ 放行（宁可漏报，不可误锁）', () => {
  assert.deepEqual(findInFlightSubagents([{ id: 's1', header: { delegationDepth: 1 } }], NOW, 60_000), [])
  assert.deepEqual(findInFlightSubagents([{ id: 's2', header: { delegationDepth: 1 }, events: [] }], NOW, 60_000), [])
  assert.deepEqual(findInFlightSubagents([{ id: 's3', header: { delegationDepth: 1 }, events: [{ time: 0 }] }], NOW, 60_000), [])
})

test('命中：刚有活动的派生会话被识别，字段可读', () => {
  const got = findInFlightSubagents([sub('sub-a', NOW - 5000, 2)], NOW, DEFAULT_INFLIGHT_WINDOW_MS)
  assert.equal(got.length, 1)
  assert.equal(got[0].id, 'sub-a')
  assert.equal(got[0].delegationDepth, 2, '深度 2 也算（不只 depth===1）')
  assert.equal(got[0].ageMs, 5000)
})

test('混合场景：主会话 + 在飞分身 + 超窗分身 ⇒ 只命中在飞那一个', () => {
  const list = [
    main('session-main', NOW - 100),
    sub('live-sub', NOW - 1000),
    sub('stale-sub', NOW - DEFAULT_INFLIGHT_WINDOW_MS - 60_000),
  ]
  const got = findInFlightSubagents(list, NOW, DEFAULT_INFLIGHT_WINDOW_MS)
  assert.deepEqual(got.map((x) => x.id), ['live-sub'])
})

test('多事件时取**最后一项**的 time（与 pickActiveSessionId 同口径，两处不许不一致）', () => {
  // 最后一项是旧时间、中间有更新的时间 ⇒ 按「最后一项」判，应当**放行**
  const s = { id: 'weird', header: { delegationDepth: 1 }, events: [{ time: NOW - 1 }, { time: NOW - DEFAULT_INFLIGHT_WINDOW_MS - 1 }] }
  assert.deepEqual(findInFlightSubagents([s], NOW, DEFAULT_INFLIGHT_WINDOW_MS), [])
  // 反过来：最后一项新 ⇒ 命中
  const s2 = { id: 'weird2', header: { delegationDepth: 1 }, events: [{ time: NOW - DEFAULT_INFLIGHT_WINDOW_MS - 1 }, { time: NOW - 1 }] }
  assert.equal(findInFlightSubagents([s2], NOW, DEFAULT_INFLIGHT_WINDOW_MS).length, 1)
})

test('时钟偏移：事件时间在未来 ⇒ 按在飞处理（不确定时倾向保护）', () => {
  const got = findInFlightSubagents([sub('future-sub', NOW + 60_000)], NOW, DEFAULT_INFLIGHT_WINDOW_MS)
  assert.equal(got.length, 1)
  assert.ok(got[0].ageMs < 0)
})

test('describeInFlight：空清单给空串；非空含 id 与静默秒数（负 age 不许打印负数）', () => {
  assert.equal(describeInFlight([]), '')
  const line = describeInFlight(findInFlightSubagents([sub('sub-a', NOW - 12_000), sub('future-sub', NOW + 60_000, 3)], NOW, DEFAULT_INFLIGHT_WINDOW_MS))
  assert.ok(line.includes('2 个分身'))
  assert.ok(line.includes('sub-a'))
  assert.ok(line.includes('12s 前'))
  // ⚠ 判据要精确：不能断言「整行不含 -」——分身 id 本身可能带连字符（future-sub）。
  // 要量的是「秒数值」不许为负，所以只匹配 `-数字s 前` 这个形状。
  assert.ok(!/-\d+s 前/.test(line), '不许出现负数秒：' + line)
})

test('敌意输入不抛，且**一条都不许混进来**（输入不可信：形状随宿主版本漂移）', () => {
  const junk = [
    { id: 'a' },                                                                        // 无 header
    { id: 'b', header: null, events: null },                                            // header/events 为 null
    { id: 'c', header: { delegationDepth: 1 }, events: 'not-an-array' },                // events 非数组
    { id: 'd', header: { delegationDepth: 1 }, events: [null] },                        // 元素为 null ⇒ 取不到 time
    { id: 'e', header: { delegationDepth: '1' }, events: [{ time: NOW }] },             // 深度是字符串（会被 JS 强转！）
    { id: 'f', header: { delegationDepth: Number.NaN }, events: [{ time: NOW }] },      // NaN（`NaN <= 0` 为 false）
    { id: 'g', header: { delegationDepth: Number.POSITIVE_INFINITY }, events: [{ time: NOW }] },
    { id: 'h', header: { delegationDepth: 1 }, events: [{ time: 'now' }] },             // time 非数字
  ]
  const got = findInFlightSubagents(junk, NOW, 60_000)
  assert.ok(Array.isArray(got))
  assert.deepEqual(got.map((x) => x.id), [],
    'e/f/g/h 是最容易漏的：字符串与 NaN 参与比较不会抛错，只会**静默通过**——所以必须显式判类型')
})

/**
 * 预检门控纯逻辑层单测（2026-09-12 · 任务 t-a2385a9f）。
 *
 * 重点：① 判据是**进程级**（不得因为实现改动而悄悄变成会话级——AGENTS.md §5.11 §3）
 *      ② 文案必须如实（不得再冒充「本会话」）
 *      ③ 调用者证据即使放行也必须给（排查「这条预检是谁按的」）
 *      ④ 尸体样本：坏记录不得被读成「没调用过」或「通过」
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { decidePreflightGate, extractCaller, describeCaller, callerComparison } from '../lib/preflight-gate.js'

const WS = 'E:\\alice'
const WEB_START = 1_000_000
const good = { atMs: WEB_START + 5000, workspace: WS, pass: true, mode: 'full', caller: { sessionId: 'session-a', isMain: true, hasAgent: true } }

describe('decidePreflightGate · 进程级判据', () => {
  test('常规：本进程内、workspace 一致、通过 → 放行', () => {
    const d = decidePreflightGate(good, { workspace: WS, webStartMs: WEB_START })
    assert.equal(d.ok, true)
    assert.match(d.evidence, /session-a/)
  })
  test('无记录 → 拒绝，且文案说的是「本 web 进程」而非「本会话」', () => {
    const d = decidePreflightGate(null, { workspace: WS, webStartMs: WEB_START })
    assert.equal(d.ok, false)
    assert.match(d.reason, /本 web 进程/)
    assert.doesNotMatch(d.reason, /本会话/)
  })
  test('记录早于本次 web 启动 → 拒绝，文案同样如实', () => {
    const d = decidePreflightGate({ ...good, atMs: WEB_START - 1 }, { workspace: WS, webStartMs: WEB_START })
    assert.equal(d.ok, false)
    assert.match(d.reason, /早于本次 web 进程启动/)
    assert.doesNotMatch(d.reason, /本会话/)
  })
  test('边界：atMs 恰等于 webStartMs → 放行（闭区间）', () => {
    assert.equal(decidePreflightGate({ ...good, atMs: WEB_START }, { workspace: WS, webStartMs: WEB_START }).ok, true)
  })
  test('workspace 不匹配 → 拒绝（改工作区后旧预检不算数）', () => {
    const d = decidePreflightGate(good, { workspace: 'E:\\other', webStartMs: WEB_START })
    assert.equal(d.ok, false)
    assert.match(d.reason, /workspace 不匹配/)
  })
  test('最近一次预检未通过 → 拒绝', () => {
    const d = decidePreflightGate({ ...good, pass: false }, { workspace: WS, webStartMs: WEB_START })
    assert.equal(d.ok, false)
    assert.match(d.reason, /未通过/)
  })
  test('怪物：atMs 缺失/非数字/NaN → 拒绝（判「记录无效」，不是「没调用过」）', () => {
    for (const bad of [{ workspace: WS, pass: true }, { atMs: 'x', workspace: WS, pass: true }, { atMs: Number.NaN, workspace: WS, pass: true }]) {
      const d = decidePreflightGate(bad, { workspace: WS, webStartMs: WEB_START })
      assert.equal(d.ok, false)
      assert.match(d.reason, /记录无效/)
    }
  })
  test('证据行带调用者：旧记录（无 caller）也说明来源', () => {
    const d = decidePreflightGate({ atMs: WEB_START + 1, workspace: WS, pass: true }, { workspace: WS, webStartMs: WEB_START })
    assert.equal(d.ok, true)
    assert.match(d.evidence, /旧版本|未知/)
  })
})

describe('extractCaller · 从 exec.agent 提取真实调用者', () => {
  test('主体：delegationDepth=0 → isMain', () => {
    const c = extractCaller({ agent: { session: { id: 'session-a', header: { cwd: '/w' } }, delegationDepth: 0 } })
    assert.deepEqual(c, { sessionId: 'session-a', isMain: true, hasAgent: true, cwd: '/w' })
  })
  test('派生：delegationDepth>0 → 非主体', () => {
    assert.equal(extractCaller({ agent: { session: { id: 'x' }, delegationDepth: 2 } }).isMain, false)
  })
  test('尸体：无 agent / 形状异常 → 降级为未知，不抛', () => {
    for (const bad of [undefined, null, {}, { agent: null }, { agent: 'nope' }, { agent: 42 }]) {
      const c = extractCaller(bad)
      assert.equal(c.hasAgent, false)
      assert.equal(c.sessionId, null)
    }
  })
  test('怪物：session.id 非字符串 → 字符串化；cwd 非字符串 → 不带该字段', () => {
    const c = extractCaller({ agent: { session: { id: 123, header: { cwd: 456 } }, delegationDepth: 0 } })
    assert.equal(c.sessionId, '123')
    assert.equal('cwd' in c, false)
  })
})

describe('describeCaller / callerComparison · 证据行措辞', () => {
  test('describeCaller 区分 主体/派生/未知', () => {
    assert.match(describeCaller({ sessionId: 's', isMain: true, hasAgent: true }), /主体/)
    assert.match(describeCaller({ sessionId: 's', isMain: false, hasAgent: true }), /派生/)
    assert.match(describeCaller(null), /未知/)
  })
  test('callerComparison：同一/不同/旧记录/本次未知 四种措辞', () => {
    const rec = { caller: { sessionId: 'session-a', isMain: true, hasAgent: true } }
    assert.match(callerComparison(rec, { sessionId: 'session-a', isMain: true, hasAgent: true }), /同一会话/)
    const diff = callerComparison(rec, { sessionId: 'session-b', isMain: true, hasAgent: true })
    assert.match(diff, /不同会话/)
    assert.match(diff, /进程级判据允许放行/)   // 明确：不同会话不阻拦，仅留证
    assert.match(callerComparison({}, { sessionId: 's', isMain: true, hasAgent: true }), /旧记录/)
    assert.match(callerComparison(rec, { sessionId: null, isMain: false, hasAgent: false }), /本次调用者未知/)
  })
})

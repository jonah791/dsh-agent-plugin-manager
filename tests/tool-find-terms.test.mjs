import assert from 'node:assert/strict'
import test from 'node:test'
import { findPluginsByToolQuery, queryTerms } from '../lib/ops-logic.js'

const FIXTURE = [
  {
    name: 'dsh-agent-memory',
    version: '0.22.0',
    source: 'self',
    purpose: '长期记忆：写入、检索、合流、销账',
    tools: ['remember', 'recall', 'memory_merge', 'memory_check', 'memory_dispose', 'forget'],
  },
  {
    name: 'dsh-agent-preflight',
    version: '0.1.4',
    source: 'self',
    purpose: '组合试运行预检',
    tools: ['preflight_check'],
  },
]

test('queryTerms：按空白与常见分隔符切词，空 query ⇒ 空数组（概览语义）', () => {
  assert.deepEqual(queryTerms('memory merge forget'), ['memory', 'merge', 'forget'])
  assert.deepEqual(queryTerms('  记忆，合流；销账  '), ['记忆', '合流', '销账'])
  assert.deepEqual(queryTerms(''), [])
})

test('★ 回归：多词整串无命中时按词命中（2026-11-12 事故：memory_merge 在档案里却回「无命中」）', () => {
  // 旧实现：整串「memory merge forget」不是任何工具名的子串 ⇒ []
  const hits = findPluginsByToolQuery(FIXTURE, 'memory merge forget')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].plugin, 'dsh-agent-memory')
  // 「memory」命中 memory_* 三个，「merge」「forget」各命中一个——并集即命中面
  assert.deepEqual(hits[0].matchedTools.sort(),
    ['forget', 'memory_check', 'memory_dispose', 'memory_merge'])
})

test('单词查询行为不变（不与旧实现回归）', () => {
  assert.deepEqual(findPluginsByToolQuery(FIXTURE, 'zzz不存在zzz'), [])
  const one = findPluginsByToolQuery(FIXTURE, 'preflight_check')
  assert.equal(one.length, 1)
  assert.equal(one[0].score, 3)
})

test('多词时覆盖度优先：两个词都中的域排在只中一个的前面', () => {
  const both = [
    {
      name: 'zzz-two-hits', version: '1.0.0', source: 'self', purpose: '无关',
      tools: ['alpha_tool', 'beta_tool'],
    },
    {
      name: 'aaa-one-hit', version: '1.0.0', source: 'self', purpose: '无关',
      tools: ['alpha_only'],
    },
  ]
  const hits = findPluginsByToolQuery(both, 'alpha beta')
  assert.equal(hits[0].plugin, 'zzz-two-hits', '覆盖两个词的域必须排第一，而不是按插件名')
})

test('中文没有空格 ⇒ 切词等同原行为（不会回归成碎词）', () => {
  const hits = findPluginsByToolQuery(FIXTURE, '记忆')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].plugin, 'dsh-agent-memory')
})

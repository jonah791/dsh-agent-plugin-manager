/**
 * spec-check 单测（node --test，跑构建产物 lib/spec-check.js）
 *
 * 判据：九项每项都要有一条**正面**用例（喂坏样本必须红）+
 * 一条**尸体**用例（合规样本必须零告警）——恒为空的输出不是证据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkPluginSpec, summarizeSpec, formatSpecReport, SPEC_CHECK_LIMITS } from '../lib/spec-check.js'

/** 合规基线：每项都满足，各用例只改要测的那一项。 */
const good = (over = {}) => ({
  name: 'dsh-x',
  type: 'module',
  entryPaths: ['./lib/index.js'],
  dependencyKeys: [],
  bundlePatch: undefined,
  bundlePatchExists: false,
  testCount: 3,
  readmeBytes: 1200,
  hasLib: true,
  libNewestMs: 2000,
  srcNewestMs: 1000,
  ...over,
})

const kinds = (issues) => issues.map((i) => i.kind)

test('尸体测试：合规样本 ⇒ 九项零告警', () => {
  assert.deepEqual(checkPluginSpec(good()), [])
})

test('type 不是 module ⇒ not-esm（官方：ESM 无例外）', () => {
  assert.deepEqual(kinds(checkPluginSpec(good({ type: 'commonjs' }))), ['not-esm'])
  assert.deepEqual(kinds(checkPluginSpec(good({ type: undefined }))), ['not-esm'])
})

test('入口指向 src/ ⇒ entry-to-src（源码面与产物面不混）', () => {
  assert.ok(kinds(checkPluginSpec(good({ entryPaths: ['./src/index.ts'] }))).includes('entry-to-src'))
  // 带 ./ 前缀与不带前缀都要抓到（2026-10-30 踩过：旧正则要求前导斜杠，漏了 `src/index.ts`）
  assert.ok(kinds(checkPluginSpec(good({ entryPaths: ['src/index.ts'] }))).includes('entry-to-src'))
})

test('main 与 exports 都缺 ⇒ no-entry', () => {
  assert.ok(kinds(checkPluginSpec(good({ entryPaths: [] }))).includes('no-entry'))
})

test('宿主包进 dependencies ⇒ host-in-deps（会拉出第二份宿主实例）', () => {
  const issues = checkPluginSpec(good({ dependencyKeys: ['yaml', '@deepseek-ai/cordis'] }))
  assert.ok(kinds(issues).includes('host-in-deps'))
  assert.match(issues.find((i) => i.kind === 'host-in-deps').detail, /cordis/)
})

test('声明了 bundle patch 但文件不存在 ⇒ bundle-patch-missing', () => {
  const issues = checkPluginSpec(good({ bundlePatch: './cordis.patch.yml', bundlePatchExists: false }))
  assert.ok(kinds(issues).includes('bundle-patch-missing'))
  // 文件真的存在时不得报
  assert.deepEqual(checkPluginSpec(good({ bundlePatch: './cordis.patch.yml', bundlePatchExists: true })), [])
})

test('tests/ 为空 ⇒ no-tests', () => {
  assert.ok(kinds(checkPluginSpec(good({ testCount: 0 }))).includes('no-tests'))
})

test('README 太薄 ⇒ readme-thin（阈值 200B）', () => {
  assert.ok(kinds(checkPluginSpec(good({ readmeBytes: 199 }))).includes('readme-thin'))
  assert.deepEqual(checkPluginSpec(good({ readmeBytes: 200 })), [])
})

test('无 lib/ ⇒ no-lib', () => {
  assert.ok(kinds(checkPluginSpec(good({ hasLib: false, libNewestMs: null }))).includes('no-lib'))
})

test('src 比 lib 新 ⇒ stale-lib（改了源码没重编）', () => {
  const issues = checkPluginSpec(good({ srcNewestMs: 4 * 60_000, libNewestMs: 0 }))
  assert.ok(kinds(issues).includes('stale-lib'))
  assert.match(issues.find((i) => i.kind === 'stale-lib').detail, /4 分钟/)
})

test('不足 1 分钟必须报秒——「0 分钟」读起来像没问题（2026-10-30 实测踩到）', () => {
  const issues = checkPluginSpec(good({ srcNewestMs: 5000, libNewestMs: 1000 }))
  const detail = issues.find((i) => i.kind === 'stale-lib').detail
  assert.match(detail, /4 秒/)
  assert.doesNotMatch(detail, /0 分钟/)
})

test('lib 比 src 新 ⇒ 不报（正常构建顺序）', () => {
  assert.deepEqual(checkPluginSpec(good({ srcNewestMs: 1000, libNewestMs: 5000 })), [])
})

test('无 src 目录时不算 stale（判据需要一个比较对象）', () => {
  assert.deepEqual(checkPluginSpec(good({ srcNewestMs: null, libNewestMs: 1000 })), [])
})

test('一个插件可以同时有多项违规，全部列出', () => {
  const issues = checkPluginSpec(good({ type: 'commonjs', testCount: 0, hasLib: false, libNewestMs: null }))
  assert.equal(issues.length, 3)
})

test('summarizeSpec：干净行不进 rows，byKind 按计数降序', () => {
  const s = summarizeSpec([
    { name: 'a', issues: [] },
    { name: 'b', issues: [{ kind: 'no-tests', detail: '' }] },
    { name: 'c', issues: [{ kind: 'no-tests', detail: '' }, { kind: 'no-lib', detail: '' }] },
  ])
  assert.equal(s.scanned, 3)
  assert.equal(s.clean, 1)
  assert.equal(s.rows.length, 2)
  assert.deepEqual(s.byKind, [{ kind: 'no-tests', count: 2 }, { kind: 'no-lib', count: 1 }])
})

test('formatSpecReport：全通过时给通过陈述，但仍带边界（否则「零问题」被读成「全部合规」）', () => {
  const text = formatSpecReport(summarizeSpec([{ name: 'a', issues: [] }]))
  assert.match(text, /九项判据全部通过/)
  assert.ok(text.includes(SPEC_CHECK_LIMITS), '通过时也必须披露未覆盖范围')
})

test('formatSpecReport：有违规时逐行可读，并带边界', () => {
  const text = formatSpecReport(summarizeSpec([{ name: 'bad', issues: [{ kind: 'no-tests', detail: 'tests/ 为空' }] }]))
  assert.match(text, /bad/)
  assert.match(text, /no-tests/)
  assert.ok(text.includes(SPEC_CHECK_LIMITS))
})

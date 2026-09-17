/**
 * drift 单测（node --test，跑构建产物 lib/drift.js）
 * 判据：今天的真实事故形态要被抓到；**干净的档案不得报警**（尸体测试）；抠不到数字时不猜。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { declaredToolCount, detectDrift, formatDrift } from '../lib/drift.js'

const arch = (over = {}) => ({
  name: 'dsh-x', version: '0.1.0', source: 'self', purpose: '', category: '', client: false,
  tools: [], built: true, status: 'mounted', profiles: ['web'], ...over,
})

test('当天事故形态：自述 23 个工具、档案只 1 个 ⇒ 抓到 count mismatch', () => {
  const f = detectDrift([arch({ name: 'dsh-search-pro', purpose: '深度搜索插件：… + 23 工具（搜索/抓取）', tools: ['search_build_query'] })])
  const kinds = f.map((x) => `${x.name}:${x.kind}`)
  assert.ok(kinds.includes('dsh-search-pro:tool-count-mismatch'))
})

test('当天事故形态：自称 8 个但清单为空 ⇒ 抓到 tools-empty-claimed', () => {
  const f = detectDrift([arch({ name: 'dsh-blue-team', purpose: '蓝队防御插件：…（8 工具，ATT&CK 能力地图）', tools: [] })])
  assert.ok(f.some((x) => x.kind === 'tools-empty-claimed'))
})

test('尸体测试：自述与事实一致 ⇒ **不得**报警', () => {
  const f = detectDrift([arch({ name: 'dsh-passbook', purpose: '隐私密码本：8 工具（生成/取用/体检）', tools: Array.from({ length: 8 }, (_, i) => `passbook_t${i}`) })])
  assert.deepEqual(f, [])
})

test('尸体测试：抠不到数字 ⇒ 不猜（declaredToolCount 返回 null，且不因「工具数 ≠ 未知」报警）', () => {
  assert.equal(declaredToolCount('某个插件：做点事'), null)
  const f = detectDrift([arch({ name: 'dsh-x', purpose: '某个插件：做点事', tools: ['a'] })])
  assert.deepEqual(f, [])
})

test('purpose 缺失 ⇒ purpose-missing（模型可见面缺描述）', () => {
  const f = detectDrift([arch({ name: 'dsh-y', purpose: '', tools: ['a'] })])
  assert.ok(f.some((x) => x.kind === 'purpose-missing'))
})

test('挂载但未构建 ⇒ unbuilt-mount', () => {
  const f = detectDrift([arch({ name: 'dsh-z', purpose: 'x', tools: ['a'], built: false, status: 'mounted' })])
  assert.ok(f.some((x) => x.kind === 'unbuilt-mount'))
})

test('挂载 + 零工具 + 未声称 ⇒ tools-zero-unclaimed（service-only 插件需人工判定）', () => {
  const f = detectDrift([arch({ name: 'dsh-service-only', purpose: '守护运行时服务', tools: [] })])
  assert.ok(f.some((x) => x.kind === 'tools-zero-unclaimed'))
})

test('formatDrift：无发现给 ✓ 文本；有发现逐行可读', () => {
  assert.match(formatDrift([]), /无漂移/)
  const text = formatDrift([{ name: 'dsh-a', kind: 'purpose-missing', detail: '无用途描述' }])
  assert.match(text, /dsh-a/)
  assert.match(text, /purpose-missing/)
})

test('多个档案混检：只报有问题的那些', () => {
  const f = detectDrift([
    arch({ name: 'ok', purpose: '好插件：1 工具', tools: ['t'] }),
    arch({ name: 'bad', purpose: '坏插件：5 工具', tools: ['t'] }),
  ])
  assert.equal(f.length, 1)
  assert.equal(f[0].name, 'bad')
})

test('语义收窄：官方 bundle 默认不参与（它们只提供 service、不背我的 purpose 约定）', () => {
  const official = arch({ name: '@deepseek-ai/dsh-agent', source: 'official', purpose: '', tools: [] })
  assert.deepEqual(detectDrift([official]), [])
  // 显式放开来源才检查（人工排查用）
  const all = detectDrift([official], { sources: [] })
  assert.ok(all.length >= 1, '放开来源后应能看到官方包的形态提示')
})

test('自研零工具但未声称 ⇒ 仍要报（自研应当要么有工具、要么写明只提供 service）', () => {
  const f = detectDrift([arch({ name: 'dsh-service-only', source: 'self', purpose: '守护运行时服务', tools: [] })])
  assert.ok(f.some((x) => x.kind === 'tools-zero-unclaimed'))
})

test('service-only 合规声明 ⇒ 不再报 tools-zero-unclaimed（合规形态要认）', () => {
  const f = detectDrift([arch({ name: 'dsh-agent-guardian', purpose: '守卫插件：web 保活（只提供 service，不注册工具）', tools: [] })])
  assert.deepEqual(f.filter((x) => x.kind === 'tools-zero-unclaimed'), [])
})

test('未声明的零工具 ⇒ 仍要报（不能靠沉默过关）', () => {
  const f = detectDrift([arch({ name: 'dsh-x', purpose: '某插件：做点事', tools: [] })])
  assert.ok(f.some((x) => x.kind === 'tools-zero-unclaimed'))
})

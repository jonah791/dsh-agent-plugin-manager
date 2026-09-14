/**
 * tests/ops-logic.test.mjs — 插件管理器纯逻辑层的回归测试（跑 lib 产物，与运行时同源）。
 *
 * 覆盖：插件名校验／构建时效（> webStart+1000 单向容差）／目标会话挑选（delegationDepth 过滤、
 * 平手保留先到）／loader 快照／档案投影白名单／列表过滤与分组排序／列表行格式／脚手架模板；
 * 退化路径（空输入、缺失字段、脏列表必须**不抛**且保守）。
 * 跑法：node --test tests/ops-logic.test.mjs（先 tsc -p tsconfig.json 构建）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILD_SKEW_MS,
  filterArchives,
  groupOrderedPlugins,
  isValidPluginName,
  loaderSnapshotOf,
  anyBuildNewerThan,
  pickActiveSessionId,
  pluginListLines,
  publicArchive,
  scaffoldSource,
} from '../lib/ops-logic.js'

// ── 插件名校验 ──────────────────────────────────────────────────────
test('isValidPluginName: 合法名通过、非法名拒绝（不落盘）', () => {
  assert.equal(isValidPluginName('dsh-my-tool'), true)
  assert.equal(isValidPluginName('a'), true) // 单字母边界
  assert.equal(isValidPluginName('dsh-agent-watch'), true)
  assert.equal(isValidPluginName('My-Tool'), false) // 大写
  assert.equal(isValidPluginName('1abc'), false) // 数字开头
  assert.equal(isValidPluginName('dsh_my_tool'), false) // 下划线
  assert.equal(isValidPluginName(''), false)
  assert.equal(isValidPluginName('dsh/my'), false) // 路径分隔符
})

// ── 构建时效（组合变更判据）────────────────────────────────────────
test('anyBuildNewerThan: 严格晚于 webStart+1000ms 才算未验证构建', () => {
  const webStart = 1_000_000
  assert.equal(BUILD_SKEW_MS, 1000)
  assert.equal(anyBuildNewerThan([{ name: 'a', mtimeMs: webStart + 999 }], webStart), false)
  assert.equal(anyBuildNewerThan([{ name: 'a', mtimeMs: webStart + 1000 }], webStart), false) // 边界：等于不算
  assert.equal(anyBuildNewerThan([{ name: 'a', mtimeMs: webStart + 1001 }], webStart), true)
})

test('anyBuildNewerThan: 无候选 → false（无未验证构建，不吃保守分支）', () => {
  assert.equal(anyBuildNewerThan([], 1_000_000), false)
  assert.equal(anyBuildNewerThan([{ name: 'old', mtimeMs: 500_000 }], 1_000_000), false)
})

test('anyBuildNewerThan: 容差可注入；多插件里任一命中即 true', () => {
  const webStart = 1_000_000
  assert.equal(anyBuildNewerThan([{ name: 'a', mtimeMs: webStart + 300 }], webStart, 100), true)
  assert.equal(anyBuildNewerThan([
    { name: 'a', mtimeMs: webStart - 1 },
    { name: 'b', mtimeMs: webStart + 5_000 },
  ], webStart), true)
})

// ── 目标会话挑选（§5.18：只挑人用的主会话）──────────────────────────
test('pickActiveSessionId: 显式 mainSessionId 优先（锁定行为）', () => {
  const sessions = [{ id: 'session-new', header: { delegationDepth: 0 }, events: [{ time: 999 }] }]
  assert.equal(pickActiveSessionId(sessions, 'session-pinned'), 'session-pinned')
})

test('pickActiveSessionId: 取 delegationDepth===0 中最后事件 time 最大者', () => {
  const sessions = [
    { id: 'session-a', header: { delegationDepth: 0 }, events: [{ time: 10 }, { time: 100 }] },
    { id: 'session-b', header: { delegationDepth: 0 }, events: [{ time: 200 }] },
    { id: 'session-c', header: { delegationDepth: 0 }, events: [{ time: 150 }] },
  ]
  assert.equal(pickActiveSessionId(sessions, ''), 'session-b')
})

test('pickActiveSessionId: 子代理会话（depth !== 0）永远不选，哪怕最新', () => {
  const sessions = [
    { id: 'session-main', header: { delegationDepth: 0 }, events: [{ time: 10 }] },
    { id: '5bb40b68-bare-uuid', header: { delegationDepth: 1 }, events: [{ time: 9_999 }] },
  ]
  assert.equal(pickActiveSessionId(sessions, ''), 'session-main')
  assert.equal(pickActiveSessionId([{ id: 'sub', header: { delegationDepth: 2 }, events: [{ time: 1 }] }], ''), null)
})

test('pickActiveSessionId: 平手保留先出现的（严格 > 才替换）', () => {
  const sessions = [
    { id: 'first', header: { delegationDepth: 0 }, events: [{ time: 100 }] },
    { id: 'second', header: { delegationDepth: 0 }, events: [{ time: 100 }] },
  ]
  assert.equal(pickActiveSessionId(sessions, ''), 'first')
})

test('pickActiveSessionId: 退化输入（空列表/缺 events/缺 header）不抛且保守', () => {
  assert.equal(pickActiveSessionId([], ''), null)
  assert.equal(pickActiveSessionId([{ id: 'no-events' }], ''), 'no-events') // 缺 header → 视作主会话；无事件 time=0
  assert.equal(pickActiveSessionId([{ id: 'x', events: [] }], ''), 'x')
})

// ── loader 快照 ─────────────────────────────────────────────────────
test('loaderSnapshotOf: 无名条目丢弃；disabled===true 才算停用', () => {
  const out = loaderSnapshotOf([
    { options: { name: 'dsh-a' }, disabled: true },
    { options: { name: 'dsh-b' } },
    { options: { name: '' } },
    { options: {} },
    {},
  ])
  assert.deepEqual(out, [{ name: 'dsh-a', enabled: false }, { name: 'dsh-b', enabled: true }])
})

test('loaderSnapshotOf: 空迭代不抛（保守返回空快照）', () => {
  assert.deepEqual(loaderSnapshotOf([]), [])
  assert.deepEqual(loaderSnapshotOf([{ options: undefined }]), [])
})

// ── 档案投影 ────────────────────────────────────────────────────────
test('publicArchive: 字段白名单 + 深拷贝（改不回源对象）', () => {
  const src = {
    name: 'dsh-x', version: '0.1.0', source: 'self', purpose: '用途', category: 'cat', client: true,
    tools: ['a'], built: true, status: 'mounted', profiles: ['web'], config: { k: 1 },
    path: 'E:/alice/self-plugins/dsh-x', extra: 'DROP-ME',
  }
  const out = publicArchive(src)
  assert.deepEqual(Object.keys(out).sort(), ['built', 'category', 'client', 'config', 'name', 'profiles', 'purpose', 'source', 'status', 'tools', 'version'])
  assert.equal(out.extra, undefined)
  assert.equal(out.path, undefined) // 内部路径不外泄
  out.tools.push('mutated')
  assert.deepEqual(src.tools, ['a']) // 深拷贝：源不受影响
})

test('publicArchive: 缺字段不抛（undefined 被 JSON 丢弃，保守返回部分档案）', () => {
  let out
  assert.doesNotThrow(() => { out = publicArchive({ name: 'dsh-partial' }) })
  assert.equal(out.name, 'dsh-partial')
  assert.equal(out.version, undefined)
})

// ── 列表过滤 / 分组 / 行格式 ────────────────────────────────────────
const arch = (over = {}) => ({
  source: 'self', name: 'dsh-a', version: '0.1.0', status: 'mounted', built: true,
  purpose: '用途', tools: [], profiles: [], ...over,
})

test('filterArchives: source/status 过滤；空条件=全量（顺序不变）', () => {
  const list = [
    arch({ name: 'self-m', source: 'self', status: 'mounted' }),
    arch({ name: 'self-u', source: 'self', status: 'unmounted' }),
    arch({ name: 'off', source: 'official', status: 'mounted' }),
  ]
  assert.equal(filterArchives(list, {}).length, 3)
  assert.deepEqual(filterArchives(list, { source: 'self' }).map((p) => p.name), ['self-m', 'self-u'])
  assert.deepEqual(filterArchives(list, { status: 'unmounted' }).map((p) => p.name), ['self-u'])
  assert.deepEqual(filterArchives(list, { source: 'self', status: 'mounted' }).map((p) => p.name), ['self-m'])
  assert.deepEqual(filterArchives(list, { source: 'third-party' }), []) // 无命中 → 空数组
})

test('groupOrderedPlugins: 组间按 order（自研→官方→第三方），未知来源归第三方垫底', () => {
  const groups = groupOrderedPlugins([
    arch({ name: 'tp', source: 'third-party' }),
    arch({ name: 'unknown', source: 'weird-source' }),
    arch({ name: 'self', source: 'self' }),
    arch({ name: 'off', source: 'official' }),
  ])
  assert.deepEqual(groups.map((g) => g.key), ['self', 'official', 'third-party'])
  assert.deepEqual(groups[2].items.map((p) => p.name), ['tp', 'unknown']) // 组内保持入参顺序
  assert.equal(groups[0].title, '▸ 自研')
})

test('pluginListLines: 行格式逐字一致（未构建/工具/挂载/用途）', () => {
  const lines = pluginListLines([
    arch({ name: 'dsh-a', version: '0.1.0', status: 'mounted', built: true, purpose: '用途A', tools: ['t1', 't2'], profiles: ['web'] }),
    arch({ name: 'dsh-b', version: '0.2.0', status: 'unmounted', built: false, purpose: '', tools: [], profiles: [] }),
  ])
  assert.equal(lines[0], '▸ 自研（2）')
  assert.equal(lines[1], '  • dsh-a 0.1.0 [mounted] — 用途A\n      工具: t1, t2\n      挂载: web')
  assert.equal(lines[2], '  • dsh-b 0.2.0 [unmounted] 未构建') // 空用途/无工具/无挂载 → 不追加
})

test('pluginListLines: 空列表 → 空行数组（不抛）', () => {
  assert.deepEqual(pluginListLines([]), [])
})

// ── 脚手架模板 ──────────────────────────────────────────────────────
test('scaffoldSource: 插件名映射为 agent-* id，描述写入注释与 README 行', () => {
  const src = scaffoldSource('dsh-my-tool', '一句话用途')
  assert.ok(src.includes('/** dsh-my-tool：一句话用途 */'))
  assert.ok(src.includes('export const name = "agent-my-tool"'))
  assert.ok(src.includes('ctx.logger("dsh-my-tool")'))
  assert.ok(src.endsWith('}\n'))
})

test('scaffoldSource: 空描述/无 dsh- 前缀不抛（保守占位）', () => {
  const src = scaffoldSource('plain', '')
  assert.ok(src.includes('（待填写用途）'))
  assert.ok(src.includes('export const name = "agent-plain"'))
})

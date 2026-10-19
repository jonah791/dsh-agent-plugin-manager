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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUILD_SKEW_MS,
  compositionFilePaths,
  filterArchives,
  groupOrderedPlugins,
  isValidPluginName,
  loaderSnapshotOf,
  anyBuildNewerThan,
  pickActiveSessionId,
  pluginListLines,
  pluginRowId,
  publicArchive,
  scaffoldSource,
  findPluginsByToolQuery,
  toolFindLines,
  firstSentence,
  preflightCheckLines,
} from '../lib/ops-logic.js'

// ── 行 id 推导（2026-09-26 修「name 双前缀」缺陷的回归判据）──────────
test('pluginRowId: dsh-agent-* 不再叠加前缀', () => {
  assert.equal(pluginRowId('dsh-agent-repair'), 'agent-repair')
  assert.equal(pluginRowId('dsh-agent-skill-lifecycle'), 'agent-skill-lifecycle')
  assert.equal(pluginRowId('dsh-agent-vision'), 'agent-vision')
})

test('pluginRowId: 不含 agent- 的包名保持原约定（存量结果不变）', () => {
  assert.equal(pluginRowId('dsh-temporal-self'), 'agent-temporal-self')
  assert.equal(pluginRowId('dsh-my-tool'), 'agent-my-tool')
  assert.equal(pluginRowId('my-tool'), 'agent-my-tool')
})

test('scaffoldSource: 骨架 export name 与 pluginRowId 同源（无 agent-agent-）', () => {
  const src = scaffoldSource('dsh-agent-probe', 'x')
  assert.match(src, /export const name = "agent-probe"/)
  assert.doesNotMatch(src, /agent-agent-/)
})

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
test('scaffoldSource: 插件名映射为 agent-* id · 描述进注释 · 且**不含已废弃的 ready 事件**', () => {
  const src = scaffoldSource('dsh-my-tool', '一句话用途')
  assert.ok(src.includes('/** dsh-my-tool：一句话用途 */'), '描述必须进注释（生成者一眼看到用途）')
  assert.ok(src.includes('export const name = "agent-my-tool"'), '插件 id 映射为 agent-*')
  assert.ok(src.includes('export function apply(ctx: Context, config: Config): void'), 'apply 签名必须在')
  // ★ 2026-10-12：原两条断言（`ctx.logger("dsh-my-tool")` 与「README 行」）**在实现里都不存在** ⇒ 已删除。
  //   ⚠ 它们是「断言写在**过去的**实现上」：文本类断言**不会自己过期报警**，
  //   只会在某个时刻开始恒红 —— 而红的样子看起来像「实现坏了」，于是它会一直躺在体检报告里当噪音。
  //   ⇒ 换成一条**钉住真实教训**的判据（比原断言强：它防的是「新插件开箱即编译失败」）。
  //   ⚠⚠ 并且**必须先剥注释**：实现的注释里正解释着这条教训（写着 `ctx.on("ready", …)`），
  //   不剥就等于「判据被自己的解释文案击穿」—— 这是今天第二次踩同一形状（manor 那边一次）。
  const codeLines = src.split('\n').filter((l) => {
    const t = l.trim()
    return !t.startsWith('*') && !t.startsWith('//')
  })
  assert.equal(codeLines.some((l) => l.includes('ctx.on("ready"')), false,
    '★ cordis 4 **没有** `ready` 事件 —— 骨架**代码**里出现它 ⇒ 新插件开箱即编译失败（2026-10-06 t-83cd062f）')
  assert.ok(src.endsWith('}\n'))
})

test('scaffoldSource: 空描述/无 dsh- 前缀不抛（保守占位）', () => {
  const src = scaffoldSource('plain', '')
  assert.ok(src.includes('（待填写用途）'))
  assert.ok(src.includes('export const name = "agent-plain"'))
})

// ── 工具发现（tool_find 纯决策层 · 2026-10-15）────────────────────
// 存在理由：工具面 424 个且平铺，当日我为查一个读数在 grep/读源码里绕了一圈
//（ANIS arXiv:2610.15765v1 Discoverability：discovery 占 24.1–36.2% input token）。
const TOOL_FIXTURE = [
  { name: 'dsh-agent-memory', version: '0.16.0', source: 'self', purpose: '长期记忆：检索/记录/归档', tools: ['recall', 'remember', 'forget', 'memory_audit'] },
  { name: 'dsh-agent-self-rewrite', version: '0.10.0', source: 'self', purpose: '自改写引擎：AGENTS.md 标记段的唯一写者', tools: ['rewrite_status', 'rewrite_verdict'] },
  { name: 'dsh-tool-wsl', version: '0.3.0', source: 'self', purpose: 'WSL 命令行', tools: ['wsl', 'wsl_path'] },
]

test('findPluginsByToolQuery: 用途命中意图词（分=1，不列工具）', () => {
  const hits = findPluginsByToolQuery(TOOL_FIXTURE, '记忆')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].plugin, 'dsh-agent-memory')
  assert.equal(hits[0].score, 1, '仅用途命中 ⇒ score=1')
  assert.deepEqual(hits[0].matchedTools, [], '未命中工具名 ⇒ matchedTools 为空')
})

test('findPluginsByToolQuery: 工具名精确命中得最高分（=3）', () => {
  const hits = findPluginsByToolQuery(TOOL_FIXTURE, 'rewrite_status')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].plugin, 'dsh-agent-self-rewrite')
  assert.equal(hits[0].score, 3)
  assert.deepEqual(hits[0].matchedTools, ['rewrite_status'])
})

test('findPluginsByToolQuery: 工具名子串命中（=2）', () => {
  const hits = findPluginsByToolQuery(TOOL_FIXTURE, 'memory_')
  assert.equal(hits[0].plugin, 'dsh-agent-memory')
  assert.equal(hits[0].score, 2)
  assert.deepEqual(hits[0].matchedTools, ['memory_audit'])
})

test('findPluginsByToolQuery: 大小写不敏感', () => {
  const hits = findPluginsByToolQuery(TOOL_FIXTURE, 'RECALL')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].score, 3, '大小写不同仍应判精确命中')
})

// ★ 尸体样本①：不存在的词必须返回**空**，不得回落成「全部」
test('尸体：不存在的词返回空（不回落成全部）', () => {
  assert.deepEqual(findPluginsByToolQuery(TOOL_FIXTURE, 'zzz不存在zzz'), [])
})

test('findPluginsByToolQuery: 空 query = 全域概览（全部命中，score 均为 1）', () => {
  const hits = findPluginsByToolQuery(TOOL_FIXTURE, '')
  assert.equal(hits.length, 3)
  assert.ok(hits.every((h) => h.score === 1), '空 query 下不应产生工具级高分')
})

test('toolFindLines: 无命中时标注「有界搜索」（不读成「能力不存在」）', () => {
  const text = toolFindLines([], 'zzz').join('\n')
  assert.match(text, /无命中/)
  assert.match(text, /有界搜索/, '必须显式说明这是有界搜索的结论')
  assert.match(text, /不等于该能力不存在/, '不得把「没找到」读成「不存在」')
})

// ★ 尸体样本②：概览模式**不得**展开工具名（否则 73 域 × N 工具会淹掉上下文）
test('toolFindLines: 概览模式不展开工具名（体量可控）', () => {
  const text = toolFindLines(findPluginsByToolQuery(TOOL_FIXTURE, ''), '').join('\n')
  assert.match(text, /全域概览/)
  assert.doesNotMatch(text, /recall/, '概览不得列出具体工具名')
  assert.doesNotMatch(text, /rewrite_status/)
})

test('toolFindLines: 有 query 时列出命中工具（带「命中」标签）', () => {
  const text = toolFindLines(findPluginsByToolQuery(TOOL_FIXTURE, 'recall'), 'recall').join('\n')
  assert.match(text, /命中: recall/)
})

test('toolFindLines: 仅用途命中时标注「该域全部」（不假装是命中工具）', () => {
  const text = toolFindLines(findPluginsByToolQuery(TOOL_FIXTURE, '记忆'), '记忆').join('\n')
  assert.match(text, /该域全部: /)
  assert.doesNotMatch(text, /命中: /, '用途命中不得冒充工具命中')
})

// ── 渲染层体量控制（2026-10-15 首调实测：未截断时 tool_find("记忆") 输出近 3000 字符）──
test('firstSentence: 取首句 · 空串不抛 · 超长截断带省略号', () => {
  assert.equal(firstSentence('第一句。第二句。'), '第一句')
  assert.equal(firstSentence('只有一句没有标点'), '只有一句没有标点')
  assert.equal(firstSentence(''), '')
  assert.equal(firstSentence('   '), '')
  const long = 'x'.repeat(300)
  assert.ok(firstSentence(long).length <= 151, '超长必须截断')
  assert.match(firstSentence(long), /…$/, '截断须带省略号（读者能看出被截了）')
})

test('toolFindLines: 空工具列表显示「(无工具登记)」（不显示空白）', () => {
  const text = toolFindLines([{
    plugin: '@deepseek-ai/dsh-tool-ralph', version: '0.1.0', source: 'official',
    purpose: 'ralph 工具', tools: [], matchedTools: [], score: 1,
  }], 'ralph').join('\n')
  assert.match(text, /\(无工具登记\)/, '官方插件无工具登记时须显式标注，不能留空白')
})

test('toolFindLines: 长用途只在渲染层截断（数据层保真，不改档案）', () => {
  const longPurpose = '很长的用途。' + 'x'.repeat(400)
  const hits = findPluginsByToolQuery(
    [{ name: 'p', version: '1', source: 'self', purpose: longPurpose, tools: ['t'] }], 'p')
  const text = toolFindLines(hits, 'p').join('\n')
  assert.ok(!text.includes('x'.repeat(200)), '超长用途不得原样进输出')
  assert.equal(hits[0].purpose, longPurpose, '★ 数据层不得被改动——截断只发生在渲染层')
})

// ── 组合变更检测扩面（2026-10-19 · agent-preset/invalid 事故驱动）────────────────
// 事故形状：只改 preset/patch 声明、不重建任何插件 ⇒ 旧判据（只比 lib mtime）判「无未验证构建」
// ⇒ preflight_check 走「现有实例健康」短路 ⇒ **根本不 spawn 试运行** ⇒ 新 preset 行从未被验证。

test('compositionFilePaths: 覆盖 profile 的 patch 与清单（平台无关：用 join 现算期望值）', () => {
  assert.deepEqual(compositionFilePaths('/dsh', 'web'), [
    join('/dsh', 'cordis.patch.yml'),
    join('/dsh', 'profiles', 'web', 'cordis.patch.yml'),
    join('/dsh', 'profiles', 'web', 'package.json'),
  ])
})

test('compositionFilePaths: **不含** cordis.yml——它由启动过程自己物化写出，纳入即恒假阳性', () => {
  const paths = compositionFilePaths('/dsh', 'web')
  assert.ok(!paths.some(p => p.endsWith('cordis.yml')),
    'cordis.yml 实测写入晚于进程启动（2026-10-19：写 01:02:32 / 进程起 01:02:19）⇒ 纳入会让每次预检都变成组合变更')
  assert.ok(paths.some(p => p.endsWith('cordis.patch.yml')), 'patch 必须在内（它就是预设声明的落点）')
})

test('探针上报前缀单一真源：index.ts 必须 import 常量、不得自写字面量；组合检测必须带 profile', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(src, /import \{ PRESET_PROBE_PREFIX/, '前缀必须来自 dsh-agent-preflight/core（父进程按同一常量解析）')
  assert.ok(!src.includes("'[preflight-preset-probe] '"),
    '不得在 index.ts 里再写一份字面量——第二写者＝漂移源（父进程解析不到就成了静默假绿）')
  assert.match(src, /hasUnverifiedBuilds\(dshHome, profile\)/,
    '组合变更检测必须带上 profile（组合面文件按 profile 定位）')
})

// ── 预检逐项读数（2026-10-19 · A17/A20 的「判据存在但读数不可观察」驱动）────────────
// 事故形状：原先只在 FAIL 时构造明细、PASS 只回一行「预检通过」⇒ 「它跑过并通过了哪几项」
// 结构上不可观察（要反解只能读源码或查 trace，而 trace 的 verdict 只记 PASS 字符串）。

test('preflightCheckLines: 全绿也**逐项列出**（「跑过什么」必须可读，不是只回一行「通过」）', () => {
  const lines = preflightCheckLines({
    trialRun: { ok: true, detail: '试运行就绪 2.4s' },
    configParse: { ok: true, detail: '配置文件可解析' },
    presets: { ok: true, detail: '短路：在飞组合 9 个预设全部可激活（standard / ptc / minimal / …）' },
  })
  const text = lines.join('\n')
  assert.equal(lines.length, 3, '每一项一行，不许折叠成一句摘要')
  for (const name of ['trialRun', 'configParse', 'presets']) assert.match(text, new RegExp(name), `${name} 必须出现在逐项读数里`)
  assert.ok(lines.every((l) => l.includes('✓')), '全绿时每行都带 ✓')
})

test('preflightCheckLines: **先红后绿**，且红里带注册表原因原文（尸体样本：同 scope 重名预设）', () => {
  const corpse = '试运行实例 有 1 个预设无法激活（新建会话会报 agent-preset/invalid）：· preflight-corpse: '
    + 'tool-skill-b (@deepseek-ai/dsh-tool-skill): tool "skill" is already registered in this scope'
  const lines = preflightCheckLines({
    trialRun: { ok: true, detail: '试运行就绪（旧检出力会把这个组合判 PASS）' },
    presets: { ok: false, detail: corpse },
  })
  assert.ok(lines[0].includes('✗') && lines[0].includes('presets'), '红项必须排第一行——一片 ok 里不许藏一条红')
  assert.ok(lines[0].includes('already registered in this scope'), '原因原文逐字可见（不是「有 1 项失败」）')
  assert.ok(lines[1].includes('✓') && lines[1].includes('trialRun'), '绿项仍在（证明是新增检出力，不是重复报旧错）')
})

test('preflightCheckLines: 超长 detail 截断但**标注原长**（截断不许伪装成完整）', () => {
  const lines = preflightCheckLines({ presets: { ok: true, detail: 'x'.repeat(500) } }, 120)
  assert.ok(!lines[0].includes('x'.repeat(200)), '超限部分必须截掉（否则一条读数就能灌满上下文）')
  assert.match(lines[0], /…（原 500 字符）/, '必须标明原长——否则读者无法知道它被截过')
})

test('preflightCheckLines: 空/缺失 checks ⇒ **显式披露**，不是静默空数组', () => {
  for (const input of [undefined, null, {}]) {
    const lines = preflightCheckLines(input)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /无逐项明细/, '「没回报」必须自己说出来（§5.9 规则 2：恒为空不是证据）')
  }
})

test('preflight_check 工具接的是同一份纯函数、且 PASS 分支也把 note 拼进 render', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(src, /preflightCheckLines\(pr\.checks\)/, '工具必须用同一份纯函数渲染（判据单一真源）')
  assert.match(src, /v\.note \? '\\n' \+ v\.note : ''/,
    'PASS 分支必须拼上 note——否则改了渲染层，模型还是只看到一行「通过」')
})

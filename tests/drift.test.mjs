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

// ── tools-zero-unclaimed 的判据在 2026-11-12 改过一次（台账 lh-b012a19e）──────────
//
// 旧判据 =「挂载 ∧ tools 空 ∧ 未声称工具数 ∧ 没写 service-only 声明」⇒ 报。
// 实测把它套在 8 个注入/服务型插件上**全会报**，而 8/8 的 src 里没有任何工具注册调用
// ⇒ 它们的 `tools: []` 是设计。所以判据改成**认「提供工具」的语义**：
// `含工具字样` ∧ `含提供/注册/暴露…这类给出动词` 才报；两个条件缺一即不报。
// 下面三条原来断言「不写声明就要报」的用例随之改写——它们锁的是旧判据，留着会锁死这次修复。

test('挂载 + 零工具 + purpose 完全不提工具 ⇒ 不报（注入/服务型是设计，不是漏）', () => {
  const f = detectDrift([arch({ name: 'dsh-service-only', purpose: '守护运行时服务', tools: [] })])
  assert.deepEqual(f.filter((x) => x.kind === 'tools-zero-unclaimed'), [])
})

test('自研零工具且 purpose 不提工具 ⇒ 也不报（来源不改变「零工具是否可疑」的判据）', () => {
  const f = detectDrift([arch({ name: 'dsh-service-only', source: 'self', purpose: '守护运行时服务', tools: [] })])
  assert.deepEqual(f.filter((x) => x.kind === 'tools-zero-unclaimed'), [])
})

test('沉默的零工具 ⇒ 不报（沉默不再算可疑；判据只在「声称提供工具」时触发）', () => {
  const f = detectDrift([arch({ name: 'dsh-x', purpose: '某插件：做点事', tools: [] })])
  assert.deepEqual(f.filter((x) => x.kind === 'tools-zero-unclaimed'), [])
})

test('★ 声称「提供工具」但清单为空 ⇒ **仍要报**（这是采集漏，不是设计）', () => {
  const f = detectDrift([arch({ name: 'dsh-search-pro', purpose: '深度检索插件：向模型提供工具（搜索/抓取）', tools: [] })])
  assert.ok(f.some((x) => x.kind === 'tools-zero-unclaimed'), '声称提供工具却抓不到任何工具 ⇒ 必须报')
})

test('★ 尸体（2/8 的真实形态）：把**别人的工具当宾语**不算声称——「同工具连续失败检测」不得报', () => {
  const f = detectDrift([arch({
    name: 'dsh-agent-repair',
    purpose: '同工具连续失败检测 → 下一步注入修复提示：观察 tools/result 滑动窗口，触发后注入，fail-open 不阻塞会话',
    tools: [],
  })])
  assert.deepEqual(f.filter((x) => x.kind === 'tools-zero-unclaimed'), [])
})

test('★ 尸体（2/8 的真实形态）：「调用 ask 类工具时」不得报（是在用工具，不是提供工具）', () => {
  const f = detectDrift([arch({
    name: 'dsh-ask-evidence-gate',
    purpose: '上抛前取证闸：调用 ask 类工具时在返回里注入「本会话相关取证 N 次」读数（只送达信号、不拦截）',
    tools: [],
  })])
  assert.deepEqual(f.filter((x) => x.kind === 'tools-zero-unclaimed'), [])
})

test('8 个真实误报的 purpose 文案全部不再触发（逐条钉住，防回归）', () => {
  const REAL = [
    ['dsh-agent-ask-timeout', '给宿主的 ask_user_question 补「长时间无回答即跳过」：挂在 user-questions/request 公开 waterfall 上，race(人类回答, 超时)，超时抛出语义清晰的错误让 agent 继续——不改宿主 packages/ 一个字节'],
    ['dsh-agent-notify', '出外告警的唯一通道：以服务形式向主人推送告警（Telegram 双通道 + 去重/冷却 + 落盘留痕），供任何插件在「我不在场」时把话喊出机器'],
    ['dsh-agent-reconstruction', '重建包注入：把我自己写下的重建包原样注入为动态上下文快照。只做这一件事——不摘要、不改写、不补默认值。'],
    ['dsh-agent-repair', '同工具连续失败检测 → 下一步注入修复提示（借鉴 MemOS decision-repair）：观察 tools/result 滑动窗口，触发后经 agent/pre-step 尾部注入，fail-open 不阻塞会话'],
    ['dsh-ask-evidence-gate', '上抛前取证闸：调用 ask 类工具时在返回里注入「本会话相关取证 N 次」读数（只送达信号、不拦截，§5.39 机制承载）'],
    ['dsh-session-handoff', '会话自动衔接：新建会话时自动把上一场会话的尾部对话注入为交接材料（per-session 动态上下文，仅在存在新鲜对话时注入）'],
    ['dsh-temporal-self', '时间自我模型 T1：在模型请求末尾注入一行时距读数（距主人上条 / 距上次自我感知圈 / 今日已醒）。坐标而非感觉——不做闹钟、不碰调度、不写拟体验措辞。'],
    ['dsh-time-awareness', '时间感知：在每个模型请求的末尾附加一行本地时间戳（动态上下文快照，仅在变化时重新记录）。只做这一件事——不夹带任何其他注入。'],
  ]
  const f = detectDrift(REAL.map(([name, purpose]) => arch({ name, purpose, tools: [] })))
  assert.deepEqual(f.filter((x) => x.kind === 'tools-zero-unclaimed'), [], '这 8 条是实测的假阳性，一条都不许再出现')
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

test('service-only 合规声明 ⇒ 不再报 tools-zero-unclaimed（合规形态要认）', () => {
  const f = detectDrift([arch({ name: 'dsh-agent-guardian', purpose: '守卫插件：web 保活（只提供 service，不注册工具）', tools: [] })])
  assert.deepEqual(f.filter((x) => x.kind === 'tools-zero-unclaimed'), [])
})

// ── 合并史形态（2026-10-30 实测：三个合并过的插件都写「（N 工具 → M）」，旧实现取 N ⇒ 假漂移） ──

test('合并史「36 工具 → 12」⇒ 取箭头后的 12（旧实现取 36，对 dsh-engagement 报假漂移）', () => {
  assert.equal(declaredToolCount('安全交战闭环：…替换 5 个插件（36 工具 → 12）。'), 12)
})

test('尸体测试：合并史与事实一致 ⇒ 不得报警', () => {
  const f = detectDrift([arch({
    name: 'dsh-engagement',
    purpose: '安全交战闭环：…替换 dsh-red-team + …（36 工具 → 12）。',
    tools: Array.from({ length: 12 }, (_, i) => `eng_t${i}`),
  })])
  assert.deepEqual(f, [])
})

test('修装置不能放过真漂移：合并史写的 12 但实际 3 ⇒ 仍报 mismatch', () => {
  const f = detectDrift([arch({ name: 'x', purpose: '合并后（36 工具 → 12）', tools: ['a', 'b', 'c'] })])
  assert.ok(f.some((x) => x.kind === 'tool-count-mismatch'))
})

test('箭头形态的其它写法都认：英文 -> / 变为 / 合并为 / 降为', () => {
  assert.equal(declaredToolCount('merged from 5 plugins (36 tools -> 12)'), 12)
  assert.equal(declaredToolCount('某插件（36 工具变为 12）'), 12)
  assert.equal(declaredToolCount('由 36 个工具合并为 12'), 12)
  assert.equal(declaredToolCount('某插件（36 工具降为 12）'), 12)
})

test('无箭头形态时行为不变：仍取第一个「N 工具」', () => {
  assert.equal(declaredToolCount('插件管理器：… 含 9 工具 + 生命周期管理'), 9)
})


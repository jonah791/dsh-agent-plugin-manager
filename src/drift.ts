/**
 * drift.ts — 插件档案的**漂移检测**（纯逻辑，可离线单测）
 *
 * 动机（2026-09-17）：当天发现 `dsh-blue-team` 档案 tools=[]（自称 8）、`dsh-search-pro` 列 1（自称 23）——
 * 症状在档案、根因在采集器（已修 extractTools 形态 4）。但**采集器修好不等于以后不再漂**：
 * 只要有人改 description/purpose 而忘了同步工具面，漂移就会再次出现。
 * 故把判据做成机制：**比对「自述」与「档案事实」**，一条命令出清单。
 *
 * 诚实边界：本检测只能比对**档案内**可验证的一致性（自述数字 vs 工具清单长度、空清单 vs 声称有工具、
 * 挂载但未构建）。它**看不见运行时真实工具面**——那要靠 `toolface status`（收窄面）与实调工具验证。
 */
import type { PluginArchive } from './registry.ts'

export type DriftKind =
  | 'tool-count-mismatch'   // 自述「N 个工具」≠ 档案工具数
  | 'tools-empty-claimed'   // 声称有工具但档案清单为空
  | 'purpose-missing'       // 无用途描述（模型/人看不到它是干什么的）
  | 'unbuilt-mount'         // 声明挂载但未构建（构建产物缺失）
  | 'tools-zero-unclaimed'  // 清单为空 ∧ 自述声称「提供/注册」工具（可疑：采集漏）

export interface DriftFinding {
  name: string
  kind: DriftKind
  detail: string
}

/**
 * 合并史形态：「N 工具 → M」——取箭头后的 M，不取 N。
 *
 * 为什么需要（2026-10-30 实测）：三个合并过的插件都把合并史写进描述，形如
 * 「替换 dsh-red-team + …（36 工具 → 12）」。旧实现取第一个数字，于是把**合并前**
 * 的历史数当成**当前**工具数，对 `dsh-engagement`（36→12）与 `dsh-identity-loop`（16→7）
 * 各报一条假漂移。
 *
 * 修装置而不是改描述：判据应当读懂它读的那句话。「A → B」在中文里是「从 A 变成 B」，
 * B 是现在；逼所有人把正确数挪到第一个位置，是把装置的理解缺陷转嫁成写作约束。
 */
function declaredToolCountAfterArrow(purpose: string): number | null {
  const m = /(\d+)\s*(?:个|款)?\s*(?:工具|tools?)\s*(?:→|->|=>|变为|变成|合并为|降为|缩减为)\s*(\d+)/i.exec(purpose)
  if (!m || m[2] === undefined) return null
  const n = Number(m[2])
  return Number.isFinite(n) ? n : null
}

/**
 * 从 purpose 文本里抠出「N 个工具 / N tools」的声明数；抠不到返回 null（不猜）。
 *
 * @param purpose 插件档案的用途描述（来自 package.json 的 description）
 * @returns 自述的工具数；无声明或形态不认识时为 null
 */
export function declaredToolCount(purpose: string): number | null {
  if (!purpose) return null
  const afterArrow = declaredToolCountAfterArrow(purpose)
  if (afterArrow !== null) return afterArrow
  const m = /(\d+)\s*(?:个|款)?\s*(?:工具|tools?)/i.exec(purpose)
  if (!m || m[1] === undefined) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/**
 * 是否**明确声明「本插件不注册工具」**（service-only 形态的合规写法）。
 * 为什么需要它：watch 系的 guardian/sentinel/preflight/runtime 与 panel 宿主只提供 service/UI，
 * 零工具是**常态不是缺陷**——检查器应当认得这种声明，而不是逼每个 service 插件假装有工具
 * （否则要么留下恒久假警报，要么逼人写出不诚实的描述）。
 */
export function declaresNoTools(purpose: string): boolean {
  return /不注册工具|无工具|不提供工具|不含工具|service[- ]?only|只提供\s*service|仅提供\s*service/i.test(purpose ?? '')
}

/**
 * purpose 里是否**声称自己要（提供/注册/暴露）工具**——`tools-zero-unclaimed` 的收敛判据。
 *
 * 存在理由（2026-11-12 · 台账 lh-b012a19e）：这条检查原先只判「tools 为空 ∧ 未声称工具数 ∧
 * 挂载中」，于是把 8 个**注入/服务型**插件全报成可疑。
 *
 * 实测读数（2026-11-12，8 个插件逐条核过）：8/8 的 `src/` 里**没有任何工具注册调用**
 * （`grep -rE "defineTool|ctx\.tools\.register"` 命中 0，唯一命中是 `dsh-ask-evidence-gate`
 *  `src/index.ts:22` 的一句注释）⇒ 它们的 `tools: []` 是设计，不是采集漏。
 * 其中 6/8 的 purpose **根本没提「工具」**；另 2 个（`dsh-agent-repair`「同工具连续失败检测」、
 * `dsh-ask-evidence-gate`「调用 ask 类工具时」）提到工具，但语义是**拿别人的工具当宾语**
 * （观测/调用），不是「我提供工具」。
 *
 * ⇒ 判据不能只数「工具」二字的出现次数（那会把「调工具」读成「有工具」），而要认**注册语义**：
 * `含工具字样` ∧ `含提供/注册/暴露…这类给出动词` 才算声称。**两个条件都缺 ⇒ 不报**。
 * 边界（诚实）：动词表是有限枚举，写出「工具集：a, b」这类无动词声明会被漏掉——
 * 但这种写法若真有工具，采集器会抓到清单（`actual > 0`），本检查根本不会触发；
 * 它只在「源码扫出 0 个工具」时生效，所以漏判风险低，而误报是每次审计都出现的恒久噪音。
 */
export function claimsToolsInPurpose(purpose: string): boolean {
  const p = purpose ?? ''
  if (!/工具|\btools?\b/i.test(p)) return false // 完全没提工具 ⇒ 服务型常态，不报
  return /注册|提供|暴露|新增|增加|附带|包含|拥有|具备|工具面|工具集|工具数/i.test(p)
}

export interface DriftOptions {
  /** 参与检查的来源（默认 ['self']）。**官方/第三方 bundle 不适用我的约定**——
   *  它们可以只提供 service/UI 而没有 purpose/工具；对它们套自研判据会产生大量假警报
   *  （2026-09-17 实测：218 档案全量套用 → 112 条告警，其中绝大多数是 @deepseek-ai/* 官方包）。
   *  传 [] 表示不限来源（仅用于人工排查）。 */
  sources?: string[]
}

export function detectDrift(archives: PluginArchive[], opts: DriftOptions = {}): DriftFinding[] {
  const sources = opts.sources ?? ['self']
  const out: DriftFinding[] = []
  for (const a of archives) {
    if (sources.length > 0 && !sources.includes(a.source)) continue
    const declared = declaredToolCount(a.purpose ?? '')
    const actual = a.tools?.length ?? 0
    if (declared !== null && declared !== actual) {
      out.push({
        name: a.name,
        kind: 'tool-count-mismatch',
        detail: `自述 ${declared} 个工具，档案清单 ${actual} 个`,
      })
    }
    if (declared !== null && declared > 0 && actual === 0) {
      out.push({ name: a.name, kind: 'tools-empty-claimed', detail: `声称 ${declared} 个工具但清单为空（采集器形态覆盖不足？）` })
    }
    if (!a.purpose || a.purpose.trim() === '') {
      out.push({ name: a.name, kind: 'purpose-missing', detail: '无用途描述——档案、面板与我都看不到它是干什么的' })
    }
    if (a.built === false && (a.status === 'mounted' || (a.profiles?.length ?? 0) > 0)) {
      out.push({ name: a.name, kind: 'unbuilt-mount', detail: `声明挂载/有 profile 但未构建（status=${a.status}）` })
    }
    if (declared === null && actual === 0 && a.status === 'mounted'
      && !declaresNoTools(a.purpose ?? '') && claimsToolsInPurpose(a.purpose ?? '')) {
      out.push({ name: a.name, kind: 'tools-zero-unclaimed', detail: '挂载中且**自述声称提供工具**，但档案清单为空（采集漏？）' })
    }
  }
  return out
}

/** 渲染成一行行可读文本（工具面用）。 */
export function formatDrift(findings: DriftFinding[]): string {
  if (findings.length === 0) return '✓ 无漂移：自述与档案事实一致'
  return findings.map((f) => `⚠ ${f.name} · ${f.kind} — ${f.detail}`).join('\n')
}

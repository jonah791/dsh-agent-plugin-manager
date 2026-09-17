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
  | 'tools-zero-unclaimed'  // 清单为空且未声称有工具（可疑：插件通常至少 1 个工具）

export interface DriftFinding {
  name: string
  kind: DriftKind
  detail: string
}

/** 从 purpose 文本里抠出「N 个工具 / N tools」的声明数；抠不到返回 null（不猜）。 */
export function declaredToolCount(purpose: string): number | null {
  if (!purpose) return null
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
    if (declared === null && actual === 0 && a.status === 'mounted' && !declaresNoTools(a.purpose ?? '')) {
      out.push({ name: a.name, kind: 'tools-zero-unclaimed', detail: '挂载中但未声称任何工具且清单为空（可能只提供 service/client UI——若不是，则是采集漏）' })
    }
  }
  return out
}

/** 渲染成一行行可读文本（工具面用）。 */
export function formatDrift(findings: DriftFinding[]): string {
  if (findings.length === 0) return '✓ 无漂移：自述与档案事实一致'
  return findings.map((f) => `⚠ ${f.name} · ${f.kind} — ${f.detail}`).join('\n')
}

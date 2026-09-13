/**
 * 预检门控的**纯逻辑层**（无 IO、时间注入、可离线单测）。
 *
 * 为什么抽出来（2026-09-12 任务 t-a2385a9f）：原实现有三处问题，
 * 全部源自「判定逻辑埋在 `apply` 闭包里 + 文案与事实脱钩」：
 *  ① 落盘的 `sessionId` 是 `resolveActiveSessionId(ctx, config.mainSessionId)`——**不是调用者**
 *     （它是「当前活跃/主会话」，实测恒为旧值）；真正的调用者要从 `exec.agent` 取。
 *  ② 文案说「**本会话**未调用过预检工具」「非**本会话**调用」，而实际判据是**进程级**
 *     （`rec.atMs >= webStartMs`）——**文档与代码都在说谎**（AGENTS.md §5.11 §3 已明确：闸门不比对 sessionId，这是设计如此）。
 *  ③ 因此「谁调用了预检」在事故排查时**无从回答**（与我 09-12 记录的取证缺口同源）。
 *
 * 本层的语义立场：**判据仍是进程级**（不改设计），但**记录真实调用者并留证据行**，
 * 让「谁在什么时候按下了按钮」可回答。
 */

/** 落盘的预检记录（向后兼容：老记录只有前 5 个字段）。 */
export interface PreflightRecord {
  at?: string
  atMs?: number
  workspace?: string
  sessionId?: string | null
  pass?: boolean
  mode?: string
  /** 真实调用者（v0.2 新增；老记录缺失 → null）。 */
  caller?: CallerInfo | null
}

/** 调用者画像（从 `exec.agent` 提取，duck-typing，不 import 宿主类型）。 */
export interface CallerInfo {
  /** 调用者会话 id（取不到则为 null）。 */
  sessionId: string | null
  /** 是否为主体（delegationDepth === 0）；取不到保持 false 并注明未知。 */
  isMain: boolean
  /** 是否拿到了 agent 对象本身。 */
  hasAgent: boolean
  /** 调用者工作区（agent.session.header.cwd）。 */
  cwd?: string
}

export interface GateDecision {
  ok: boolean
  reason?: string
  /** 证据行（无论放行与否都给）：谁按的按钮、本实例是谁。 */
  evidence: string
}

/** 从工具执行上下文提取调用者（`exec.agent`）。缺失/形状异常一律降级为「未知」，不抛。 */
export function extractCaller(exec: unknown): CallerInfo {
  const agent = (exec as { agent?: unknown } | null | undefined)?.agent
  if (agent === null || agent === undefined || typeof agent !== 'object') {
    return { sessionId: null, isMain: false, hasAgent: false }
  }
  const a = agent as { session?: { id?: unknown; header?: { cwd?: unknown } }; delegationDepth?: unknown }
  const id = a.session?.id
  const cwd = a.session?.header?.cwd
  return {
    sessionId: typeof id === 'string' ? id : (id === undefined || id === null ? null : String(id)),
    isMain: a.delegationDepth === 0,
    hasAgent: true,
    ...(typeof cwd === 'string' ? { cwd } : {}),
  }
}

/** 人读描述：主体 / 派生 / 未知。 */
export function describeCaller(c: CallerInfo | null | undefined): string {
  if (!c || !c.hasAgent) return '未知（记录未含调用者，或该记录来自旧版本）'
  const who = c.sessionId ?? '无会话 id'
  return who + (c.isMain ? '（主体）' : '（派生/子代理）')
}

/**
 * 门控裁决（**进程级判据**，与既有设计一致）：
 *  1. 记录存在且 `atMs` 可解析
 *  2. `workspace` 与当前一致
 *  3. `atMs >= 本次 web 进程启动时刻`（即「本进程内调用过」——**不是**「本会话」）
 *  4. 最近一次预检 `pass === true`
 * 文案一律如实标注「本 web 进程」，不再冒充「本会话」。
 */
export function decidePreflightGate(
  rec: PreflightRecord | null,
  opts: { workspace: string; webStartMs: number },
): GateDecision {
  const evidence = '预检记录来自 ' + describeCaller(rec?.caller)
  if (rec === null || rec === undefined) {
    return { ok: false, reason: '本 web 进程启动后未调用过预检工具（preflight_check）', evidence }
  }
  if (typeof rec.atMs !== 'number' || !Number.isFinite(rec.atMs)) {
    return { ok: false, reason: '预检记录无效（缺 atMs 或非数字）', evidence }
  }
  if (rec.workspace !== opts.workspace) {
    return { ok: false, reason: '预检记录 workspace 不匹配（记录=' + String(rec.workspace) + '，当前=' + opts.workspace + '）', evidence }
  }
  if (rec.atMs < opts.webStartMs) {
    return { ok: false, reason: '预检记录早于本次 web 进程启动（本进程内未调用过预检，请先重新调用 preflight_check）', evidence }
  }
  if (rec.pass !== true) {
    return { ok: false, reason: '本进程最近一次预检未通过——重启会被拒绝，请先修复后重新 preflight_check', evidence }
  }
  return { ok: true, evidence }
}

/**
 * 调用者比对说明（**只作证据，不作门控**）：本次调用者与记录中的调用者是否同一会话。
 * 用于事后回答「这条预检是谁按的、为什么我的重启能过闸」。
 */
export function callerComparison(rec: PreflightRecord | null, current: CallerInfo): string {
  const recorded = rec?.caller?.sessionId ?? null
  if (recorded === null) return '记录无调用者（旧记录）'
  if (current.sessionId === null) return '本次调用者未知（exec.agent 缺失）'
  return recorded === current.sessionId
    ? '同一会话（' + recorded + '）'
    : '不同会话（记录=' + recorded + '，本次=' + current.sessionId + '）——进程级判据允许放行，此处仅留证'
}

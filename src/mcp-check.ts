/**
 * mcp-check.ts — MCP 服务器专项支持与兼容性处理的**纯逻辑层**（无 IO、无网络、无 Date.now）。
 *
 * 为什么 MCP 需要单独一层（2026-10-13 实测暴露，不是设计臆想）：
 * MCP 服务器**不在 profile 的 `dependencies` 里**——它们住在 `cordis.patch.yml` 的
 * `@deepseek-ai/dsh-mcp-client` 行的 `config.args` 中（`npx -y <pkg>@<ver>` 形态）。
 * ⇒ 上一轮做的 `scanThirdParty`（扫 `package.json` 依赖）**结构上看不见它们**。
 * 本机实测：`mcp-playwright` 装了四天，`plugin_list --source third-party` 报 5 个插件、**不含它**。
 *
 * 而且 MCP 有三类**结构性风险**，普通插件没有：
 * ① **浮动版本**：注册写法常是 `@latest` ⇒ 「已装什么版本」在配置里根本不存在，
 *    每次启动都可能换版本，而工具面/行为随之变；
 * ② **工具面膨胀**：一个 MCP 服务器可以一次贡献上百个工具，且每个都带 input/output schema
 *    （实测 REA：170 工具 ≈ 552K token）⇒ 成本风险远大于普通插件；
 * ③ **静默停用**：DSH 的兼容性预检（`compatibility-preflight.ts`）会在组合装配时把
 *    peer 不满足的行**改写为 `disabled: true`**，只往 stderr 打一行 —— 不进模型上下文。
 *    实测 `mcp-playwright` 因 `@deepseek-ai/dsh-mcp-client@0.0.1-rc.1` 与运行时
 *    `0.2.1-alpha.2` peer 不满足，**装了四天从未运行**，而配置里没有任何 disabled 字段。
 */

/** 一个 MCP 引用的解析结果。 */
export interface McpRef {
  /** registry 包名（如 `@playwright/mcp`）；非 registry 形态为 null。 */
  pkg: string | null
  /** 配置里显式 pin 的版本（如 `1.2.3`）；`latest`/范围/缺省 ⇒ null。 */
  pinned: string | null
  /** 是否用了浮动标签（`@latest` 或无版本）—— 浮动 = 每次启动可能换版本。 */
  floating: boolean
  /** 命令本体（`npx` / `bunx` / 绝对路径）。 */
  command: string
  /** 解析依据（进读数，供复核）。 */
  evidence: string
}

/** 判定「显式 pin」的形态：由数字开头的精确版本（允许 prerelease/build）。 */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * 从 MCP 行的 `command` + `args` 解析出「在跑的是哪个包、哪个版本」。
 *
 * 覆盖实测与常见形态：
 * - `npx -y @scope/pkg@1.2.3`（pin）
 * - `npx -y @playwright/mcp@latest`（浮动标签 ⇒ `floating: true`，**这是本机实测的形态**）
 * - `npx -y pkg`（无版本 ⇒ 浮动）
 * - `bunx pkg@1.2.3`
 * - `command` 是绝对路径（本地脚本，非 registry 形态 ⇒ `pkg: null`）
 *
 * **不猜**：解析不出包名时返回 `pkg: null` 并把原因写进 evidence，
 * 绝不伪造一个包名去查上游（那会给出关于**别的包**的版本读数）。
 *
 * @param command - 行 config 的 `command`。
 * @param args - 行 config 的 `args`（可能含 flag，如 `-y` / `--cdp-endpoint`）。
 * @returns 解析结果；`pkg` 为 null 表示不是 registry 形态。
 */
export function parseMcpCommand(command: string, args: readonly string[]): McpRef {
  const cmd = (command ?? '').trim()
  const isRunner = /^(npx|bunx|pnpm|yarn|npm)$/i.test(cmd) || /[\\/](npx|bunx)\.(cmd|ps1|exe)?$/i.test(cmd)
  if (!isRunner) {
    return {
      pkg: null, pinned: null, floating: false, command: cmd,
      evidence: `命令非包运行器（${cmd === '' ? '空' : cmd}）⇒ 非 registry 形态，不查上游`,
    }
  }
  // 取第一个「不像 flag、不像 flag 的值」的位置参数
  const FLAGS_WITH_VALUE = new Set(['--cdp-endpoint', '--port', '--headless', '--browser', '--config', '--user-data-dir'])
  let spec: string | null = null
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string
    if (a === '--') continue
    if (a.startsWith('-')) {
      if (FLAGS_WITH_VALUE.has(a)) i += 1 // 跳过它的值
      continue
    }
    spec = a
    break
  }
  if (spec === null || spec === '') {
    return { pkg: null, pinned: null, floating: false, command: cmd, evidence: '运行器后无可识别的包参数' }
  }
  // 拆 `name@version`：scoped 包名自带一个 @，须从**最后一个** @ 切
  const at = spec.lastIndexOf('@')
  const name = at > 0 ? spec.slice(0, at) : spec
  const version = at > 0 ? spec.slice(at + 1) : ''
  if (name === '') {
    return { pkg: null, pinned: null, floating: false, command: cmd, evidence: `包参数不可解析：${spec}` }
  }
  if (version === '') {
    return { pkg: name, pinned: null, floating: true, command: cmd, evidence: `${spec}（未指定版本 ⇒ 浮动）` }
  }
  if (EXACT_VERSION_RE.test(version)) {
    return { pkg: name, pinned: version, floating: false, command: cmd, evidence: `${spec}（显式 pin）` }
  }
  return {
    pkg: name, pinned: null, floating: true, command: cmd,
    evidence: `${spec}（标签/范围 ${version} ⇒ 浮动，配置里不存在确定版本）`,
  }
}

/** 从 patch 行提取 MCP 描述（只取需要的字段，不投影整份 config 以免带出敏感值）。 */
export interface McpRow {
  /** patch 行 id（如 `mcp-playwright`）。 */
  id: string
  /** 模块名（应为 `@deepseek-ai/dsh-mcp-client`）。 */
  name: string
  /** patch 里**显式**的 disabled（运行时的静默停用不写在这里）。 */
  disabledInPatch: boolean
  /** 服务器命名空间（工具名 `mcp__<serverName>__<tool>`）。 */
  serverName: string | null
  transport: string | null
  ref: McpRef
}

/** 判定一个 patch 行是否 MCP 客户端行。 */
export function isMcpRow(name: string | undefined): boolean {
  return name === '@deepseek-ai/dsh-mcp-client'
}

/**
 * 从已解析的 patch 行提取 MCP 描述。
 *
 * config 形状容错（**归一形状，不直接下标**，§5.24）：
 * config 缺失 / args 非数组 / serverName 非字符串 都不得抛，降级为 null 字段。
 *
 * @param row - `parsePatchRows` 产出的行。
 * @returns MCP 描述；非 MCP 行返回 null。
 */
export function mcpRowOf(row: { id?: string; name?: string; disabled?: unknown; config?: unknown }): McpRow | null {
  if (!isMcpRow(row.name)) return null
  const cfg = (row.config !== null && typeof row.config === 'object' && !Array.isArray(row.config))
    ? row.config as Record<string, unknown>
    : {}
  const command = typeof cfg.command === 'string' ? cfg.command : ''
  const args = Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === 'string') : []
  const serverName = typeof cfg.serverName === 'string' && cfg.serverName !== '' ? cfg.serverName : null
  const transport = typeof cfg.transport === 'string' && cfg.transport !== '' ? cfg.transport : null
  return {
    id: typeof row.id === 'string' ? row.id : '(无名)',
    name: row.name as string,
    disabledInPatch: row.disabled === true,
    serverName,
    transport,
    ref: parseMcpCommand(command, args),
  }
}

/** 运行时停用证据（来自 DSH 兼容性预检的产物，不是配置）。 */
export interface RuntimeDenial {
  /** 是否在运行时被判定为不兼容而停用。 */
  denied: boolean
  /** 判定依据（从日志 stderr 行提取的原文摘要）；未命中为空串。 */
  reason: string
}

/** 从一行 stderr 文本里提取「某行被兼容性预检停用」的证据。 */
const DENY_RE = /disabling profile plugin row "([^"]+)":\s*([\s\S]*?)(?:\n|$)/

/** 日志行的前导 ISO 时间戳（DSH 启动日志形如 `[2026-10-13T11:54:37.571Z err] …`）。 */
const LINE_TS_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/

/**
 * 从启动日志文本中找出**哪些 patch 行被运行时停用**，以及原因。
 *
 * 为什么必须有这一档：DSH 的兼容性预检把不兼容行改写为 `disabled: true` 并**只往 stderr 打一行**——
 * 那行不进模型上下文。于是「配置里明明写着、以为在跑」与「实际从未运行」之间
 * 没有任何可见面。本函数把那行 stderr 变成可查询的读数。
 *
 * **⚠ 时刻口径（2026-10-13 由本工具自身的一次误报抓出，必读）**：
 * 启动日志是**跨多轮启动累积**的（本机实测同一行同型记录 69 次）。因此「文件里最后一次出现」
 * **不等于「当前这轮的状态」**——不设界会拿几轮前的停用记录报当前故障（实测：修复生效后仍报 denied）。
 * 传 `sinceMs`（当前进程启动时刻）即只采纳**该时刻之后**的记录。
 *
 * 取严取向：**无法定时的行仍计入**（宁可误报也不静默漏报）——本工具存在的唯一理由
 * 就是让静默失效可见，漏报的代价大于误报。
 *
 * 同一行出现多次时取**最后一次**（原因可能随版本演化）。
 *
 * @param logText - 启动日志（stdout+stderr 合并）文本。
 * @param sinceMs - 只采纳该时刻（epoch ms）之后的记录；省略则不设界（无法区分历史与当前）。
 * @returns 行 id → 原因的映射（只含被停用的行）。
 */
export function runtimeDenials(logText: string, sinceMs?: number): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of logText.split(/\r?\n/)) {
    if (!line.includes('disabling profile plugin row')) continue
    if (sinceMs !== undefined) {
      const t = LINE_TS_RE.exec(line)
      if (t !== null) {
        const ts = Date.parse(t[1] as string)
        // 能定时且早于本次启动 ⇒ 属历史轮次，不构成当前证据
        if (Number.isFinite(ts) && ts < sinceMs) continue
      }
      // 无时间戳 ⇒ 无法归属，保守计入（见函数头「取严取向」）
    }
    const m = DENY_RE.exec(line)
    if (m === null) continue
    const id = m[1] as string
    const reason = (m[2] ?? '').trim()
    if (reason !== '') out[id] = reason
  }
  return out
}

/** 当前进程的启动时刻（epoch ms）——`runtimeDenials` 的 `sinceMs` 口径来源。 */
export function processStartMs(nowMs: number, uptimeSec: number): number {
  return nowMs - uptimeSec * 1000
}

/** MCP 服务器的健康档位（闭集，互不掩盖）。 */
export type McpHealth =
  | 'active'           // 配置启用 且 运行时未被拒
  | 'disabled-in-patch' // 配置里显式 disabled ⇒ 有意停用，不是故障
  | 'denied-runtime'   // ★ 配置启用但运行时被兼容性预检拒 —— 静默失效
  | 'unknown'          // 缺少判据（如拿不到日志）⇒ 不猜

/**
 * 判定一个 MCP 服务器的健康档位。
 *
 * **取严**：拿不到运行时证据时判 `unknown`，**不判 `active`**——「配置里是启用的」
 * 与「它真的在跑」是两件事（本机实测：配置启用、运行时被拒、四天未跑）。
 *
 * @param row - MCP 行描述。
 * @param denials - `runtimeDenials` 的产物。
 * @param logAvailable - 是否真的读到了启动日志（读不到 ⇒ 不能据此判 active）。
 * @returns 档位 + 可读说明。
 */
export function mcpHealth(row: McpRow, denials: Record<string, string>, logAvailable: boolean): { health: McpHealth; note: string } {
  if (row.disabledInPatch) return { health: 'disabled-in-patch', note: 'patch 里显式 disabled: true（有意停用）' }
  const reason = denials[row.id]
  if (reason !== undefined) {
    return { health: 'denied-runtime', note: `运行时被兼容性预检停用：${reason}` }
  }
  if (!logAvailable) return { health: 'unknown', note: '未读到启动日志 ⇒ 无法确认它是否真的在跑' }
  return { health: 'active', note: '配置启用，且启动日志中无停用记录' }
}

/** 一条 MCP 检查读数（不投影任何 config 原文——防凭据/端点进工具面）。 */
export interface McpRowReading {
  id: string
  serverName: string | null
  transport: string | null
  health: McpHealth
  note: string
  /** registry 包名；非 registry 形态为 null。 */
  pkg: string | null
  /** 配置里 pin 的版本；浮动为 null。 */
  pinned: string | null
  /** 是否浮动版本（`@latest` 或无版本）。 */
  floating: boolean
  /** 上游最新版本（查询结果）；未查为 null。 */
  latest: string | null
  /** 更新判定（复用 `decideUpdate` 的六档）。 */
  verdict: string
  /** 解析依据。 */
  evidence: string
}

/** 渲染一行 MCP 读数（纯字符串）。 */
export function mcpLine(r: McpRowReading): string {
  const mark: Record<McpHealth, string> = {
    active: '● 在跑',
    'disabled-in-patch': '○ 配置停用',
    'denied-runtime': '✖ 运行时被拒',
    unknown: '? 未确认',
  }
  const ver = r.floating
    ? `浮动（配置未 pin${r.latest === null ? '' : `，上游 ${r.latest}`}）`
    : `${r.pinned ?? '?'}${r.latest === null ? '' : ` → 上游 ${r.latest}`}`
  return `${mark[r.health]}  ${r.id}${r.serverName === null ? '' : ` [${r.serverName}]`}  ${ver}`
}

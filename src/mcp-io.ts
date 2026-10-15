/**
 * mcp-io.ts — MCP 专项支持的 **IO 壳**（读 patch / 读启动日志 / 查上游）。
 *
 * 分层纪律同 `update-io.ts`：判据全在 `mcp-check.ts`（纯函数），本文件只把世界读成它要的入参。
 *
 * 两条读取纪律：
 * - **启动日志可能巨大**（本机 `.watch-web.log` 1.7 MB 且持续增长）⇒ 只读**尾部**一段，
 *   因为「当前是否被停用」只取决于**最近一次启动**（旧记录是历史，不是现状）。
 * - **读不到 ≠ 没有**：日志读失败时把 `logAvailable` 置 false ⇒ 健康档位判 `unknown`，
 *   绝不因为「没读到停用记录」就判 `active`（那正是静默失效的形状）。
 */
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parsePatchRows, readPatch, listProfiles } from './registry.ts'
import { decideUpdate } from './update-check.ts'
import { fetchLatest, type FetchLike } from './update-io.ts'
import {
  mcpRowOf,
  mcpHealth,
  processStartMs,
  runtimeDenials,
  type McpRow,
  type McpRowReading,
} from './mcp-check.ts'

/** 读日志尾部字节数：只关心最近一次启动的停用记录（旧的是历史）。 */
export const LOG_TAIL_BYTES = 512 * 1024

/** 默认的 web 启动日志候选（按优先级；第一个存在且非空者胜）。 */
export const DEFAULT_LOG_CANDIDATES = ['.watch-web.log', '.manual-web.log', '.manual-web2.log']

/**
 * 读文件尾部 N 字节（大日志的安全读法：不全读进内存）。
 * @param path - 目标文件
 * @param bytes - 尾部字节数
 * @returns 文本；文件不存在/不可读返回 null（**区分「读不到」与「空」**）
 */
export function readTail(path: string, bytes: number = LOG_TAIL_BYTES): string | null {
  if (!existsSync(path)) return null
  let fd: number | undefined
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - bytes)
    const len = size - start
    if (len === 0) return ''
    const buf = Buffer.alloc(len)
    fd = openSync(path, 'r')
    readSync(fd, buf, 0, len, start)
    return buf.toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* 关闭失败不掩盖主结果 */ } }
  }
}

/** 收集一个 profile 里的全部 MCP 行。 */
export function collectMcpRows(profileDir: string): McpRow[] {
  let text: string
  try { text = readPatch(profileDir) } catch { return [] }
  const out: McpRow[] = []
  for (const raw of parsePatchRows(text)) {
    const row = mcpRowOf(raw as { id?: string; name?: string; disabled?: unknown; config?: unknown })
    if (row !== null) out.push(row)
  }
  return out
}

/** 一行 MCP 的完整读数（含启动日志证据与上游查询结果）。 */
export interface McpCheckReport {
  checkedAt: string
  /** 读到的日志来源与可用性（不可用 ⇒ 健康档位判 unknown）。 */
  log: { path: string | null; available: boolean; bytesRead: number; sinceMs: number }
  rows: McpRowReading[]
  counts: Record<string, number>
}

/**
 * 跑一轮 MCP 检查：枚举 → 健康判定（配置 + 运行时证据）→ 上游查询 → 汇总。
 *
 * 上游查询只对**能解析出 registry 包名**的行做（绝对路径脚本没有 npm 上游，不猜）。
 * `probeUpstream: false` 跳过网络（离线体检用）。
 *
 * **时刻口径**：健康判定只采纳 `sinceMs`（缺省 = 本进程启动时刻）**之后**的停用记录——
 * 启动日志跨多轮累积，不设界会把历史轮次的停用报成当前故障。
 *
 * @param opts - dshHome、profile 过滤、超时、fetch 注入、是否查上游、日志候选、时刻下界。
 * @returns 报告（含逐行读数、档位计数、以及本次采用的时刻下界）。
 */
export async function runMcpCheck(opts: {
  dshHome: string
  profilesDir?: string
  profile?: string
  timeoutMs?: number
  fetchImpl?: FetchLike
  probeUpstream?: boolean
  logCandidates?: readonly string[]
  /** 只采纳该时刻（epoch ms）之后的停用记录；缺省 = 本进程启动时刻。 */
  sinceMs?: number
  now?: () => Date
}): Promise<McpCheckReport> {
  const profilesDir = opts.profilesDir ?? join(opts.dshHome, 'profiles')
  const targets: { profile: string; dir: string }[] = []
  for (const info of listProfiles(profilesDir)) {
    if (opts.profile !== undefined && opts.profile !== '' && info.profile !== opts.profile) continue
    targets.push({ profile: info.profile, dir: join(profilesDir, info.profile) })
  }

  // 日志证据（按候选顺序取第一个可读者）
  const candidates = opts.logCandidates ?? DEFAULT_LOG_CANDIDATES
  let logText: string | null = null
  let logPath: string | null = null
  for (const name of candidates) {
    const p = join(opts.dshHome, name)
    const t = readTail(p)
    if (t !== null) { logText = t; logPath = p; break }
  }
  const logAvailable = logText !== null
  // 时刻口径：只采纳**本次进程启动之后**的停用记录。启动日志跨多轮累积，
  // 不设界会把历史轮次的停用报成当前故障（2026-10-13 由本工具一次误报抓出）。
  const sinceMs = opts.sinceMs ?? processStartMs(Date.now(), process.uptime())
  const denials = logAvailable ? runtimeDenials(logText as string, sinceMs) : {}

  const probe = opts.probeUpstream !== false
  const rows: McpRowReading[] = []
  for (const t of targets) {
    for (const row of collectMcpRows(t.dir)) {
      const h = mcpHealth(row, denials, logAvailable)
      let latest: string | null = null
      let verdict = 'skipped'
      if (probe && row.ref.pkg !== null) {
        const res = await fetchLatest({ github: null }, row.ref.pkg, {
          ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
          ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
        })
        latest = res.latest
        if (row.ref.pinned !== null) {
          const d = decideUpdate({
            local: row.ref.pinned,
            latest,
            ...(res.error === undefined ? {} : { fetchError: res.error }),
            hasUpstream: true,
          })
          verdict = d.verdict
        } else {
          // 浮动版本：没有「本地版本」可比 ⇒ 不可比（但上游版本仍是有用信息）
          verdict = latest === null ? 'fetch-failed' : 'not-comparable'
        }
      } else if (row.ref.pkg === null) {
        verdict = 'no-upstream'
      }
      rows.push({
        id: row.id,
        serverName: row.serverName,
        transport: row.transport,
        health: h.health,
        note: h.note,
        pkg: row.ref.pkg,
        pinned: row.ref.pinned,
        floating: row.ref.floating,
        latest,
        verdict,
        evidence: row.ref.evidence,
      })
    }
  }

  const counts: Record<string, number> = { active: 0, 'disabled-in-patch': 0, 'denied-runtime': 0, unknown: 0 }
  for (const r of rows) counts[r.health] = (counts[r.health] ?? 0) + 1

  return {
    checkedAt: (opts.now ?? (() => new Date()))().toISOString(),
    log: {
      path: logPath,
      available: logAvailable,
      bytesRead: logText === null ? 0 : Buffer.byteLength(logText, 'utf8'),
      sinceMs,
    },
    rows,
    counts,
  }
}

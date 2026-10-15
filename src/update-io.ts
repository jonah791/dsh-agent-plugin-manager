/**
 * update-io.ts — 第三方插件上游更新检查的 **IO 壳**（网络 + 文件读取）。
 *
 * 分层纪律（技能 `dsh-plugin-testability`）：**判据全在 update-check.ts（纯函数、可离线单测）**，
 * 本文件只负责把世界读成那份纯函数要的入参，并把网络失败**转成数据**而不是异常。
 *
 * 三条例外一律吞错但**不静默**（§5.10 静默失败是死亡温床）：
 * - 读取已装包元数据失败 ⇒ 记为「无上游线索」，而不是假装没这个插件；
 * - 网络失败 / 超时 / 404 ⇒ 记成 `fetch-failed` + 原因，**绝不塌缩成「已最新」**；
 * - 任何情况下返回值都是完整的一行，绝不因单点上流失败而丢掉整条记录。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyDependency, isThirdPartyDep, redactSpec, scanThirdParty, type PluginArchive } from './registry.ts'
import { decideUpdate, resolveUpstream, type UpdateVerdict } from './update-check.ts'

/** 一条更新检查读数（**不投影本地绝对路径**——工具面白名单纪律，见 publicArchive）。 */
export interface UpdateRow {
  name: string
  /** 本地已装版本。 */
  local: string
  /** 上游最新版本；未取到为 null。 */
  latest: string | null
  verdict: UpdateVerdict
  /** 可读说明（不可比原因 / 失败原因 / 版本对）。 */
  note: string
  /** 上游地址（GitHub 仓库页）；无则空串。 */
  upstream: string
  /** 上游解析依据（复核「为什么这么判」）。 */
  evidence: string
  /** 依赖声明（已脱敏，含 pin）——升级/回退靠它。 */
  spec: string
  /** 该插件挂载在哪些 profile。 */
  profiles: string[]
}

/** 一次完整检查的报告。 */
export interface UpdateReport {
  checkedAt: string
  rows: UpdateRow[]
  /** 覆盖度对账：应当查的 / 实际查到的 / 漏掉的。 */
  coverage: { expected: number; queried: number; missing: string[] }
  counts: Record<UpdateVerdict, number>
}

/** 全部档位（用于计数初始化，保证六档都被显式归零而不是缺字段）。 */
const VERDICTS: readonly UpdateVerdict[] = [
  'update-available', 'up-to-date', 'not-comparable', 'no-upstream', 'fetch-failed', 'skipped',
]

/** 上游查询的默认超时（ms）。取严：宁可判 `fetch-failed`，也不让工具挂死。 */
export const DEFAULT_TIMEOUT_MS = 8000

/** 读取一个已装包的 repository/homepage 元数据；读不到返回空对象（不抛）。 */
export function readInstalledMeta(dir: string): { repository?: unknown; homepage?: unknown; version?: string } {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return {}
  try {
    const p = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      repository?: unknown
      homepage?: unknown
      version?: unknown
    }
    return {
      repository: p.repository,
      homepage: p.homepage,
      ...(typeof p.version === 'string' ? { version: p.version } : {}),
    }
  } catch {
    // 读坏/写坏都不是致命错误：降级为「元数据不可用」，由上游解析判 no-upstream。
    return {}
  }
}

/** 待检查目标（上游解析完成，可直接进网络查询）。 */
export interface UpdateTarget {
  name: string
  local: string
  spec: string
  profiles: string[]
  upstream: ReturnType<typeof resolveUpstream>
}

/**
 * 枚举本机**全部**第三方插件并解析各自上游。
 *
 * 复用 `scanThirdParty`（v0.1.4 起已覆盖 git pin / tarball / registry / local 四形态），
 * 不从零重扫——同一事实两处实现必然漂移。
 * @param profilesDir - `<DSH_HOME>/profiles`
 * @param selfPluginsDir - 自研插件目录（用于把 link 到 self-plugins 的排除掉）
 * @returns 待检查目标列表（按名排序）
 */
export function collectTargets(profilesDir: string, selfPluginsDir: string): UpdateTarget[] {
  const archives = scanThirdParty(profilesDir, selfPluginsDir)
  return archives.map((a: PluginArchive) => {
    const meta = a.path === null ? {} : readInstalledMeta(a.path)
    return {
      name: a.name,
      local: a.version !== '' ? a.version : (meta.version ?? ''),
      spec: a.spec ?? '',
      profiles: a.profiles,
      upstream: resolveUpstream({
        name: a.name,
        spec: a.spec ?? '',
        repository: meta.repository,
        homepage: meta.homepage,
      }),
    }
  })
}

/** 上游查询结果（失败即数据，不是异常）。 */
export interface LatestResult {
  latest: string | null
  error?: string
}

/** 可注入的 fetch 形状（便于尸体测试注入坏通道，不依赖真实网络）。 */
export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

/**
 * 查询一个上游的「最新版本」。
 *
 * 策略（按优先级）：npm registry 的 `latest` 标签 → GitHub 最新 release tag → GitHub 最新 tag。
 * **GitHub 与 npm 的语义差异是真实的**：npm 的 `latest` 是发布者指定的稳定版，
 * 而 GitHub 的「最新 release」可能落后于 tag；以 npm 为先与 §5.23「pin 到 tag/commit」一致。
 *
 * 失败一律转成 `{ latest: null, error }`，错误文案含状态码，供上游分档。
 * @param ref - `resolveUpstream` 的产物。
 * @param npmName - 用于 npm registry 查询的包名（null = 不查 npm）。
 * @param opts - 超时、fetch 实现、可选 token（不落盘、不日志）。
 * @returns 最新版本或失败原因。
 */
export async function fetchLatest(
  ref: { github: { owner: string; repo: string } | null },
  npmName: string | null,
  opts: { timeoutMs?: number; fetchImpl?: FetchLike; token?: string } = {},
): Promise<LatestResult> {
  const doFetch: FetchLike = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  if (typeof doFetch !== 'function') return { latest: null, error: '运行时不提供 fetch' }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const ghHeaders: Record<string, string> = { accept: 'application/vnd.github+json' }
  if (opts.token !== undefined && opts.token !== '') ghHeaders.authorization = `Bearer ${opts.token}`

  const attempts: { url: string; headers: Record<string, string>; pick: (body: unknown) => string | null; label: string }[] = []
  if (npmName !== null && npmName !== '') {
    attempts.push({
      url: `https://registry.npmjs.org/${encodeURIComponent(npmName)}/latest`,
      headers: {},
      pick: (b) => (b !== null && typeof b === 'object' && typeof (b as { version?: unknown }).version === 'string'
        ? (b as { version: string }).version : null),
      label: 'npm latest',
    })
  }
  if (ref.github !== null) {
    const { owner, repo } = ref.github
    attempts.push({
      url: `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
      headers: ghHeaders,
      pick: (b) => (b !== null && typeof b === 'object' && typeof (b as { tag_name?: unknown }).tag_name === 'string'
        ? (b as { tag_name: string }).tag_name : null),
      label: 'GitHub latest release',
    })
    attempts.push({
      url: `https://api.github.com/repos/${owner}/${repo}/tags?per_page=1`,
      headers: ghHeaders,
      pick: (b) => (Array.isArray(b) && b.length > 0 && typeof (b[0] as { name?: unknown }).name === 'string'
        ? (b[0] as { name: string }).name : null),
      label: 'GitHub latest tag',
    })
  }
  if (attempts.length === 0) return { latest: null, error: '无可查询的上游端点' }

  const errors: string[] = []
  for (const a of attempts) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await doFetch(a.url, { headers: a.headers, signal: ac.signal })
      if (!res.ok) {
        errors.push(`${a.label} HTTP ${res.status}`)
        continue
      }
      const body = await res.json()
      const v = a.pick(body)
      if (v === null) {
        errors.push(`${a.label} 响应无可识别版本字段`)
        continue
      }
      return { latest: v }
    } catch (e) {
      // 超时/网络/DNS 全部归为查询失败；abort 与真实错误都带可读文案。
      const msg = e instanceof Error ? e.message : String(e)
      errors.push(`${a.label} ${msg}`)
    } finally {
      clearTimeout(timer)
    }
  }
  return { latest: null, error: errors.join('; ') }
}

/**
 * 跑一轮完整检查（枚举 → 查询 → 判定 → 对账）。
 *
 * 不写盘、不改任何配置：**只报告**（§5.23：第三方升级要走「读上游 CHANGELOG → 换 pin → 重装 → 重启 → 黑盒验证」，
 * 那是主体的决策，不是自动化的动作）。
 * @param opts - 目录、过滤、超时、fetch 注入、并发上限（串行执行，避免打爆上游限流）。
 * @returns 完整报告（含覆盖度对账）
 */
export async function runUpdateCheck(opts: {
  profilesDir: string
  selfPluginsDir: string
  only?: string
  timeoutMs?: number
  fetchImpl?: FetchLike
  token?: string
  now?: () => Date
}): Promise<UpdateReport> {
  const all = collectTargets(opts.profilesDir, opts.selfPluginsDir)
  const scoped = opts.only !== undefined && opts.only !== ''
    ? all.filter((t) => t.name === opts.only)
    : all

  const rows: UpdateRow[] = []
  for (const t of scoped) {
    const hasUpstream = t.upstream.github !== null
    // npm 名只在该包确实是 registry 形态时才试（link:/file:/github: 形态没有 registry 端点）
    const kind = classifyDependency(t.name, t.spec)
    const npmName = isThirdPartyDep(kind) && kind === 'third-party-registry' ? t.name : null

    if (!hasUpstream && npmName === null) {
      rows.push({
        name: t.name, local: t.local, latest: null, verdict: 'no-upstream',
        note: '未配置可识别的上游源（repository/homepage/spec 均无 GitHub 线索，且非 registry 形态）',
        upstream: '', evidence: t.upstream.evidence, spec: redactSpec(t.spec), profiles: t.profiles,
      })
      continue
    }

    const res = await fetchLatest(t.upstream, npmName, {
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
      ...(opts.token === undefined ? {} : { token: opts.token }),
    })
    const d = decideUpdate({
      local: t.local,
      latest: res.latest,
      ...(res.error === undefined ? {} : { fetchError: res.error }),
      hasUpstream: true,
    })
    rows.push({
      name: t.name, local: t.local, latest: res.latest, verdict: d.verdict, note: d.note,
      upstream: t.upstream.url, evidence: t.upstream.evidence,
      spec: redactSpec(t.spec), profiles: t.profiles,
    })
  }

  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<UpdateVerdict, number>
  for (const r of rows) counts[r.verdict] += 1

  const at = (opts.now ?? (() => new Date()))().toISOString()
  return {
    checkedAt: at,
    rows,
    coverage: {
      expected: scoped.length,
      queried: rows.length,
      missing: scoped.filter((t) => !rows.some((r) => r.name === t.name)).map((t) => t.name),
    },
    counts,
  }
}

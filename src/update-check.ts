/**
 * update-check.ts — 第三方插件上游更新检查的**纯逻辑层**（无 IO、无 Date.now、无 ctx；时间/结果全部注入）。
 *
 * 为什么单独一层（§5.30 + 技能 `dsh-plugin-testability`）：本模块的判据**错了不报错**——
 * 上游解析错了 → 静默「无更新」；版本比较错了 → 静默「已是最新」；漏查一个上游 →
 * 报出「全部最新」的假读数。三者都只在真相被核对时才暴露。故把判据抽成可离线单测的纯函数，
 * 网络与文件读取留在工具壳（index.ts）。
 *
 * 核心安全判据（2026-10-13 设计时审计出，最危险的一格）：
 * **core 相等但 prerelease 不同 ⇒ 判「不可比」，不判大小。**
 * 反例：`1.0.0-beta.5` vs `1.0.0-beta.10`——字符串比较给 `beta.10 < beta.5`（错），
 * 朴素数字比较给 `10 > 5`（也错）。semver 的 prerelease 比较是**分段标识符规则**，
 * 而多数上游并不保证可解析的 semver。⇒ 宁可不判，也不给可能反向的结论。
 */

/** 上游来源形态：能定位到「最新版本」的引用。 */
export interface UpstreamRef {
  /** 归一化的上游地址（如 `https://github.com/owner/repo`）；无则空串。 */
  url: string
  /** GitHub owner/repo（可用于 GitHub API）；非 GitHub 为 null。 */
  github: { owner: string; repo: string } | null
  /** npm 包名（可用于 registry 查询）；无则 null。 */
  npm: string | null
  /** 该引用的判定依据（写进读数，供人复核解析是否正确）。 */
  evidence: string
}

/** 一次更新判定的结果档位（闭集：不得互相掩盖——§5.30 语义精确性）。 */
export type UpdateVerdict =
  | 'update-available'   // 有更新（版本已比较且上游更新）
  | 'up-to-date'         // 已是最新（版本已比较且相同或本地更新）
  | 'not-comparable'     // 两侧版本都在手，但无法可靠比较（如 prerelease 差异）
  | 'no-upstream'        // 未配置上游源（package.json 与 spec 都无来源）
  | 'fetch-failed'       // 上游查询失败（网络/404/超时）——**不是「无更新」**
  | 'skipped'            // 未查询（如被 --only 过滤，或本地未装）

/** 一次比较的读数。 */
export interface CompareReading {
  /** -1 = 本地旧；0 = 相同；1 = 本地新；null = 不可比。 */
  cmp: number | null
  /** 不可比/边界时的可读原因（中文，进读数）。 */
  note?: string
}

/** 剥离常见前缀与元数据，取 prerelease 标识串（无则 null）。 */
function preOf(version: string): string | null {
  const s = version.trim().replace(/^v/i, '')
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(s)
  return m?.[4] ?? null
}

/** 取 semver 核心三段数字；解析不出（如日期版本、commit、非数字）返回 null。 */
function coreOf(version: string): [number, number, number] | null {
  const s = version.trim().replace(/^v/i, '')
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s)
  if (m === null) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/**
 * 比较两个版本串。
 *
 * 语义（取严）：**能可靠比较才给大小，否则 null**。
 * - 非 `major.minor.patch` 形态（如 `2024.10.13`、`abc1234`、`1.0`）⇒ null；`1.0` 不接受，
 *   因为补位假设会让 `1.0` 与 `1.0.0` 的判定依赖猜测。
 * - 核心三段相等且 prerelease 完全相同 ⇒ 0。
 * - 核心三段相等、一方无 prerelease ⇒ 无 prerelease 者更大（semver 既定语义，可可靠判定）。
 * - 核心三段相等、两侧都有**不同** prerelease ⇒ **null（不可比）**，见文件头反例。
 *
 * @param current - 本地已装版本。
 * @param latest - 上游最新版本。
 * @returns 比较读数（cmp 为 null 时 note 说明原因）。
 */
export function compareVersions(current: string, latest: string): CompareReading {
  const ca = coreOf(current)
  const cb = coreOf(latest)
  if (ca === null || cb === null) {
    return { cmp: null, note: `非 major.minor.patch 形态（本地=${JSON.stringify(current)} 上游=${JSON.stringify(latest)}）` }
  }
  for (let i = 0; i < 3; i += 1) {
    const a = ca[i] as number
    const b = cb[i] as number
    if (a < b) return { cmp: -1 }
    if (a > b) return { cmp: 1 }
  }
  const pa = preOf(current)
  const pb = preOf(latest)
  if (pa === null && pb === null) return { cmp: 0 }
  // 正式版 > 同核心的预发布版（semver 既定语义）。两侧符号**不可互换**：
  // 写反会让「本地正式版 vs 上游旧预发布」被判成有更新，进而建议向下降级
  // （2026-10-13 由 tests/update-check.test.mjs 当场抓出）。
  if (pa === null) return { cmp: 1, note: '本地为正式版、上游为预发布版' }
  if (pb === null) return { cmp: -1, note: '本地为预发布版、上游为正式版' }
  if (pa === pb) return { cmp: 0 }
  return { cmp: null, note: `预发布标识不同且不可排序（本地=${pa} 上游=${pb}）` }
}

/** 把任意 repository 字段形态归一成 URL 字符串；取不到返回 null。 */
function repositoryUrl(repository: unknown): string | null {
  if (typeof repository === 'string') return repository
  if (repository !== null && typeof repository === 'object') {
    const url = (repository as { url?: unknown }).url
    if (typeof url === 'string') return url
  }
  return null
}

/**
 * 从任意 URL/短写中提取 GitHub owner/repo。
 *
 * 覆盖实测遇到的形态：`git+https://…`、`git@github.com:owner/repo.git`、
 * `github:owner/repo#ref`、`https://…/repo.git`、带 `#fragment`/`.git` 后缀。
 * @param raw - 原始 URL 或短写。
 * @returns owner/repo；非 GitHub 或解析不出返回 null。
 */
export function parseGithub(raw: string): { owner: string; repo: string } | null {
  let s = raw.trim()
  if (s === '') return null
  s = s.replace(/^git\+/, '')
  const short = /^github:([^/\s#]+)\/([^/\s#]+)/i.exec(s)
  if (short !== null) {
    return { owner: short[1] as string, repo: stripGit(short[2] as string) }
  }
  const scp = /^git@github\.com:([^/\s]+)\/([^\s#]+)/i.exec(s)
  if (scp !== null) {
    return { owner: scp[1] as string, repo: stripGit(scp[2] as string) }
  }
  const http = /^https?:\/\/(?:[^/@\s]+@)?(?:www\.)?github\.com\/([^/\s#]+)\/([^\s#?]+)/i.exec(s)
  if (http !== null) {
    return { owner: http[1] as string, repo: stripGit(http[2] as string) }
  }
  return null
}

/** 去掉 `.git` 后缀与尾部斜杠。 */
function stripGit(s: string): string {
  return s.replace(/\.git$/i, '').replace(/\/+$/, '')
}

/**
 * 解析一个第三方插件的上游来源。
 *
 * 优先级：profile 依赖 spec 里的 github 短写与 git URL **优先**（那是安装时真正用到的来源），
 * 其次 package.json 的 `repository`，最后 `homepage`。命中即返回，并在 `evidence` 里写明依据，
 * 供复核「它为什么这么判」。
 *
 * @param input - 已装包的元数据 + profile 依赖声明。
 * @returns 上游引用；三个来源都无 GitHub 线索时返回覆盖度为 0 的引用（url 为空串）。
 */
export function resolveUpstream(input: {
  /** 依赖名（同时是 npm 包名候选）。 */
  name: string
  /** profile package.json 里的依赖声明原文（未脱敏，本函数不落盘）。 */
  spec: string
  /** 已装包 package.json 的 repository 字段（任意形态）。 */
  repository?: unknown
  /** 已装包 package.json 的 homepage。 */
  homepage?: unknown
}): UpstreamRef {
  const candidates: { raw: string; evidence: string }[] = []
  const specGithub = /^(?:github:|git\+ssh:\/\/git@github\.com\/|git\+https:\/\/github\.com\/|https:\/\/github\.com\/)/i.exec(input.spec.trim())
  if (specGithub !== null) candidates.push({ raw: input.spec, evidence: `profile spec = ${specGithub[0]}…` })

  const repoUrl = repositoryUrl(input.repository)
  if (repoUrl !== null) candidates.push({ raw: repoUrl, evidence: 'package.json repository' })
  if (typeof input.homepage === 'string') candidates.push({ raw: input.homepage, evidence: 'package.json homepage' })

  for (const c of candidates) {
    const gh = parseGithub(c.raw)
    if (gh !== null) {
      return {
        url: `https://github.com/${gh.owner}/${gh.repo}`,
        github: gh,
        npm: null,
        evidence: c.evidence,
      }
    }
  }
  return { url: '', github: null, npm: null, evidence: '未找到 GitHub 线索（repository/homepage/spec 均无）' }
}

/**
 * 判定一条更新检查结果（纯决策，输入已全部取好）。
 *
 * 分档互不掩盖：查询失败**不是**「无更新」，不可比**不是**「已是最新」。
 * @param local - 本地已装版本（空串 = 未解析到版本）。
 * @param latest - 上游最新版本；null = 未查询/查询失败。
 * @param fetchError - 查询失败原因；非空即判 `fetch-failed`。
 * @param hasUpstream - resolveUpstream 是否找到可用线索。
 * @param skipped - 是否本次未查询。
 * @returns 判定档位 + 比较读数（可选）+ 可读说明。
 */
export function decideUpdate(input: {
  local: string
  latest: string | null
  fetchError?: string
  hasUpstream: boolean
  skipped?: boolean
}): { verdict: UpdateVerdict; compare?: CompareReading; note: string } {
  if (input.skipped === true) return { verdict: 'skipped', note: '本次未查询' }
  if (!input.hasUpstream) return { verdict: 'no-upstream', note: '未配置可识别的上游源' }
  if (input.fetchError !== undefined && input.fetchError !== '') {
    return { verdict: 'fetch-failed', note: input.fetchError }
  }
  if (input.latest === null || input.latest === '') {
    return { verdict: 'fetch-failed', note: '上游未返回版本' }
  }
  if (input.local === '') {
    return { verdict: 'fetch-failed', note: '本地版本未知（package.json 读不到 version）' }
  }
  const compare = compareVersions(input.local, input.latest)
  if (compare.cmp === null) {
    return { verdict: 'not-comparable', compare, note: compare.note ?? '不可比' }
  }
  if (compare.cmp < 0) return { verdict: 'update-available', compare, note: `本地 ${input.local} → 上游 ${input.latest}` }
  return { verdict: 'up-to-date', compare, note: compare.note ?? `本地 ${input.local} = 上游 ${input.latest}` }
}

/**
 * 覆盖度对账：**每条待查上游都必须有查询结果**。
 *
 * 存在理由（我 2026-10 那次成本审计的同族失误）：一次截断的读数会被当成完整证据，
 * 于是「漏查 N 个上游」被静默读成「这些都查过了、都没更新」。本函数把它变成响亮失败。
 *
 * @param expected - 本次**应当**被查询的上游标识（通常是插件名）。
 * @param queried - 实际产出了查询结果的标识。
 * @returns 未查询的标识列表（空数组 = 覆盖完整）。
 */
export function unresolvedCoverage(
  expected: readonly string[],
  queried: readonly string[],
): string[] {
  const done = new Set(queried)
  return expected.filter((name) => !done.has(name))
}

/** 单条更新检查结果的汇总行（供渲染层用，纯字符串）。 */
export function updateLine(row: {
  name: string
  local: string
  latest: string | null
  verdict: UpdateVerdict
  note: string
}): string {
  const mark: Record<UpdateVerdict, string> = {
    'update-available': '↑ 有更新',
    'up-to-date': '= 已最新',
    'not-comparable': '? 不可比',
    'no-upstream': '· 无上游源',
    'fetch-failed': '! 查询失败',
    skipped: '- 已跳过',
  }
  const latest = row.latest === null ? '—' : row.latest
  return `${mark[row.verdict]}  ${row.name}  本地 ${row.local || '?'} / 上游 ${latest}  ${row.note}`
}

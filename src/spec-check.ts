/**
 * 自研插件规范自检（2026-10-30）
 *
 * 判据来自两处，每条都写清它为什么算违规：
 * - 官方 `deepseek-harness/AGENTS.md`：ESM 无例外 · 源码面与产物面不混 · 宿主包归 peer · 配置错误响亮失败
 * - 自研公约：有测试 · README 有实质内容 · 构建产物不旧于源码
 *
 * **只做机械可判的项。** 三条能扫出候选但判不了的**刻意不做**，因为做了等于给假绿：
 * 1. `DEFAULT_*` 常量 —— 官方禁的是「部署会变的调参」，协议常量不违规，词法上无法区分；
 * 2. waterfall 监听器是否调了 `next()` —— 参数名可变，且并非所有 `a/b` 事件都是 waterfall；
 * 3. disposer 是否齐全 —— 要真跑一次卸载，静态扫不出。
 *
 * 另有三类要类型检查器或读 tsconfig 结构（branded id / Host-Client 面分离 / Model-visible ⟺ logged），
 * 也不在此列。工具的输出里必须带上这段边界，否则「零问题」会被读成「全部合规」。
 */

export type SpecIssueKind =
  | 'not-esm'
  | 'no-entry'
  | 'entry-to-src'
  | 'host-in-deps'
  | 'bundle-patch-missing'
  | 'no-tests'
  | 'readme-thin'
  | 'no-lib'
  | 'stale-lib'

export interface SpecIssue {
  kind: SpecIssueKind
  detail: string
}

/** 一个插件包的已解析形态：判据只看这些字段，读写留给调用方。 */
export interface PluginSpecInput {
  name: string
  /** `package.json.type` */
  type?: string
  /** `main` + `exports` 里能取到的全部路径字符串 */
  entryPaths: string[]
  /** `dependencies` 的键（只关心有没有宿主包混进来） */
  dependencyKeys: string[]
  /** `dsh.bundle.patch` 声明的相对路径；未声明为 undefined */
  bundlePatch?: string
  /** 该 patch 文件在磁盘上是否真的存在 */
  bundlePatchExists: boolean
  /** `tests/` 下条目数（0 = 无测试） */
  testCount: number
  /** README.md 字节数（0 = 无 README） */
  readmeBytes: number
  hasLib: boolean
  /** `lib/` 下最新 mtime；无 lib 为 null */
  libNewestMs: number | null
  /** `src/` 下最新 mtime；无 src 为 null */
  srcNewestMs: number | null
}

const README_MIN_BYTES = 200

/**
 * 把毫秒差写成可读时长。
 *
 * 不足 1 分钟**必须报秒**：第一版直接 `Math.round(ms/60000)`，实测把 4 秒的陈旧度报成
 * 「src 比 lib 新 0 分钟」——一个读起来像「没问题」的形状，正好是最需要看清的那种读数。
 */
function describeAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`
  return `${(ms / 3_600_000).toFixed(1)} 小时`
}

/**
 * 判定单个插件是否违反规范。
 *
 * @param input 已解析的插件形态（纯数据，不做 IO）
 * @returns 违规清单；空数组 = 这九项全部通过
 */
export function checkPluginSpec(input: PluginSpecInput): SpecIssue[] {
  const issues: SpecIssue[] = []

  // ESM 无例外——CJS 在 current engines 下加载路径不同，混用会在 source-launch 与产物面之间分叉。
  if (input.type !== 'module') issues.push({ kind: 'not-esm', detail: `type=${input.type ?? 'undefined'}` })

  // 入口必须指向构建产物：源码面与产物面混用会让「改了源码」与「跑的是哪份」失去可判定性。
  if (input.entryPaths.length === 0) {
    issues.push({ kind: 'no-entry', detail: 'main 与 exports 都缺' })
  }
  const toSrc = input.entryPaths.filter((p) => /\bsrc\//.test(p))
  if (toSrc.length > 0) issues.push({ kind: 'entry-to-src', detail: toSrc.join(', ') })

  // 宿主包进 dependencies 会拉出第二份宿主实例（双实例症状是服务注册冲突，且极难从报错定位）。
  const hostInDeps = input.dependencyKeys.filter((k) => k.startsWith('@deepseek-ai/'))
  if (hostInDeps.length > 0) issues.push({ kind: 'host-in-deps', detail: hostInDeps.join(', ') })

  // 声明了 bundle patch 就必须有那个文件——声明与实物不一致会让装配静默少一行。
  if (input.bundlePatch !== undefined && !input.bundlePatchExists) {
    issues.push({ kind: 'bundle-patch-missing', detail: input.bundlePatch })
  }

  // 测试：判据不是覆盖率，是「有没有一个能跑起来看见红的入口」。
  if (input.testCount === 0) issues.push({ kind: 'no-tests', detail: 'tests/ 为空或不存在' })

  // README 太薄等于没有：模型与人都靠它判断这个插件干什么。
  if (input.readmeBytes < README_MIN_BYTES) {
    issues.push({ kind: 'readme-thin', detail: `${input.readmeBytes}B < ${README_MIN_BYTES}B` })
  }

  // 产物面缺失：mounted 却没有 lib/ 的插件靠 loader 兜，症状是启动期才炸。
  if (!input.hasLib) {
    issues.push({ kind: 'no-lib', detail: 'lib/ 不存在（未构建）' })
  } else if (input.srcNewestMs !== null && input.libNewestMs !== null && input.srcNewestMs > input.libNewestMs) {
    issues.push({ kind: 'stale-lib', detail: `src 比 lib 新 ${describeAge(input.srcNewestMs - input.libNewestMs)}` })
  }

  return issues
}

export interface SpecRow {
  name: string
  issues: SpecIssue[]
}

export interface SpecSummary {
  scanned: number
  clean: number
  byKind: Array<{ kind: SpecIssueKind; count: number }>
  rows: SpecRow[]
}

/**
 * 汇总全量扫描结果，按违规类别计数（降序）。
 *
 * @param rows 每个插件的判定结果
 * @returns 计数与有事项的行（干净行不进 rows）
 */
export function summarizeSpec(rows: SpecRow[]): SpecSummary {
  const byKind = new Map<SpecIssueKind, number>()
  for (const row of rows) {
    for (const issue of row.issues) byKind.set(issue.kind, (byKind.get(issue.kind) ?? 0) + 1)
  }
  return {
    scanned: rows.length,
    clean: rows.filter((r) => r.issues.length === 0).length,
    byKind: [...byKind].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    rows: rows.filter((r) => r.issues.length > 0),
  }
}

/** 输出里必须带的边界声明——缺了它，「零问题」会被读成「全部合规」。 */
export const SPEC_CHECK_LIMITS =
  '本检查覆盖 9 项机械判据。未覆盖：DEFAULT_* 调参（协议常量与部署调参词法上不可分）· waterfall 是否调用 next()（参数名可变、事件不全是 waterfall）· disposer 齐全（需真跑卸载）· branded id · Host/Client 面分离 · Model-visible ⟺ logged。'

/**
 * 渲染成可读报告。
 *
 * @param summary 汇总结果
 * @returns 多行文本；无违规时给明确的通过陈述
 */
export function formatSpecReport(summary: SpecSummary): string {
  const head = `扫描 ${summary.scanned} 个自研插件 · 有事项 ${summary.rows.length} · 干净 ${summary.clean}`
  if (summary.rows.length === 0) return `${head}\n\n九项判据全部通过。\n⚠ ${SPEC_CHECK_LIMITS}`
  const kinds = summary.byKind.map((k) => `  ${String(k.count).padStart(3)}  ${k.kind}`).join('\n')
  const rows = summary.rows
    .map((r) => `${r.name.padEnd(34)} ${r.issues.map((i) => `${i.kind}(${i.detail})`).join(' | ')}`)
    .join('\n')
  return `${head}\n\n按类别：\n${kinds}\n\n明细：\n${rows}\n\n⚠ ${SPEC_CHECK_LIMITS}`
}

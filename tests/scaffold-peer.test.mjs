/**
 * tests/scaffold-peer.test.mjs — 脚手架 peer 范围守卫（2026-10-15 · 台账 lh-ff4ea783）。
 *
 * 事故形态：模板把 `@deepseek-ai/dsh-tools` 的 peer 写成 `^0.1.0-rc.6`（semver 上 = `>=0.1.0-rc.6 <0.2.0`），
 * 宿主升到 0.2.1-alpha.2 后兼容门（app-boot/src/plugin-compatibility.ts:77）判失败 ⇒ **静默 disable**：
 * 挂载返回成功、patch 行也在，但一行不生效，只有 err 级日志（不进模型视野）。
 *
 * 判据标定（§5.35）：域内正确性用**宿主侧真实 semver 库**做金标准——从 app-boot 位置解析
 * `semver`（宿主自己 import 的就是它），逐对断言
 * `satisfiesRange(r, v) === semver.satisfies(v, r, { includePrerelease: true })`。
 * 解析不到 semver ⇒ 该组 SKIP（**不假装通过**）。
 * 跑法：node --test tests/scaffold-peer.test.mjs（先 tsc -p tsconfig.json 构建）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  isDshPeerChecked,
  peerSatisfactionIssues,
  satisfiesRange,
  SCAFFOLD_PEER_DEPS,
  SCAFFOLD_PNPM_WORKSPACE,
  workspaceFileIssues,
} from '../lib/ops-logic.js'

/** 宿主真实运行时版本（2026-10-15 实测：app-boot 与 dsh-tools 同号）。 */
const HOST = '0.2.1-alpha.2'

// ── 宿主侧 semver 金标准（可选：解析不到则相关组 SKIP）────────────────
let hostSemver = null
try {
  const req = createRequire(import.meta.url)
  const bootPkg = req.resolve('@deepseek-ai/dsh-app-boot/package.json')
  hostSemver = createRequire(bootPkg)('semver')
} catch {
  hostSemver = null
}

// ── 核心判据（任务的判据核心，不依赖 semver 库）────────────────────────
test('核心判据：>= 满足宿主 0.2.1-alpha.2，^ 不满足（同一版本对）', () => {
  assert.equal(satisfiesRange('>=0.1.0-rc.6', HOST), true)
  assert.equal(satisfiesRange('^0.1.0-rc.6', HOST), false)
})

test('SCAFFOLD_PEER_DEPS：dsh-tools 用 >= 而非 ^（回归判据）', () => {
  const range = SCAFFOLD_PEER_DEPS['@deepseek-ai/dsh-tools']
  assert.ok(range.startsWith('>='), '实际值: ' + range)
  assert.ok(!range.startsWith('^'), '实际值: ' + range)
})

test('全通过时对账为空数组（正向：当前常量对当前宿主 OK）', () => {
  assert.deepEqual(peerSatisfactionIssues(SCAFFOLD_PEER_DEPS, HOST), [])
})

// ── 判据域：只覆盖宿主门检查的 dsh-* 前缀（不误报）──────────────────────
test('isDshPeerChecked：只有 @deepseek-ai/dsh / dsh-* 被门检查', () => {
  assert.equal(isDshPeerChecked('@deepseek-ai/dsh'), true)
  assert.equal(isDshPeerChecked('@deepseek-ai/dsh-tools'), true)
  assert.equal(isDshPeerChecked('@deepseek-ai/cordis'), false)
  assert.equal(isDshPeerChecked('@deepseek-ai/schemastery'), false)
  assert.equal(isDshPeerChecked('semver'), false)
})

test('尸体：cordis/schemastery 超出判据域也不进对账（与宿主门同域）', () => {
  // 若把 cordis 也纳入对账，这条会变成 1 条问题行——它证明「跳过」是真的跳过
  const withBadCordis = { ...SCAFFOLD_PEER_DEPS, '@deepseek-ai/cordis': '~1.0.0' }
  assert.deepEqual(peerSatisfactionIssues(withBadCordis, HOST), [])
})

// ── 尸体样本（§5.9 规则 2：证明判据真会拦）──────────────────────────────
test('尸体：常量退回 ^ 形态 ⇒ 对账必须报「不满足」', () => {
  const broken = { ...SCAFFOLD_PEER_DEPS, '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' }
  const issues = peerSatisfactionIssues(broken, HOST)
  assert.equal(issues.length, 1, '应恰好 1 条：' + JSON.stringify(issues))
  assert.match(issues[0], /不满足/)
  assert.match(issues[0], /静默/)
})

test('尸体：宿主版本读不到 ⇒ 报「未判定」，不得静默通过', () => {
  const issues = peerSatisfactionIssues(SCAFFOLD_PEER_DEPS, null)
  assert.equal(issues.length, 1, '应恰好 1 条：' + JSON.stringify(issues))
  assert.match(issues[0], /未判定/)
})

test('尸体：形态超出判据域 ⇒ null（不是 true，也不是 false）', () => {
  for (const r of ['~1.0.0', '*', 'latest', '', '1.x', '>=1.0.0 <2.0.0', '^1 || ^2']) {
    assert.equal(satisfiesRange(r, '1.0.0'), null, 'range=' + JSON.stringify(r))
  }
  // 版本不可解析同样 null
  assert.equal(satisfiesRange('>=1.0.0', 'not-a-version'), null)
})

test('尸体：形态超域进对账时标「未判定」而非通过', () => {
  const weird = { '@deepseek-ai/dsh-tools': '~0.2.0' }
  const issues = peerSatisfactionIssues(weird, HOST)
  assert.equal(issues.length, 1)
  assert.match(issues[0], /未判定/)
})

// ── semver 边界（金标准：与宿主侧真实库逐对一致）───────────────────────
const GOLDEN_PAIRS = [
  ['>=0.1.0-rc.6', HOST],
  ['^0.1.0-rc.6', HOST],
  ['^0.1.0-rc.6', '0.1.0-rc.6'],
  ['^0.1.0-rc.6', '0.1.9'],
  ['^0.1.0-rc.6', '0.2.0'],
  ['^0.1.0-rc.6', '0.2.0-alpha'],
  ['^4.0.1', '4.0.5-alpha.1'],
  ['^4.0.1', '4.0.1'],
  ['^4.0.1', '5.0.0'],
  ['^3.18.1-rc.1', '3.18.5-alpha.1'],
  ['^0.2.3', '0.3.0'],
  ['^0.0.3', '0.0.4'],
  ['^1.2.3', '1.9.9'],
  ['^1.2.3', '2.0.0'],
  ['1.2.3', '1.2.3'],
  ['1.2.3', '1.2.4'],
  ['>=1.0.0', '0.9.9'],
  ['>=1.0.0-rc.1', '1.0.0-rc.2'],
]

test('金标准：域内判据与宿主侧真实 semver 逐对一致', { skip: hostSemver ? false : '宿主侧 semver 不可解析' }, () => {
  const diffs = []
  for (const [range, version] of GOLDEN_PAIRS) {
    const mine = satisfiesRange(range, version)
    const theirs = hostSemver.satisfies(version, range, { includePrerelease: true })
    if (mine !== theirs) diffs.push(`${range} vs ${version}: mine=${mine} theirs=${theirs}`)
  }
  assert.deepEqual(diffs, [], '与宿主 semver 分歧:\n' + diffs.join('\n'))
})

/**
 * 穷举对账：手挑的 18 对分辨力有限（挑的人可能挑对自己有利的），这里在网格上
 * 逐对比较——**判据的方向错比内容错更难发现**，样本量本身也是判据的一部分。
 */
test('金标准·穷举对账：网格样本上与宿主 semver 零分歧', { skip: hostSemver ? false : '宿主侧 semver 不可解析' }, () => {
  const versions = []
  for (const ma of [0, 1, 2]) {
    for (const mi of [0, 1, 3]) {
      for (const pa of [0, 5]) {
        for (const pre of ['', '-rc.1', '-alpha.2']) {
          versions.push(`${ma}.${mi}.${pa}${pre}`)
        }
      }
    }
  }
  const ranges = []
  for (const v of versions) {
    ranges.push('^' + v, '>=' + v)
  }
  let checked = 0
  const diffs = []
  for (const range of ranges) {
    for (const version of versions) {
      const mine = satisfiesRange(range, version)
      if (mine === null) continue // 域外：本判据不承诺（另由尸体组覆盖）
      checked++
      const theirs = hostSemver.satisfies(version, range, { includePrerelease: true })
      if (mine !== theirs) diffs.push(`${range} vs ${version}: mine=${mine} theirs=${theirs}`)
    }
  }
  assert.ok(checked >= 500, '样本量过低，判据无分辨力: ' + checked)
  assert.deepEqual(diffs.slice(0, 10), [], `分歧 ${diffs.length} 处（前 10）:\n` + diffs.slice(0, 10).join('\n'))
})

// ── pnpm-workspace.yaml 守卫（t-cc516d56：同形状的第二个模板缺口）──────────
test('SCAFFOLD_PNPM_WORKSPACE：含顶层 autoInstallPeers: false（防 peer 被装成真实副本）', () => {
  assert.match(SCAFFOLD_PNPM_WORKSPACE, /^autoInstallPeers:\s*false\s*$/m)
  assert.deepEqual(workspaceFileIssues(SCAFFOLD_PNPM_WORKSPACE), [])
})

test('尸体：内容缺 autoInstallPeers: false ⇒ 必须报出（判据真会拦）', () => {
  const broken = SCAFFOLD_PNPM_WORKSPACE.replace('autoInstallPeers: false', 'autoInstallPeers: true')
  const issues = workspaceFileIssues(broken)
  assert.equal(issues.length, 1, '应恰好 1 条：' + JSON.stringify(issues))
  assert.match(issues[0], /autoInstallPeers/)
  assert.match(issues[0], /遮蔽/)
})

test('尸体：空文件 / 只留注释 ⇒ 同样报出（不静默通过）', () => {
  assert.equal(workspaceFileIssues('').length, 1)
  assert.equal(workspaceFileIssues('# 注释\n').length, 1)
})

test('尸体：缩进的 autoInstallPeers 不算（必须是顶层键——嵌套在别处不生效）', () => {
  assert.equal(workspaceFileIssues('  autoInstallPeers: false\n').length, 1)
})

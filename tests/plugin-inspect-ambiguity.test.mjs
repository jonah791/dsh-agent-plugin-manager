/**
 * tests/plugin-inspect-ambiguity.test.mjs —— 「同名多行」读数的回归夹具（台账 lh-bfd83116）。
 *
 * **事故形状**：`.dsh/profiles/web/cordis.patch.yml` 里有两行 `name: 'ds-harness-remote'`，
 * id 分别是 `ds-harness-remote`（host，`disabled: false`）与 `ds-harness-remote-tui`
 * （tui，`disabled: true`）。档案与 loader 快照**都按 name 折叠**，而 `alignWithLoader` 的
 * `byName.set(...)` 是**后写覆盖** ⇒ 停用那条盖掉启用那条 ⇒ `plugin_inspect({name:'ds-harness-remote'})`
 * 报 `status: "disabled"`，而 host 版一直在跑（`.watch-web.log` 的 `[dsh-remote]` 在本次启动标记
 * 之后仍在打日志）。同一个错读数骗过两次（2026-10-31、2026-11-08）——前两次「修好了」都是
 * 修对了代码、**验错了仪器**（验的是单行场景）。
 *
 * **所以本夹具的判据不是「代码里有 id」，而是「同名场景下读数不歧义」**：
 *  ① 输出必须带 id / 逐行 patchRows；
 *  ② 状态不得静默指向「另一行」（尸体：旧实现会返回 disabled）；
 *  ③ 状态冲突必须写进 ambiguity，并给出「请用 id」。
 *
 * 跑法：node --test tests/plugin-inspect-ambiguity.test.mjs（先 tsc -p tsconfig.json 构建）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePatchRows, resolvePatchStatus, collectPatchRows, alignWithLoader,
} from '../lib/registry.js'
import { loaderSnapshotOf, publicArchive } from '../lib/ops-logic.js'

/** 真实事故形态的等价夹具：两行同 name、不同 id、disabled 相反。 */
const PATCH_SAME_NAME = `- insert:
    - id: ds-harness-remote
      name: 'ds-harness-remote'
      disabled: false
      config:
        enabled: true
        role: host
    - id: ds-harness-remote-tui
      name: 'ds-harness-remote'
      disabled: true
      inject: [ webServer ]
`

/** 一行一条的正常形态（对照组：不得被歧义逻辑误伤）。 */
const PATCH_SINGLE = `- insert:
    - id: agent-memory
      name: dsh-agent-memory
      disabled: false
`

/** 把 patch 文本经真实解析器变成「一个 profile 的扫描结果」。 */
const profileOf = (text, profile = 'web') => ([{ profile, rows: parsePatchRows(text), bundles: [] }])

/** 最小档案（只填被测字段；对齐逻辑不碰别的）。 */
const archiveOf = (name, patchRows) => ({
  name, version: '0.0.0', source: 'third-party', path: null, purpose: '', category: '',
  client: false, tools: [], built: true, status: 'unmounted', profiles: [], config: {},
  updatedAt: '2026-11-12T00:00:00.000Z', patchRows,
})

// ── ① 文件层：同名两行必须**都被收集**（旧写法 rows.find 只给第一行）────────────
test('老实的收集：两行同 name 不同 id ⇒ collectPatchRows 两条都在，且各带 id 与 disabled', () => {
  const rows = collectPatchRows(profileOf(PATCH_SAME_NAME), 'ds-harness-remote')
  assert.equal(rows.length, 2, '同名两行必须都被收集（.find 会丢一条）')
  assert.deepEqual(rows.map((r) => r.id).sort(), ['ds-harness-remote', 'ds-harness-remote-tui'])
  assert.deepEqual(
    rows.filter((r) => !r.disabled).map((r) => r.id), ['ds-harness-remote'],
    '启用行必须能按 id 被单独指认（host 版）',
  )
  assert.deepEqual(
    rows.filter((r) => r.disabled).map((r) => r.id), ['ds-harness-remote-tui'],
    '停用行必须能按 id 被单独指认（tui 版）',
  )
})

test('收集不制造假歧义：单行 patch ⇒ 一条、无 ambiguity', () => {
  const rows = collectPatchRows(profileOf(PATCH_SINGLE), 'dsh-agent-memory')
  assert.equal(rows.length, 1)
  const resolved = resolvePatchStatus('dsh-agent-memory', rows)
  assert.equal(resolved.status, 'mounted')
  assert.equal(resolved.ambiguity, undefined)
})

test('没有行 ⇒ resolvePatchStatus 返回 null（调用方保留自己的兜底，不编状态）', () => {
  assert.equal(resolvePatchStatus('nope', []), null)
})

// ── ② 状态推导：冲突时不猜，且文案点名两个 id + 请用 id ────────────────────
test('★ 冲突态：启停不一致 ⇒ status 不塌缩成 disabled，且 ambiguity 点名两个 id 并要求改用 id', () => {
  const rows = collectPatchRows(profileOf(PATCH_SAME_NAME), 'ds-harness-remote')
  const resolved = resolvePatchStatus('ds-harness-remote', rows)
  assert.equal(resolved.status, 'mounted', '有一行在跑 ⇒ 插件在跑（旧行为会读成 disabled）')
  assert.ok(resolved.ambiguity, '冲突必须写进 ambiguity，不得静默')
  assert.match(resolved.ambiguity, /ds-harness-remote-tui/)
  assert.match(resolved.ambiguity, /请用 id/)
})

// ── ③ loader 对齐：**这是事故真正发生的那一层** ────────────────────────────
test('★ loader 两条同名条目（带 id）⇒ 不得被后写的 disabled 那条覆盖', () => {
  const rows = collectPatchRows(profileOf(PATCH_SAME_NAME), 'ds-harness-remote')
  const arch = archiveOf('ds-harness-remote', rows)
  const entries = loaderSnapshotOf([
    { options: { id: 'ds-harness-remote', name: 'ds-harness-remote' } },
    { options: { id: 'ds-harness-remote-tui', name: 'ds-harness-remote' }, disabled: true },
  ])
  assert.equal(entries.length, 2)
  assert.deepEqual(entries.map((e) => e.id), ['ds-harness-remote', 'ds-harness-remote-tui'], '快照必须带 id')
  alignWithLoader([arch], entries)
  assert.notEqual(arch.status, 'disabled', '尸体：旧实现（按 name 后写覆盖）在这里返回 disabled')
  assert.equal(arch.status, 'mounted')
  assert.ok(arch.ambiguity, '同名多条入口径不一致必须被写下，不得静默')
})

test('★ loader 只有启用那条（停用行不进 loader）⇒ 必须读成 mounted，与 patch 行一致', () => {
  const rows = collectPatchRows(profileOf(PATCH_SAME_NAME), 'ds-harness-remote')
  const arch = archiveOf('ds-harness-remote', rows)
  alignWithLoader([arch], loaderSnapshotOf([{ options: { id: 'ds-harness-remote', name: 'ds-harness-remote' } }]))
  assert.equal(arch.status, 'mounted')
})

test('★ 无 id 的 loader 快照（形状退化）⇒ 也不许后写覆盖成 disabled', () => {
  const rows = collectPatchRows(profileOf(PATCH_SAME_NAME), 'ds-harness-remote')
  const arch = archiveOf('ds-harness-remote', rows)
  // 模拟「loader 条目没带 id」的最坏输入：同名两条，一启用一停用
  alignWithLoader([arch], [
    { name: 'ds-harness-remote', enabled: true },
    { name: 'ds-harness-remote', enabled: false },
  ])
  assert.notEqual(arch.status, 'disabled', '无 id 时也不能静默取最后一条')
  assert.ok(arch.ambiguity, '无 id 的冲突同样必须可见')
})

test('回归保护：单行插件对齐行为不变（启用 ⇒ mounted + 入 web；停用 ⇒ disabled）', () => {
  const rows = collectPatchRows(profileOf(PATCH_SINGLE), 'dsh-agent-memory')
  const on = archiveOf('dsh-agent-memory', rows)
  alignWithLoader([on], [{ name: 'dsh-agent-memory', id: 'agent-memory', enabled: true }])
  assert.equal(on.status, 'mounted')
  assert.deepEqual(on.profiles, ['web'])

  const off = archiveOf('dsh-agent-memory', rows)
  alignWithLoader([off], [{ name: 'dsh-agent-memory', id: 'agent-memory', enabled: false }])
  assert.equal(off.status, 'disabled')
})

// ── ④ 工具面投影：输出必须带 id，否则「请用 id」是一句空话 ──────────────────
test('★ plugin_inspect 输出（publicArchive）带 id / patchRows / ambiguity，且 config 仍脱敏', () => {
  const rows = collectPatchRows(profileOf(PATCH_SAME_NAME), 'ds-harness-remote')
  const arch = archiveOf('ds-harness-remote', rows)
  arch.id = 'ds-harness-remote' // buildRegistry 在单 id 时补的字段
  arch.ambiguity = 'x'
  arch.config = { token: 'super-secret' }
  const out = publicArchive(arch)
  assert.equal(out.id, 'ds-harness-remote', '输出必须带 id（「请用 id」这句建议要能兑现）')
  assert.ok(Array.isArray(out.patchRows) && out.patchRows.length === 2, '逐行 id/disabled 必须投影出去')
  assert.deepEqual(out.patchRows.map((r) => r.id).sort(), ['ds-harness-remote', 'ds-harness-remote-tui'])
  assert.equal(out.ambiguity, 'x')
  assert.equal(out.config.token, '[redacted]', '新增字段不得顺手把 config 脱敏弄丢')
})

test('投影不造假：没有 patchRows/id/ambiguity 的档案，输出里就不出现这些键', () => {
  const out = publicArchive({ ...archiveOf('plain', undefined), patchRows: undefined })
  assert.equal('id' in out, false)
  assert.equal('patchRows' in out, false)
  assert.equal('ambiguity' in out, false)
})

// ── ⑤ buildRegistry 层：同名多行时 `id` 给谁（对真实目录跑，不用桩）────────────────
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRegistry } from '../lib/registry.js'

/** 造一个最小可扫的 self-plugins + profiles 目录树（只有判据需要的文件）。 */
function fixture(selfPluginsDir, profilesDir, patchText) {
  mkdirSync(join(selfPluginsDir, 'foo'), { recursive: true })
  writeFileSync(join(selfPluginsDir, 'foo', 'package.json'),
    JSON.stringify({ name: 'foo', version: '0.1.0', description: '某插件：做点事' }), 'utf8')
  const web = join(profilesDir, 'web')
  mkdirSync(web, { recursive: true })
  writeFileSync(join(web, 'package.json'),
    JSON.stringify({ name: 'web', dependencies: {}, dsh: { profile: { bundles: [] } } }), 'utf8')
  writeFileSync(join(web, 'cordis.patch.yml'), patchText, 'utf8')
}

test('★ buildRegistry：同名两行、只有一行启用 ⇒ id 给**在跑的那行**，且 ambiguity 仍在', () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-registry-'))
  fixture(join(root, 'self-plugins'), join(root, 'profiles'), PATCH_SAME_NAME.replaceAll('ds-harness-remote', 'foo'))
  const reg = buildRegistry(join(root, 'self-plugins'), join(root, 'profiles'))
  const a = reg.find((x) => x.name === 'foo')
  assert.ok(a, '插件档案应存在')
  assert.deepEqual(a.patchRows.map((r) => r.id).sort(), ['foo', 'foo-tui'])
  assert.equal(a.id, 'foo', 'id = 唯一启用的那行（按 name 查时读者最想问的就是哪个在跑）')
  assert.ok(a.ambiguity, '同名的另一行仍要可见（不许被 id 掩盖）')
  assert.match(a.ambiguity, /foo-tui/)
  assert.equal(a.status, 'mounted')
})

test('★ buildRegistry：两行都启用 ⇒ 没有唯一答案，不给 id，只给逐行清单', () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-registry2-'))
  const patch = `- insert:\n    - id: foo\n      name: foo\n    - id: foo-a\n      name: foo\n`
  fixture(join(root, 'self-plugins'), join(root, 'profiles'), patch)
  const reg = buildRegistry(join(root, 'self-plugins'), join(root, 'profiles'))
  const a = reg.find((x) => x.name === 'foo')
  assert.equal(a.id, undefined, '两个都在跑 ⇒ 不猜')
  assert.deepEqual(a.patchRows.map((r) => r.id).sort(), ['foo', 'foo-a'])
})

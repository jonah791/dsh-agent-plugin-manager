/**
 * tests/patch-js-tag.test.mjs —— `!!js` 标签中和 + patch 解析的 config 回归。
 *
 * **为什么必须有这组夹具**（任务 t-e35c5ef6）：
 * `plugin_inspect` 的 `config` 曾**恒为 `{}`** 长达 10 天。根因：profile patch 含 cordis 专有的
 * `!!js <表达式>` 标签 ⇒ 标准 YAML 解析器每次都抛 ⇒ 永远走文本回退 ⇒ 而回退**不抓 config**。
 * 这一缺陷**没有任何测试覆盖**（所以活了 10 天）。
 *
 * **尸体的意义**：本组第 2 条用例是**修复前必失败的形态**——夹具同时含 `!!js` 与带 config 的行。
 * 若将来有人回退这次修复（例如把 `neutralizeJsTags` 摘掉），它会立刻转红。
 *
 * 跑法：node --test tests/patch-js-tag.test.mjs（先 tsc -p tsconfig.json 构建）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { neutralizeJsTags, parsePatchRows } from '../lib/registry.js'

/** 带 `!!js` 标签 + 带 config 的 patch 夹具（**模拟真实 profile patch 的形态**）。 */
const PATCH_WITH_JS = `- insert:
    - id: no-win
      name: some-plugin
      disabled: !!js process.platform !== 'win32'
    - id: self-rewrite
      name: dsh-agent-self-rewrite
      config:
        maxBytes: 64800
        evolveDataDir: E:/alice/.evolve
    - id: win-only
      name: other-plugin
      disabled: !!js process.platform === 'win32'
`

/** **对照夹具**：结构相同但没有 `!!js`（走 YAML 分支的干净路径）。 */
const PATCH_PLAIN = `- insert:
    - id: self-rewrite
      name: dsh-agent-self-rewrite
      config:
        maxBytes: 64800
        evolveDataDir: E:/alice/.evolve
`

// ── neutralizeJsTags ────────────────────────────────────────────────────
test('neutralizeJsTags：把 !!js 表达式中和成带引号的占位标量', () => {
  const out = neutralizeJsTags("disabled: !!js process.platform !== 'win32'\n")
  assert.doesNotMatch(out, /!!js/, '结果里不应再有 !!js 标签')
  assert.match(out, /'__JS__ process\.platform !== ''win32'''/, '表达式应保留在占位值里（单引号按 YAML 规则双写）')
})

test('neutralizeJsTags：无 !!js 的文本原样返回（不误伤）', () => {
  const src = 'a: 1\nb: two\n'
  assert.equal(neutralizeJsTags(src), src)
})

test('parsePatchRows：**尸体样本**——含 !!js 的 patch 也必须读出 config', () => {
  const rows = parsePatchRows(PATCH_WITH_JS)
  assert.ok(rows.length >= 3, `应解析出全部行，实际 ${rows.length}`)
  const sr = rows.find(r => r.name === 'dsh-agent-self-rewrite')
  assert.ok(sr !== undefined, '应找到 self-rewrite 行（按 name）')
  assert.ok(sr.config !== undefined, '★ config 必须被读出——修复前这里是 undefined（恒为 {} 的根因）')
  assert.equal(sr.config.maxBytes, 64800, '嵌套数值应保真')
  assert.equal(sr.config.evolveDataDir, 'E:/alice/.evolve', '含斜杠的字符串应保真')
})

test('parsePatchRows：两条路径（有/无 !!js）对 config 的结果一致', () => {
  const withJs = parsePatchRows(PATCH_WITH_JS).find(r => r.name === 'dsh-agent-self-rewrite')
  const plain = parsePatchRows(PATCH_PLAIN).find(r => r.name === 'dsh-agent-self-rewrite')
  assert.deepEqual(withJs?.config, plain?.config, '防「修了回退但 YAML 路径又坏」')
  assert.equal(withJs?.id, plain?.id)
  assert.equal(withJs?.disabled, plain?.disabled)
})

test('parsePatchRows：disabled 的判定语义不因中和而改变（!!js 行仍判非 true）', () => {
  const rows = parsePatchRows(PATCH_WITH_JS)
  for (const r of rows) {
    assert.equal(r.disabled, false, `${r.id}: !!js 中和成字符串后应判非 true（与回退路径一致）`)
  }
})

test('parsePatchRows：**回退路径**仍能产出 name 与 disabled（不因新增 YAML 成功而废弃）', () => {
  // 故意喂一段 YAML 解析器拒收的文本（tab 缩进在 YAML 里非法），逼它走回退
  const broken = "- insert:\n\t- id: x\n\t  name: some-plugin\n"
  const rows = parsePatchRows(broken)
  const x = rows.find(r => r.id === 'x')
  assert.ok(x !== undefined, '回退分支应仍能扫出 id 行')
  assert.equal(x.disabled, false, '回退产出的 disabled 必须是布尔（与 YAML 分支同形）')
})

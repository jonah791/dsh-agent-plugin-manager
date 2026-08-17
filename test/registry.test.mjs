import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parsePatchRows, extractTools, extractPurpose, isBuilt, scanSelfPlugins, buildRegistry } from '../lib/registry.js'
import { patchInsert, patchRemove, patchSetDisabled, patchSetConfig, packageAddLinkDep, packageRemoveDep } from '../lib/profile.js'

const tmp = mkdtempSync(join(tmpdir(), 'pm-test-'))

const PATCH_SAMPLE = [
  '# 注释保留测试',
  '- insert:',
  '    - id: agent-taskboard',
  '      name: dsh-agent-taskboard',
  '      config:',
  '        boardFile: E:/alice/.taskboard/tasks.json',
  '- id: hmr',
  '  disabled: true',
  '  config:',
  "    root: ['.']",
].join('\n')

test('parsePatchRows: insert 块 + 顶层行 + disabled + config', () => {
  const rows = parsePatchRows(PATCH_SAMPLE)
  assert.equal(rows.length, 2)
  const tb = rows.find((r) => r.id === 'agent-taskboard')
  assert.equal(tb.name, 'dsh-agent-taskboard')
  assert.equal(tb.disabled, false)
  assert.deepEqual(tb.config, { boardFile: 'E:/alice/.taskboard/tasks.json' })
  const hmr = rows.find((r) => r.id === 'hmr')
  assert.equal(hmr.disabled, true)
  assert.deepEqual(hmr.config, { root: ['.'] })
})

test('parsePatchRows: 文本回退（坏 YAML）', () => {
  const rows = parsePatchRows('\n- id: a\n- id: b\n')
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b'])
})

test('extractTools: 从源码抓 defineTool 名', () => {
  const dir = join(tmp, 'tools')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/index.ts'), "ctx.tools.register(defineTool({\n  name: 'alpha_do',\n  description: 'x'\n}))")
  const tools = extractTools(dir)
  assert.deepEqual(tools, ['alpha_do'])
})

test('extractPurpose: description 优先，README 回退', () => {
  const d1 = join(tmp, 'pkg1')
  mkdirSync(d1)
  writeFileSync(join(d1, 'package.json'), JSON.stringify({ name: 'p1', description: '用途甲' }))
  assert.equal(extractPurpose(d1), '用途甲')
  const d2 = join(tmp, 'pkg2')
  mkdirSync(d2)
  writeFileSync(join(d2, 'package.json'), JSON.stringify({ name: 'p2' }))
  writeFileSync(join(d2, 'README.md'), '# P2\n\n这是 README 首段用途说明。\n')
  assert.equal(extractPurpose(d2), '这是 README 首段用途说明。')
})

test('isBuilt: lib 新于 src 为 true，缺失为 false', () => {
  const d = join(tmp, 'built')
  mkdirSync(join(d, 'src'), { recursive: true })
  mkdirSync(join(d, 'lib'), { recursive: true })
  writeFileSync(join(d, 'src/index.ts'), 'x')
  writeFileSync(join(d, 'lib/index.js'), 'y')
  assert.equal(isBuilt(d), true)
  const d2 = join(tmp, 'nobuild')
  mkdirSync(d2)
  assert.equal(isBuilt(d2), false)
})

test('scanSelfPlugins: 只收含 package.json 的目录', () => {
  const sp = join(tmp, 'self')
  mkdirSync(join(sp, 'dsh-test-a', 'lib'), { recursive: true })
  writeFileSync(join(sp, 'dsh-test-a', 'package.json'), JSON.stringify({ name: 'dsh-test-a', version: '1.0.0', description: 'A 用途' }))
  mkdirSync(join(sp, 'not-a-plugin'))
  const reg = scanSelfPlugins(sp)
  assert.equal(reg.length, 1)
  assert.equal(reg[0].name, 'dsh-test-a')
  assert.equal(reg[0].status, 'unmounted')
})

const prof = join(tmp, 'prof')
mkdirSync(prof)
const PATCH_INIT = "# 头部注释\n- insert:\n    - id: agent-keep\n      name: dsh-keep\n- id: hmr\n  config:\n    root: ['.']\n"
writeFileSync(join(prof, 'cordis.patch.yml'), PATCH_INIT)

test('patchInsert: 追加 insert 块且保留注释', () => {
  const r = patchInsert(prof, 'agent-new', 'dsh-new', { key: 'val' })
  assert.equal(r.inserted, true)
  const text = readFileSync(join(prof, 'cordis.patch.yml'), 'utf8')
  assert.ok(text.includes('# 头部注释'))
  assert.ok(text.includes('- id: agent-new'))
  assert.ok(text.includes('key: val'))
  const r2 = patchInsert(prof, 'agent-new', 'dsh-new')
  assert.equal(r2.inserted, false)
})

test('patchSetDisabled: 插入/替换 disabled', () => {
  const r = patchSetDisabled(prof, 'agent-keep', true)
  assert.equal(r.ok, true)
  let text = readFileSync(join(prof, 'cordis.patch.yml'), 'utf8')
  assert.ok(text.includes('disabled: true'))
  const r2 = patchSetDisabled(prof, 'agent-keep', false)
  assert.equal(r2.ok, true)
  text = readFileSync(join(prof, 'cordis.patch.yml'), 'utf8')
  assert.ok(text.includes('disabled: false'))
  assert.equal(text.match(/disabled: false/g).length, 1)
})

test('patchSetConfig: 整体替换 config', () => {
  const r = patchSetConfig(prof, 'agent-keep', { a: 1, nested: { b: [1, 2] } })
  assert.equal(r.ok, true)
  const text = readFileSync(join(prof, 'cordis.patch.yml'), 'utf8')
  assert.ok(text.includes('nested:'))
  assert.ok(text.includes('- 2'))
  const rows = parsePatchRows(text)
  const row = rows.find((x) => x.id === 'agent-keep')
  assert.deepEqual(row.config, { a: 1, nested: { b: [1, 2] } })
})

test('patchRemove: 移除指定行，其余保留', () => {
  const r = patchRemove(prof, 'agent-new')
  assert.equal(r.removed, true)
  const text = readFileSync(join(prof, 'cordis.patch.yml'), 'utf8')
  assert.ok(!text.includes('agent-new'))
  assert.ok(text.includes('agent-keep'))
  assert.ok(text.includes('# 头部注释'))
  const r2 = patchRemove(prof, 'ghost')
  assert.equal(r2.removed, false)
})

test('package 依赖增删', () => {
  writeFileSync(join(prof, 'package.json'), JSON.stringify({ name: 'prof', dependencies: {} }))
  const r = packageAddLinkDep(prof, 'dsh-x', 'E:/alice/self-plugins/dsh-x')
  assert.equal(r.ok, true)
  let pkg = JSON.parse(readFileSync(join(prof, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies['dsh-x'], 'link:E:/alice/self-plugins/dsh-x')
  const r2 = packageRemoveDep(prof, 'dsh-x')
  assert.equal(r2.ok, true)
  pkg = JSON.parse(readFileSync(join(prof, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies['dsh-x'], undefined)
})

test('buildRegistry: 全量对账（含挂载状态）', () => {
  const sp = join(tmp, 'self2')
  mkdirSync(join(sp, 'dsh-test-b', 'lib'), { recursive: true })
  writeFileSync(join(sp, 'dsh-test-b', 'package.json'), JSON.stringify({ name: 'dsh-test-b', version: '0.1.0', description: 'B 用途' }))
  const profs = join(tmp, 'profs')
  mkdirSync(join(profs, 'web'), { recursive: true })
  writeFileSync(join(profs, 'web', 'cordis.patch.yml'), '- insert:\n    - id: agent-test-b\n      name: dsh-test-b\n')
  writeFileSync(join(profs, 'web', 'package.json'), JSON.stringify({ name: 'web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
  const reg = buildRegistry(sp, profs)
  const b = reg.find((x) => x.name === 'dsh-test-b')
  assert.equal(b.status, 'mounted')
  assert.deepEqual(b.profiles, ['web'])
  const official = reg.find((x) => x.name === '@deepseek-ai/dsh-base')
  assert.equal(official.source, 'official')
  assert.equal(official.status, 'mounted')
})

after(() => rmSync(tmp, { recursive: true, force: true }))

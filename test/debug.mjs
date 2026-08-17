import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parsePatchRows, buildRegistry } from '../lib/registry.js'
import { patchSetConfig, patchRemove } from '../lib/profile.js'

const tmp = mkdtempSync(join(tmpdir(), 'dbg-'))
const prof = join(tmp, 'prof')
mkdirSync(prof)
const INIT = "# 头部注释\n- insert:\n    - id: agent-keep\n      name: dsh-keep\n- id: hmr\n  config:\n    root: ['.']\n"
writeFileSync(join(prof, 'cordis.patch.yml'), INIT)

const r1 = patchSetConfig(prof, 'agent-keep', { a: 1, nested: { b: [1, 2] } })
console.log('patchSetConfig ok:', r1.ok)
const after1 = readFileSync(join(prof, 'cordis.patch.yml'), 'utf8')
console.log('=== after patchSetConfig ===')
console.log(after1)
console.log('rows:', JSON.stringify(parsePatchRows(after1)))

const r2 = patchRemove(prof, 'agent-keep')
console.log('patchRemove ok:', r2.removed)
const after2 = readFileSync(join(prof, 'cordis.patch.yml'), 'utf8')
console.log('=== after patchRemove ===')
console.log(after2)

const sp = join(tmp, 'self2')
mkdirSync(join(sp, 'dsh-test-b', 'lib'), { recursive: true })
writeFileSync(join(sp, 'dsh-test-b', 'package.json'), JSON.stringify({ name: 'dsh-test-b', version: '0.1.0', description: 'B' }))
const profs = join(tmp, 'profs')
mkdirSync(join(profs, 'web'), { recursive: true })
writeFileSync(join(profs, 'web', 'cordis.patch.yml'), '- insert:\n    - id: agent-test-b\n      name: dsh-test-b\n')
writeFileSync(join(profs, 'web', 'package.json'), JSON.stringify({ name: 'web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
const reg = buildRegistry(sp, profs)
const b = reg.find((x) => x.name === 'dsh-test-b')
console.log('archive:', JSON.stringify(b))
console.log('profiles info:', JSON.stringify(reg.filter((x) => x.source === 'official').map((x) => x.name)))

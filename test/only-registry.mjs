import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildRegistry, parsePatchRows } from '../lib/registry.js'

const tmp = mkdtempSync(join(tmpdir(), 'only-'))
const sp = join(tmp, 'self2')
mkdirSync(join(sp, 'dsh-test-b', 'lib'), { recursive: true })
writeFileSync(join(sp, 'dsh-test-b', 'package.json'), JSON.stringify({ name: 'dsh-test-b', version: '0.1.0', description: 'B 用途' }))
const profs = join(tmp, 'profs')
mkdirSync(join(profs, 'web'), { recursive: true })
const patchText = '- insert:\n    - id: agent-test-b\n      name: dsh-test-b\n'
writeFileSync(join(profs, 'web', 'cordis.patch.yml'), patchText)
writeFileSync(join(profs, 'web', 'package.json'), JSON.stringify({ name: 'web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
console.log('patch file content:', JSON.stringify(readFileSync(join(profs, 'web', 'cordis.patch.yml'), 'utf8')))
console.log('rows:', JSON.stringify(parsePatchRows(patchText)))
const reg = buildRegistry(sp, profs)
const b = reg.find((x) => x.name === 'dsh-test-b')
console.log('archive status:', b && b.status, 'profiles:', b && b.profiles)

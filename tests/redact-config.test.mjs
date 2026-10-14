/**
 * redact-config 单测（node --test，跑构建产物 lib/redact-config.js）
 * 判据：事故形态的两个键（token / chat id）必须被脱敏；非密字段必须保留；**值不得以任何形态出现**（含长度/前缀）。
 * ⚠ 夹具**必须是假值**——真实凭据永不入库（写在文件里的真值会随 push 永久公开）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REDACTED, redactConfig, redactedPaths } from '../lib/redact-config.js'

const GUARDIAN_CONFIG = {
  dshHome: 'E:/alice/.dsh',
  bin: 'E:/alice/deepseek-harness/apps/cli/lib/bin.js',
  profile: 'web',
  port: 3080,
  baseUrl: 'http://127.0.0.1:3080',
  crashWindowMs: 30000,
  // ⚠ 夹具一律用**假值**：本文件曾把主人真实凭据当夹具写进来，随 6292747 上了公开仓
  // （2026-10-14 隐私扫描发现）。脱敏判据按**键名**，与值真假无关 ⇒ 假值一样能测。
  telegramBotToken: '1000000001:FAKE-TOKEN-FOR-REDACTION-TEST-ONLY',
  telegramChatId: '1000000002',
}

test('当天事故形态：telegramBotToken / telegramChatId 必须被脱敏', () => {
  const out = redactConfig(GUARDIAN_CONFIG)
  assert.equal(out.telegramBotToken, REDACTED)
  assert.equal(out.telegramChatId, REDACTED)
})

test('尸体测试：脱敏后输出**不得**含原值任何形态（含片段与长度线索）', () => {
  const out = JSON.stringify(redactConfig(GUARDIAN_CONFIG))
  assert.ok(!out.includes('1000000001'), '泄漏了 token 片段')
  assert.ok(!out.includes('FAKE-TOKEN-FOR-REDACTION-TEST-ONLY'), '泄漏了 token')
  assert.ok(!out.includes('1000000002'), '泄漏了 chat id')
  assert.ok(out.includes('[redacted]'))
})

test('非密字段原样保留（配置仍可读，不因噎废食）', () => {
  const out = redactConfig(GUARDIAN_CONFIG)
  assert.equal(out.port, 3080)
  assert.equal(out.profile, 'web')
  assert.equal(out.dshHome, 'E:/alice/.dsh')
  assert.equal(out.crashWindowMs, 30000)
})

test('嵌套对象与数组递归脱敏', () => {
  const out = redactConfig({ a: { apiKey: 'sk-live-123', keep: 1 }, list: [{ password: 'p' }, { ok: true }] })
  assert.equal(out.a.apiKey, REDACTED)
  assert.equal(out.a.keep, 1)
  assert.equal(out.list[0].password, REDACTED)
  assert.equal(out.list[1].ok, true)
})

test('尸体测试：普通键名不得被误伤（不猜值形态）', () => {
  const out = redactConfig({ name: 'guardian', key: undefined, monkey: 'x', note: 'token 的说明文字' })
  assert.equal(out.monkey, 'x')
  assert.equal(out.name, 'guardian')
  assert.equal(out.note, 'token 的说明文字')   // 值是普通文本、键名不命中 ⇒ 不动（键名判据，不看值）
})

test('不改入参（返回新对象）', () => {
  const src = { telegramBotToken: 'x' }
  const out = redactConfig(src)
  assert.equal(src.telegramBotToken, 'x')
  assert.notEqual(out, src)
})

test('redactedPaths：列出被脱敏的键路径（审计用，不含值）', () => {
  const paths = redactedPaths({ a: { telegramBotToken: 'x' }, b: [{ secret: 'y' }], keep: 1 })
  assert.ok(paths.includes('a.telegramBotToken'))
  assert.ok(paths.includes('b[0].secret'))
  assert.ok(!paths.some((p) => p.includes('keep')))
})

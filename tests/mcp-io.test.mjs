/**
 * mcp-io 的 IO 层判据：读不到日志必须判 unknown、大日志只读尾部、上游查询失败不塌缩。
 *
 * 全部离线（注入假 fetch / 用 tmp 夹具），不打真网络——真实网络会因上游状态变化而假红假绿。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readTail, collectMcpRows, runMcpCheck, LOG_TAIL_BYTES } from '../lib/mcp-io.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mcp-io-'));
  const profiles = join(root, 'profiles', 'web');
  mkdirSync(profiles, { recursive: true });
  // profile 至少要有 package.json，listProfiles 才认（其它字段可缺）
  writeFileSync(join(profiles, 'package.json'), JSON.stringify({ name: 'fixture', private: true }));
  return { root, profiles };
}

const MCP_PATCH = [
  '- insert:',
  '    - id: mcp-playwright',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: playwright',
  '        transport: stdio',
  '        command: npx',
  '        args:',
  "          - '-y'",
  "          - '@playwright/mcp@latest'",
  '',
].join('\n');

test('readTail: 不存在的文件返回 null（「读不到」≠「空」）', () => {
  assert.equal(readTail(join(tmpdir(), 'definitely-absent-' + Date.now() + '.log')), null);
});

test('readTail: 空文件返回空串（与 null 区分）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-tail-'));
  const f = join(root, 'empty.log');
  writeFileSync(f, '');
  assert.equal(readTail(f), '');
  rmSync(root, { recursive: true, force: true });
});

test('readTail: 大文件只读尾部（不把 1.7MB 日志全读进来）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-tail2-'));
  const f = join(root, 'big.log');
  writeFileSync(f, 'A'.repeat(LOG_TAIL_BYTES + 5000) + 'TAILMARK');
  const t = readTail(f);
  assert.ok(t !== null);
  assert.ok(t.length < LOG_TAIL_BYTES + 100, `应只读尾部，实际 ${t.length}`);
  assert.match(t, /TAILMARK$/, '尾部内容必须完整');
  rmSync(root, { recursive: true, force: true });
});

test('collectMcpRows: 从 patch 读出 MCP 行', () => {
  const { root, profiles } = fixture();
  try {
    writeFileSync(join(profiles, 'cordis.patch.yml'), MCP_PATCH);
    const rows = collectMcpRows(profiles);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'mcp-playwright');
    assert.equal(rows[0].ref.pkg, '@playwright/mcp');
    assert.equal(rows[0].ref.floating, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('collectMcpRows: 无 patch / 无 MCP 行 ⇒ 空数组，不抛', () => {
  const { root, profiles } = fixture();
  try {
    assert.deepEqual(collectMcpRows(profiles), [], '无 patch 文件');
    writeFileSync(join(profiles, 'cordis.patch.yml'), '- insert:\n    - id: other\n      name: dsh-foo\n');
    assert.deepEqual(collectMcpRows(profiles), [], '无 MCP 行');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('尸体（最危险的一格）：日志读不到 ⇒ unknown，绝不判 active', async () => {
  const { root, profiles } = fixture();
  try {
    writeFileSync(join(profiles, 'cordis.patch.yml'), MCP_PATCH);
    const r = await runMcpCheck({
      dshHome: root, profilesDir: join(root, 'profiles'),
      probeUpstream: false,
      logCandidates: ['no-such-log.log'],
    });
    assert.equal(r.log.available, false);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].health, 'unknown', '没日志就不能说它在跑');
    assert.notEqual(r.rows[0].health, 'active');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('尸体（本机实际事故形态）：日志有停用记录 ⇒ denied-runtime', async () => {
  const { root, profiles } = fixture();
  try {
    writeFileSync(join(profiles, 'cordis.patch.yml'), MCP_PATCH);
    writeFileSync(join(root, '.watch-web.log'),
      'dsh: disabling profile plugin row "mcp-playwright": Plugin @deepseek-ai/dsh-mcp-client@0.0.1-rc.1 is incompatible with dsh 0.2.1-alpha.2\n');
    const r = await runMcpCheck({
      dshHome: root, profilesDir: join(root, 'profiles'),
      probeUpstream: false,
      now: () => new Date('2026-10-13T12:00:00.000Z'),
    });
    assert.equal(r.log.available, true);
    assert.equal(r.rows[0].health, 'denied-runtime');
    assert.match(r.rows[0].note, /incompatible/);
    assert.equal(r.checkedAt, '2026-10-13T12:00:00.000Z');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('日志有记录但与该行无关 ⇒ active（不能因别行被拒而误报）', async () => {
  const { root, profiles } = fixture();
  try {
    writeFileSync(join(profiles, 'cordis.patch.yml'), MCP_PATCH);
    writeFileSync(join(root, '.watch-web.log'),
      'dsh: disabling profile plugin row "some-other-plugin": its peers are incompatible\n');
    const r = await runMcpCheck({ dshHome: root, profilesDir: join(root, 'profiles'), probeUpstream: false });
    assert.equal(r.rows[0].health, 'active');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('尸体：上游查询失败 ⇒ fetch-failed，不得塌缩成 up-to-date；浮动版的 verdict 是 not-comparable', async () => {
  const { root, profiles } = fixture();
  try {
    writeFileSync(join(profiles, 'cordis.patch.yml'), MCP_PATCH);
    writeFileSync(join(root, '.watch-web.log'), 'started ok\n');
    const r = await runMcpCheck({
      dshHome: root, profilesDir: join(root, 'profiles'),
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    assert.equal(r.rows[0].latest, null);
    assert.equal(r.rows[0].verdict, 'fetch-failed');
    assert.notEqual(r.rows[0].verdict, 'up-to-date');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pin 形态：上游可查时给出更新判定（与 update-check 同一套六档）', async () => {
  const { root, profiles } = fixture();
  try {
    writeFileSync(join(profiles, 'cordis.patch.yml'), MCP_PATCH.replace('@playwright/mcp@latest', '@playwright/mcp@1.0.0'));
    writeFileSync(join(root, '.watch-web.log'), 'started ok\n');
    const r = await runMcpCheck({
      dshHome: root, profilesDir: join(root, 'profiles'),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: '1.2.0' }) }),
    });
    assert.equal(r.rows[0].pinned, '1.0.0');
    assert.equal(r.rows[0].latest, '1.2.0');
    assert.equal(r.rows[0].verdict, 'update-available');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('probeUpstream=false ⇒ 完全不进网络（离线体检）', async () => {
  const { root, profiles } = fixture();
  try {
    writeFileSync(join(profiles, 'cordis.patch.yml'), MCP_PATCH);
    writeFileSync(join(root, '.watch-web.log'), 'started ok\n');
    let called = 0;
    const r = await runMcpCheck({
      dshHome: root, profilesDir: join(root, 'profiles'),
      probeUpstream: false,
      fetchImpl: async () => { called += 1; return { ok: true, status: 200, json: async () => ({}) }; },
    });
    assert.equal(called, 0);
    assert.equal(r.rows[0].verdict, 'skipped');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('计数覆盖四档且与行数一致', async () => {
  const { root, profiles } = fixture();
  try {
    writeFileSync(join(profiles, 'cordis.patch.yml'), MCP_PATCH);
    writeFileSync(join(root, '.watch-web.log'), 'started ok\n');
    const r = await runMcpCheck({ dshHome: root, profilesDir: join(root, 'profiles'), probeUpstream: false });
    const sum = Object.values(r.counts).reduce((a, b) => a + b, 0);
    assert.equal(sum, r.rows.length);
    for (const k of ['active', 'disabled-in-patch', 'denied-runtime', 'unknown']) {
      assert.equal(typeof r.counts[k], 'number', `缺档位 ${k}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── 时刻口径端到端（2026-10-13 本工具真实误报的回归） ──────────────────────

test('尸体回归：修复后日志仍留有历史停用记录 ⇒ 必须判 active（不得报 denied）', async () => {
  const { root, profiles } = fixture();
  try {
    writeFileSync(join(profiles, 'cordis.patch.yml'), MCP_PATCH);
    // 真实形态：上一轮的停用记录 + 本轮正常启动（本机实测同一行累积 69 次）
    writeFileSync(join(root, '.watch-web.log'),
      '[2026-10-13T11:54:37.571Z err] dsh: disabling profile plugin row "mcp-playwright": peer deps cannot be validated\n'
      + '[2026-10-13T12:03:42.000Z out] dsh: started fine\n');
    const r = await runMcpCheck({
      dshHome: root, profilesDir: join(root, 'profiles'), probeUpstream: false,
      sinceMs: Date.parse('2026-10-13T12:03:42.000Z'),
    });
    assert.equal(r.rows[0].health, 'active', '历史记录不得把已修好的行报成故障');
    assert.equal(r.log.sinceMs, Date.parse('2026-10-13T12:03:42.000Z'), '口径必须与读数同体');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('同一份日志不设界 ⇒ 会把历史报成当前（记录缺陷形态，防回退）', async () => {
  const { root, profiles } = fixture();
  try {
    writeFileSync(join(profiles, 'cordis.patch.yml'), MCP_PATCH);
    writeFileSync(join(root, '.watch-web.log'),
      '[2026-10-13T11:54:37.571Z err] dsh: disabling profile plugin row "mcp-playwright": stale\n');
    const r = await runMcpCheck({
      dshHome: root, profilesDir: join(root, 'profiles'), probeUpstream: false,
      sinceMs: 0,
    });
    assert.equal(r.rows[0].health, 'denied-runtime');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

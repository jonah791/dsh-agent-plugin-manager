/**
 * MCP 专项支持的判据（mcp-check.ts）。
 *
 * 尸体样本来源（全部是**真出现过或构造上必然误导**的输入，不是凑数）：
 *   - `@playwright/mcp@latest`：**本机实际配置**，浮动版本 ⇒ 配置里不存在确定版本；
 *   - `@deepseek-ai/dsh-mcp-client@0.0.1-rc.1` 被运行时拒：**本机实际事故**，四天静默失效；
 *   - 绝对路径 command、args 非数组、config 缺失：真实容错面（§5.24 归一形状）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMcpCommand,
  isMcpRow,
  mcpRowOf,
  runtimeDenials,
  mcpHealth,
  mcpLine,
  processStartMs,
} from '../lib/mcp-check.js';

// ── 命令解析 ──────────────────────────────────────────────────────────────

test('parseMcpCommand: npx pin 形态解析出包名与版本', () => {
  const r = parseMcpCommand('npx', ['-y', '@scope/pkg@1.2.3', '--flag']);
  assert.equal(r.pkg, '@scope/pkg');
  assert.equal(r.pinned, '1.2.3');
  assert.equal(r.floating, false);
  assert.match(r.evidence, /显式 pin/);
});

test('尸体：@latest 是浮动 —— 配置里不存在确定版本（本机实际配置）', () => {
  const r = parseMcpCommand('npx', ['-y', '@playwright/mcp@latest', '--cdp-endpoint', 'http://127.0.0.1:9222']);
  assert.equal(r.pkg, '@playwright/mcp', '包名仍要解析出来（上游可查）');
  assert.equal(r.pinned, null, 'latest 不是确定版本，不得伪装成 pin');
  assert.equal(r.floating, true);
  assert.match(r.evidence, /浮动/);
});

test('scoped 包名从最后一个 @ 切分（不是第一个）', () => {
  const r = parseMcpCommand('npx', ['-y', '@playwright/mcp@1.2.3']);
  assert.equal(r.pkg, '@playwright/mcp');
  assert.equal(r.pinned, '1.2.3');
});

test('尸体：无版本号 ⇒ 浮动', () => {
  const r = parseMcpCommand('npx', ['-y', 'some-mcp']);
  assert.equal(r.pkg, 'some-mcp');
  assert.equal(r.pinned, null);
  assert.equal(r.floating, true);
});

test('尸体：带值的 flag 不得被当成包名（--cdp-endpoint 的 URL 是值不是包）', () => {
  // 若把 flag 的值当位置参数，包名会解析成 http://127.0.0.1:9222 —— 一个不存在的包
  const r = parseMcpCommand('npx', ['--cdp-endpoint', 'http://127.0.0.1:9222', '@playwright/mcp@1.0.0']);
  assert.equal(r.pkg, '@playwright/mcp');
  assert.equal(r.pinned, '1.0.0');
});

test('尸体：非包运行器命令 ⇒ pkg=null，不伪造包名去查上游', () => {
  for (const cmd of ['/usr/bin/node', 'python3', 'C:\\tools\\server.exe', '']) {
    const r = parseMcpCommand(cmd, ['/abs/path/server.mjs']);
    assert.equal(r.pkg, null, `命令 ${JSON.stringify(cmd)} 不该产出包名`);
    assert.equal(r.pinned, null);
    assert.match(r.evidence, /非 registry 形态|无可识别/);
  }
});

test('bunx 与 pnpm dlx 形态同样可解析', () => {
  assert.equal(parseMcpCommand('bunx', ['@a/b@2.0.0']).pkg, '@a/b');
  assert.equal(parseMcpCommand('pnpm', ['dlx', '@a/b@2.0.0']).pkg, 'dlx', '未知 runner 的前置词不猜（保守）');
});

// ── 行提取 ────────────────────────────────────────────────────────────────

test('isMcpRow: 只认官方 mcp-client 模块名', () => {
  assert.equal(isMcpRow('@deepseek-ai/dsh-mcp-client'), true);
  assert.equal(isMcpRow('dsh-nuphus-mcp'), false, '名字带 mcp 不等于它是 MCP 客户端行');
  assert.equal(isMcpRow(undefined), false);
});

test('mcpRowOf: 提取 serverName/transport/args，且不投影整份 config', () => {
  const row = mcpRowOf({
    id: 'mcp-playwright',
    name: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'playwright', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: { SECRET: 'x' } },
  });
  assert.ok(row);
  assert.equal(row.id, 'mcp-playwright');
  assert.equal(row.serverName, 'playwright');
  assert.equal(row.transport, 'stdio');
  assert.equal(JSON.stringify(row).includes('SECRET'), false, 'env 等字段不得进读数');
});

test('尸体（形状容错）：config 缺失 / args 非数组 / serverName 非串 ⇒ 不抛，降级 null', () => {
  const a = mcpRowOf({ id: 'x', name: '@deepseek-ai/dsh-mcp-client' });
  assert.ok(a);
  assert.equal(a.serverName, null);
  assert.equal(a.ref.pkg, null);

  const b = mcpRowOf({ id: 'y', name: '@deepseek-ai/dsh-mcp-client', config: { command: 'npx', args: 'not-an-array' } });
  assert.ok(b);
  assert.equal(b.ref.pkg, null, 'args 非数组时不得下标访问');

  const c = mcpRowOf({ id: 'z', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 42, command: 'npx', args: ['-y', 'p@1.0.0'] } });
  assert.ok(c);
  assert.equal(c.serverName, null, '非字符串 serverName 降级为 null');
  assert.equal(c.ref.pkg, 'p', '其余字段仍可用');
});

test('mcpRowOf: 非 MCP 行返回 null；显式 disabled 被记录', () => {
  assert.equal(mcpRowOf({ id: 'other', name: 'dsh-foo' }), null);
  const d = mcpRowOf({ id: 'm', name: '@deepseek-ai/dsh-mcp-client', disabled: true });
  assert.ok(d);
  assert.equal(d.disabledInPatch, true);
});

// ── 运行时停用证据（本功能的核心价值） ────────────────────────────────────

test('尸体（本机实际事故）：从 stderr 行提取运行时停用证据', () => {
  // 原文来自 .watch-web.log 实测（69 次同型）
  const log = [
    '[2026-10-13T11:31:29.701Z err] dsh: disabling profile plugin row "mcp-playwright": Plugin @deepseek-ai/dsh-mcp-client@0.0.1-rc.1 is incompatible with dsh 0.2.1-alpha.2',
    'some unrelated line',
  ].join('\n');
  const d = runtimeDenials(log);
  assert.ok(d['mcp-playwright'], '必须抓到被停用的行 id');
  assert.match(d['mcp-playwright'], /incompatible with dsh/);
});

test('runtimeDenials: 同一行多次重报取最后一次；无停用 ⇒ 空对象', () => {
  const log = [
    'disabling profile plugin row "a": first reason',
    'disabling profile plugin row "a": second reason',
  ].join('\n');
  assert.match(runtimeDenials(log)['a'], /second/);
  assert.deepEqual(runtimeDenials('nothing here'), {});
  assert.deepEqual(runtimeDenials(''), {});
});

// ── 健康档位（四档互不掩盖） ──────────────────────────────────────────────

const baseRow = {
  id: 'mcp-playwright',
  name: '@deepseek-ai/dsh-mcp-client',
  disabledInPatch: false,
  serverName: 'playwright',
  transport: 'stdio',
  ref: parseMcpCommand('npx', ['-y', '@playwright/mcp@latest']),
};

test('尸体（最危险的一格）：配置启用 + 运行时被拒 ⇒ denied-runtime，不是 active', () => {
  const denials = { 'mcp-playwright': 'Plugin ... is incompatible with dsh 0.2.1-alpha.2' };
  const h = mcpHealth(baseRow, denials, true);
  assert.equal(h.health, 'denied-runtime', '配置里没 disabled 字段，但它从没跑过');
  assert.notEqual(h.health, 'active');
  assert.match(h.note, /兼容性预检/);
});

test('尸体：拿不到日志 ⇒ unknown，不得判 active（配置启用 ≠ 真的在跑）', () => {
  const h = mcpHealth(baseRow, {}, false);
  assert.equal(h.health, 'unknown');
  assert.notEqual(h.health, 'active');
  assert.match(h.note, /无法确认/);
});

test('四档各自可达且互不塌缩', () => {
  assert.equal(mcpHealth(baseRow, {}, true).health, 'active');
  assert.equal(mcpHealth({ ...baseRow, disabledInPatch: true }, {}, true).health, 'disabled-in-patch');
  // 显式停用优先于运行时拒（有意停用不该报成故障）
  assert.equal(mcpHealth({ ...baseRow, disabledInPatch: true }, { 'mcp-playwright': 'x' }, true).health, 'disabled-in-patch');
  assert.equal(mcpHealth(baseRow, { 'mcp-playwright': 'x' }, true).health, 'denied-runtime');
  assert.equal(mcpHealth(baseRow, {}, false).health, 'unknown');
});

// ── 渲染 ──────────────────────────────────────────────────────────────────

test('mcpLine: 四档文案互异，浮动版本明确标注', () => {
  const mk = (health, floating, pinned, latest) => mcpLine({
    id: 'mcp-playwright', serverName: 'playwright', transport: 'stdio',
    health, note: '', pkg: '@playwright/mcp', pinned, floating, latest, verdict: 'skipped', evidence: '',
  });
  const active = mk('active', true, null, null);
  const denied = mk('denied-runtime', true, null, null);
  assert.match(active, /在跑/);
  assert.match(denied, /运行时被拒/);
  assert.notEqual(active, denied);
  assert.match(active, /浮动/);
  assert.match(mk('active', false, '1.2.3', '1.3.0'), /1\.2\.3 → 上游 1\.3\.0/);
});

// ── 时刻口径（2026-10-13 由本工具自身一次误报驱动） ────────────────────────

test('尸体：历史轮次的停用记录不得当成当前状态（本工具真实误报的形态）', () => {
  const log = [
    '[2026-10-13T11:54:37.571Z err] dsh: disabling profile plugin row "mcp-playwright": its declared peer dependencies cannot be validated',
    '[2026-10-13T12:03:42.000Z out] dsh: started',
  ].join('\n');
  const since = Date.parse('2026-10-13T12:03:42.000Z');
  // 不设界 ⇒ 会拿 11:54 的旧记录报当前故障（实测把已修好的行报成 denied）
  assert.ok(runtimeDenials(log)['mcp-playwright'], '不设界时应命中（这是缺陷形态本身）');
  // 设界 ⇒ 旧记录被排除
  assert.deepEqual(runtimeDenials(log, since), {}, '历史轮次不构成当前证据');
});

test('设界后仍能抓到当前轮次的停用（不得因设界而漏报）', () => {
  const log = [
    '[2026-10-13T11:54:37.571Z err] dsh: disabling profile plugin row "old-row": stale reason',
    '[2026-10-13T12:05:00.000Z err] dsh: disabling profile plugin row "mcp-playwright": fresh reason',
  ].join('\n');
  const since = Date.parse('2026-10-13T12:03:42.000Z');
  const d = runtimeDenials(log, since);
  assert.equal(d['old-row'], undefined, '旧行应被排除');
  assert.match(d['mcp-playwright'], /fresh reason/, '当前行必须抓到');
});

test('取严：无时间戳的行仍计入（无法归属 ⇒ 宁可误报不静默漏报）', () => {
  const log = 'dsh: disabling profile plugin row "untimed": no timestamp on this line';
  const since = Date.parse('2026-10-13T12:03:42.000Z');
  assert.match(runtimeDenials(log, since)['untimed'], /no timestamp/, '无法定时不得被当历史丢掉');
});

test('processStartMs: 由 now 与 uptime 反推启动时刻', () => {
  assert.equal(processStartMs(1_000_000, 100), 900_000);
  assert.equal(processStartMs(5000, 0), 5000);
});

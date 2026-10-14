/**
 * update-io 的 IO 层判据：网络失败必须转成数据、覆盖度必须对得上。
 *
 * 尸体样本全部靠**注入假 fetch** 构造（不打真实网络）——真实网络测试会因上游状态变化而假红/假绿，
 * 不能作为判据（§5.9 规则 2：恒为空的输出不是证据）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchLatest, runUpdateCheck, collectTargets, DEFAULT_TIMEOUT_MS } from '../lib/update-io.js';

/**
 * ★ **平台守卫（2026-10-14 补 · 全量体检抓出）**
 *
 * 下面两条测试**读真实环境**（`E:/alice/.dsh/profiles` + `E:/alice/self-plugins`）来找第三方插件。
 * 那个路径是 **Windows 形态** —— 在 WSL 侧跑 node 解析不了（实测 `listProfiles('E:/…')` = **0 条**，
 * 而同一实现在 Windows 侧 = **6 条**；WSL 路径在 WSL 侧也 = 6 条）。
 *
 * ⇒ 症状是 `collectTargets` 返回 0，测试断言「不应为空」变红。
 * ⚠ **这不是实现缺陷**：`classifyDependency` / `scanThirdParty` 在正确平台上工作正常
 *   （双向对照：Windows 6 ✓ · WSL+WSL 路径 6 ✓ · 只有「Windows 路径 + WSL 运行」错配）。
 *
 * 为什么是 **SKIP 而非 FAIL**（技能 `dsh-plugin-testability`：夹具不得依赖运行平台）：
 * 把它留成 FAIL ⇒ 全量体检**永远报 2 条假账**，而假账会把真账淹掉
 * （同 `dsh-host-posture` 的处置理由；两者是同族、同向）。
 *
 * ⚠ 边界如实：SKIP **不等于验证过**。这两条判据的活体验证只在 Windows 侧成立；
 *   WSL 侧的绿不覆盖它们（别把「skip 0 fail」读成「判据都过了」）。
 */
const IS_WINDOWS = process.platform === 'win32'
const WIN_ONLY = { skip: !IS_WINDOWS && '读真实环境且路径为 Windows 形态（WSL 侧无法同构验证）' }

const gh = { github: { owner: 'T-Auto', repo: 'dsh-ops' } };

test('fetchLatest: npm 优先，命中即返回且不再打 GitHub', async () => {
  const seen = [];
  const res = await fetchLatest(gh, 'dsh-ops', {
    fetchImpl: async (url) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => ({ version: '0.3.0' }) };
    },
  });
  assert.equal(res.latest, '0.3.0');
  assert.equal(seen.length, 1, 'npm 命中后不应继续查询');
  assert.match(seen[0], /registry\.npmjs\.org/);
});

test('尸体：npm 404 ⇒ 回退 GitHub release（不得直接判失败）', async () => {
  const seen = [];
  const res = await fetchLatest(gh, 'dsh-ops', {
    fetchImpl: async (url) => {
      seen.push(url);
      if (url.includes('registry.npmjs.org')) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ tag_name: 'v0.4.0' }) };
    },
  });
  assert.equal(res.latest, 'v0.4.0');
  assert.equal(seen.length, 2);
});

test('尸体：全部端点失败 ⇒ latest=null 且 error 含各端点状态码（不是静默）', async () => {
  const res = await fetchLatest(gh, 'dsh-ops', {
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  assert.equal(res.latest, null);
  assert.match(String(res.error), /503/);
  assert.match(String(res.error), /npm latest|GitHub/);
});

test('尸体：抛异常（DNS/超时）⇒ 转成 error，不冒泡', async () => {
  const res = await fetchLatest(gh, null, {
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); },
  });
  assert.equal(res.latest, null);
  assert.match(String(res.error), /ENOTFOUND/);
});

test('尸体：响应体形状不对（无版本字段）⇒ 记形状错误，不编造版本', async () => {
  const res = await fetchLatest(gh, null, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ message: 'Not Found' }) }),
  });
  assert.equal(res.latest, null);
  assert.match(String(res.error), /无可识别版本字段|404|Not Found/);
});

test('fetchLatest: 无任何端点 ⇒ 明确的 error，不进网络', async () => {
  let called = 0;
  const res = await fetchLatest({ github: null }, null, {
    fetchImpl: async () => { called += 1; return { ok: true, status: 200, json: async () => ({}) }; },
  });
  assert.equal(res.latest, null);
  assert.equal(called, 0);
  assert.match(String(res.error), /无可查询的上游端点/);
});

test('runUpdateCheck: 全链路（坏通道）——每条目标都产出一行，覆盖度 missing 为空', WIN_ONLY, async () => {
  const report = await runUpdateCheck({
    profilesDir: 'E:/alice/.dsh/profiles',
    selfPluginsDir: 'E:/alice/self-plugins',
    fetchImpl: async () => { throw new Error('offline'); },
    now: () => new Date('2026-10-13T12:00:00.000Z'),
  });
  assert.equal(report.checkedAt, '2026-10-13T12:00:00.000Z');
  assert.ok(report.rows.length > 0, '本机确实装了第三方插件，不应为空');
  assert.equal(report.coverage.missing.length, 0, '漏查的必须为空');
  assert.equal(report.coverage.expected, report.coverage.queried);
  // 离线时**不得出现 up-to-date**——这是最危险的一格（网络断被读成没更新）
  assert.equal(report.counts['up-to-date'], 0, '离线不得报「已最新」');
  const total = Object.values(report.counts).reduce((a, b) => a + b, 0);
  assert.equal(total, report.rows.length, '六档计数之和必须等于行数');
});

test('runUpdateCheck: 行内不得出现本地绝对路径（工具面白名单）', async () => {
  const report = await runUpdateCheck({
    profilesDir: 'E:/alice/.dsh/profiles',
    selfPluginsDir: 'E:/alice/self-plugins',
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  const blob = JSON.stringify(report);
  assert.ok(!blob.includes('E:/alice/self-plugins'), '不应投影自研目录');
  assert.ok(!blob.includes('node_modules'), '不应投影安装路径');
});

test('runUpdateCheck: --only 收窄到单个插件', WIN_ONLY, async () => {
  const all = collectTargets('E:/alice/.dsh/profiles', 'E:/alice/self-plugins');
  assert.ok(all.length >= 1);
  const target = all[0].name;
  const report = await runUpdateCheck({
    profilesDir: 'E:/alice/.dsh/profiles',
    selfPluginsDir: 'E:/alice/self-plugins',
    only: target,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].name, target);
});

test('默认超时常量存在且取严（不让工具挂死）', () => {
  assert.equal(typeof DEFAULT_TIMEOUT_MS, 'number');
  assert.ok(DEFAULT_TIMEOUT_MS > 0 && DEFAULT_TIMEOUT_MS <= 30000);
});

// ───────── 平台守卫的自证（防「跳过当通过」）─────────
test('★ 平台守卫生效：非 Windows 平台必须把上面 2 条判成 SKIP（不是 PASS）', () => {
  // SKIP 与 PASS 在汇总里长得像（都是「没 fail」），而它们说的是相反的事——
  //   PASS 是「判据过了」，SKIP 是「这里问不出来」。没有这条，守卫一旦失效
  //   （IS_WINDOWS 判错 / 守卫被顺手删掉），那 2 条会静默变绿。
  const expected = IS_WINDOWS ? 'run' : 'skip';
  assert.equal(
    typeof WIN_ONLY === 'object' && WIN_ONLY !== null && typeof WIN_ONLY.skip === 'string' ? 'skip' : 'run',
    expected,
    '平台守卫与 process.platform 不一致 ⇒ 那 2 条判据的去向不明',
  );
  // 边界如实：本测试只断言**守卫的方向**，不断言那 2 条判据的内容
  //   （内容在 Windows 侧跑才算验证；WSL 侧的绿不覆盖它们）
});

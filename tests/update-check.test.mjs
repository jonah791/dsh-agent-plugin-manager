/**
 * 第三方插件上游更新检查的判据（update-check.ts）。
 *
 * 每条判据都配**尸体样本**：样本必须是「真出现过的坏状态」或「构造上必然误导的输入」，
 * 否则判据通过只等于「探针没被触发」（§5.9 规则 2：恒为空的输出不是证据）。
 * 本文件里的样本来源：
 *   - `1.0.0-beta.5` vs `1.0.0-beta.10`：字符串比较与朴素数字比较**都会给反的答案**；
 *   - `2024.10.13` / `1.0`：非 semver 三段形态，真在野版本号里常见；
 *   - 查询失败与「无更新」：若不分开，网络断掉会被读成「全部最新」（最危险的一格）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  compareVersions,
  decideUpdate,
  parseGithub,
  resolveUpstream,
  unresolvedCoverage,
  updateLine,
} from '../lib/update-check.js';

// ── 版本比较 ──────────────────────────────────────────────────────────────

test('compareVersions: 三段数字可可靠比较（相等/本地旧/本地新）', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3').cmp, 0);
  assert.equal(compareVersions('1.2.3', '1.2.4').cmp, -1);
  assert.equal(compareVersions('1.2.4', '1.2.3').cmp, 1);
  assert.equal(compareVersions('1.2.3', '2.0.0').cmp, -1);
  assert.equal(compareVersions('v1.2.3', '1.2.3').cmp, 0, 'v 前缀应被剥离');
  assert.equal(compareVersions('1.2.3+build.9', '1.2.3').cmp, 0, 'build metadata 不参与比较');
});

test('尸体：prerelease 核心相同但标识不同 ⇒ 判不可比，不得给大小', () => {
  // 字符串比较会给 beta.10 < beta.5（错）；朴素数字比较会给 10 > 5（也错）。
  const r = compareVersions('1.0.0-beta.5', '1.0.0-beta.10');
  assert.equal(r.cmp, null, '两边都在手也必须拒绝排序');
  assert.match(String(r.note), /预发布标识不同/);
});

test('prerelease 可可靠判定的两种情形：一方是正式版', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.5').cmp, 1, '正式版 > 预发布版');
  assert.equal(compareVersions('1.0.0-beta.5', '1.0.0').cmp, -1);
  assert.equal(compareVersions('1.0.0-beta.5', '1.0.0-beta.5').cmp, 0, '标识相同则相等');
});

test('尸体：非三段形态一律不可比，不靠补位猜测', () => {
  // `1.0` 不接受：补位假设（补 0 还是补大）会让判定依赖猜测。
  for (const [a, b] of [['1.0', '1.0.0'], ['abc1234', '1.0.0'], ['latest', '1.0.0'], ['', '1.0.0']]) {
    const r = compareVersions(a, b);
    assert.equal(r.cmp, null, `${a} vs ${b} 应不可比`);
    assert.match(String(r.note), /非 major\.minor\.patch 形态/);
  }
});

test('CalVer（2024.10.13）是三段数字 ⇒ 按数字比较，不误判不可比', () => {
  // 我写完第一版判据时把 CalVer 也归进「不可比」——那是错的：日历版本天然可数值排序。
  assert.equal(compareVersions('2024.10.13', '2024.11.01').cmp, -1);
  assert.equal(compareVersions('2024.10.13', '2024.10.13').cmp, 0);
});

// ── 上游解析 ──────────────────────────────────────────────────────────────

test('parseGithub: 覆盖实测遇到的六种写法', () => {
  assert.deepEqual(parseGithub('git+https://github.com/dingminhua/dsh-connect-trae.git'), { owner: 'dingminhua', repo: 'dsh-connect-trae' });
  assert.deepEqual(parseGithub('https://github.com/T-Auto/dsh-ops#readme'), { owner: 'T-Auto', repo: 'dsh-ops' });
  assert.deepEqual(parseGithub('github:Coco-king/dsh-x-opencode-session#2e7ce82'), { owner: 'Coco-king', repo: 'dsh-x-opencode-session' });
  assert.deepEqual(parseGithub('git@github.com:owner/repo.git'), { owner: 'owner', repo: 'repo' });
  assert.deepEqual(parseGithub('https://github.com/loyalchiiina/dsh-workbuddy-hub'), { owner: 'loyalchiiina', repo: 'dsh-workbuddy-hub' });
  assert.deepEqual(parseGithub('https://github.com/mrpulor-gh/dsh-nuphus-mcp.git'), { owner: 'mrpulor-gh', repo: 'dsh-nuphus-mcp' });
});

test('parseGithub: 非 GitHub 与垃圾输入返回 null', () => {
  for (const s of ['', '   ', 'https://gitlab.com/a/b', 'not a url', 'file:../x']) {
    assert.equal(parseGithub(s), null, JSON.stringify(s));
  }
});

test('resolveUpstream: spec 里的 github 优先于 package.json，并写明依据', () => {
  const r = resolveUpstream({
    name: 'dsh-x-opencode-session',
    spec: 'github:Coco-king/dsh-x-opencode-session#2e7ce82',
    repository: null,
  });
  assert.equal(r.url, 'https://github.com/Coco-king/dsh-x-opencode-session');
  assert.deepEqual(r.github, { owner: 'Coco-king', repo: 'dsh-x-opencode-session' });
  assert.match(r.evidence, /profile spec/);
});

test('resolveUpstream: 从 package.json repository 对象取（实测四例的形态）', () => {
  const r = resolveUpstream({
    name: 'dsh-ops',
    spec: '0.2.6',
    repository: { type: 'git', url: 'git+https://github.com/T-Auto/dsh-ops.git' },
  });
  assert.equal(r.url, 'https://github.com/T-Auto/dsh-ops');
  assert.match(r.evidence, /repository/);
});

test('尸体：无任何来源 ⇒ 覆盖度 0，且不得伪造成某个 URL', () => {
  const r = resolveUpstream({ name: 'some-local-thing', spec: 'file:../x', repository: null, homepage: null });
  assert.equal(r.url, '');
  assert.equal(r.github, null);
  assert.match(r.evidence, /未找到 GitHub 线索/);
});

test('resolveUpstream: homepage 是最后一档兜底', () => {
  const r = resolveUpstream({ name: 'p', spec: '^1.0.0', repository: undefined, homepage: 'https://github.com/a/b#readme' });
  assert.deepEqual(r.github, { owner: 'a', repo: 'b' });
  assert.match(r.evidence, /homepage/);
});

// ── 判定分档（六档互不掩盖） ───────────────────────────────────────────────

test('decideUpdate: 有更新 / 已最新', () => {
  assert.equal(decideUpdate({ local: '1.0.0', latest: '1.1.0', hasUpstream: true }).verdict, 'update-available');
  assert.equal(decideUpdate({ local: '1.1.0', latest: '1.0.0', hasUpstream: true }).verdict, 'up-to-date');
  assert.equal(decideUpdate({ local: '1.0.0', latest: '1.0.0', hasUpstream: true }).verdict, 'up-to-date');
});

test('尸体（最危险的一格）：查询失败必须与「已最新」分开', () => {
  const r = decideUpdate({ local: '1.0.0', latest: null, fetchError: 'HTTP 404', hasUpstream: true });
  assert.equal(r.verdict, 'fetch-failed');
  assert.notEqual(r.verdict, 'up-to-date', '网络断掉不得被读成「没更新」');
  assert.match(r.note, /404/);
  // 上游没回版本也是 fetch-failed，不是 up-to-date
  assert.equal(decideUpdate({ local: '1.0.0', latest: '', hasUpstream: true }).verdict, 'fetch-failed');
  // 本地版本读不到同样是 fetch-failed
  assert.equal(decideUpdate({ local: '', latest: '1.0.0', hasUpstream: true }).verdict, 'fetch-failed');
});

test('尸体：无上游源与不可比各自成档，不塌缩成「已最新」', () => {
  assert.equal(decideUpdate({ local: '1.0.0', latest: '1.0.0', hasUpstream: false }).verdict, 'no-upstream');
  const nc = decideUpdate({ local: '1.0.0-beta.5', latest: '1.0.0-beta.10', hasUpstream: true });
  assert.equal(nc.verdict, 'not-comparable');
  assert.equal(nc.compare?.cmp, null);
  assert.equal(decideUpdate({ local: '1.0.0', latest: '2.0.0', hasUpstream: true, skipped: true }).verdict, 'skipped');
});

test('六档各有独立文案，且渲染行带版本对', () => {
  const line = updateLine({ name: 'dsh-ops', local: '0.2.6', latest: '0.3.0', verdict: 'update-available', note: 'x' });
  assert.match(line, /dsh-ops/);
  assert.match(line, /0\.2\.6/);
  assert.match(line, /0\.3\.0/);
  assert.match(line, /有更新/);
});

// ── 覆盖度对账 ────────────────────────────────────────────────────────────

test('尸体：漏查的上游必须被点出来（防「截断读数当完整证据」）', () => {
  const missing = unresolvedCoverage(['a', 'b', 'c'], ['a', 'c']);
  assert.deepEqual(missing, ['b'], '漏查的必须显式列出');
  assert.deepEqual(unresolvedCoverage(['a'], ['a']), []);
  assert.deepEqual(unresolvedCoverage([], []), []);
});

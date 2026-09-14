/**
 * registry 的第三方盘点单测（§5.23）。
 *
 * 现场动机（2026-09-14）：主人装了第三方插件 `dsh-x-opencode-session`（profile 依赖
 * `github:Coco-king/…#commit` + `dsh.profile.bundles`），`plugin_list --source third-party`
 * **什么都没返回**——原 `scanThirdParty` 只认 `link:` 形态，git pin / tarball / registry
 * 三种形态被整条跳过。本测试把四种安装形态全部钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyDependency,
  isThirdPartyDep,
  redactSpec,
  scanThirdParty,
} from '../lib/registry.js';

// ── 档位判定（纯函数） ────────────────────────────────────────────────────

test('classifyDependency: 四种第三方安装形态 + 自研/官方两档，全部可分', () => {
  // 自研：link: 指向 self-plugins
  assert.equal(classifyDependency('dsh-agent-browser', 'link:E:/alice/self-plugins/dsh-agent-browser'), 'self-link');
  // 本地 link（非自研、非官方）
  assert.equal(classifyDependency('my-tool', 'link:E:/alice/tools/my-tool'), 'local-link');
  // 官方（scope 优先，含源码化 link）
  assert.equal(classifyDependency('@deepseek-ai/dsh-base', '^1.0.0'), 'official');
  assert.equal(classifyDependency('@deepseek-ai/dsh-web-app', 'link:E:/alice/deepseek-harness/packages/web'), 'official');
  // 第三方四形态
  assert.equal(classifyDependency('dsh-x-opencode-session', 'github:Coco-king/dsh-x-opencode-session#2e7ce82'), 'third-party-git');
  assert.equal(classifyDependency('x', 'https://codeload.github.com/a/b/tar.gz/deadbeef'), 'third-party-tarball');
  assert.equal(classifyDependency('x', 'file:../somewhere'), 'third-party-local');
  assert.equal(classifyDependency('x', '^0.3.1'), 'third-party-registry');
});

test('isThirdPartyDep: 只有 third-party-* 四档算第三方', () => {
  assert.equal(isThirdPartyDep('third-party-git'), true);
  assert.equal(isThirdPartyDep('third-party-registry'), true);
  assert.equal(isThirdPartyDep('self-link'), false);
  assert.equal(isThirdPartyDep('official'), false);
});

test('redactSpec: URL userinfo 与 token 类参数不落盘，pin 保留', () => {
  assert.equal(redactSpec('https://user:pass@example.com/pkg.tgz'), 'https://example.com/pkg.tgz');
  assert.equal(redactSpec('https://x/pkg.tgz?token=S3CR3T'), 'https://x/pkg.tgz?token=[redacted]');
  assert.equal(redactSpec('github:acme/plug#deadbeef'), 'github:acme/plug#deadbeef');
});

// ── 盘点 IO（夹具） ───────────────────────────────────────────────────────

function makeProfiles() {
  const root = mkdtempSync(join(tmpdir(), 'pm-thirdparty-'));
  const profilesDir = join(root, 'profiles');
  const selfPluginsDir = join(root, 'self-plugins');
  const web = join(profilesDir, 'web');
  mkdirSync(web, { recursive: true });
  mkdirSync(join(selfPluginsDir, 'dsh-agent-browser'), { recursive: true });
  writeFileSync(join(selfPluginsDir, 'dsh-agent-browser', 'package.json'), JSON.stringify({ name: 'dsh-agent-browser', version: '0.1.0' }));
  writeFileSync(join(web, 'cordis.patch.yml'), '- insert:\n    - id: agent-browser\n      name: dsh-agent-browser\n');
  writeFileSync(
    join(web, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: {
        'dsh-agent-browser': `link:${join(selfPluginsDir, 'dsh-agent-browser')}`,
        '@deepseek-ai/dsh-base': '^1.0.0',
        'dsh-x-opencode-session': 'github:Coco-king/dsh-x-opencode-session#2e7ce82c9fa821f63edb80f2ab641a87e1a7de3c',
        'some-registry-plugin': '^0.3.1',
      },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-x-opencode-session'] } },
    }),
  );
  const installed = join(web, 'node_modules', 'dsh-x-opencode-session');
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'dsh-x-opencode-session', version: '0.1.0', description: '给 opencode.ai 请求附加 x-opencode-session 头' }));
  return { root, profilesDir, selfPluginsDir };
}

test('scanThirdParty: git pin 形态（bundle 挂载）必须被盘点到——这是本次修复的核心', () => {
  const { root, profilesDir, selfPluginsDir } = makeProfiles();
  try {
    const list = scanThirdParty(profilesDir, selfPluginsDir);
    const names = list.map((p) => p.name);
    assert.deepEqual(names, ['dsh-x-opencode-session', 'some-registry-plugin']);
    // 自研与官方不混进第三方档
    assert.equal(names.includes('dsh-agent-browser'), false);
    assert.equal(names.includes('@deepseek-ai/dsh-base'), false);

    const pin = list.find((p) => p.name === 'dsh-x-opencode-session');
    assert.ok(pin);
    assert.equal(pin.source, 'third-party');
    assert.equal(pin.version, '0.1.0');
    assert.equal(pin.bundle, true, 'bundle 形态必须标出（它决定挂载方式：自述式，非 patch 行）');
    assert.equal(pin.status, 'mounted', 'bundle 列在 dsh.profile.bundles ⇒ 已挂载');
    assert.deepEqual(pin.profiles, ['web']);
    assert.match(pin.spec ?? '', /github:Coco-king\/dsh-x-opencode-session#2e7ce82/, 'pin 必须在档案里（升级/回退靠它）');
    assert.match(pin.purpose, /opencode/);

    const registryPkg = list.find((p) => p.name === 'some-registry-plugin');
    assert.ok(registryPkg);
    assert.equal(registryPkg.bundle, false);
    assert.equal(registryPkg.status, 'unmounted', '既不在 bundles 也没有 patch 行 ⇒ 未挂载');
    assert.equal(registryPkg.version, '', '未安装 ⇒ 版本留空，不编造');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanThirdParty: 路径不存在不抛（观测绝不反噬主流程）', () => {
  assert.deepEqual(scanThirdParty('E:/definitely/not/here/profiles', 'E:/definitely/not/here/self-plugins'), []);
});

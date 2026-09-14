/**
 * 第三方生命周期拦截文案单测（§5.23）。
 *
 * 现场动机（2026-09-14）：主人装了第三方插件后，`plugin_mount` 走的是**自研路径**
 * （写 `link:` 依赖 + 插 patch 行）——对第三方形态是错的；而原实现既不会成功，也不会
 * 说清「为什么不行、该走哪条路」（会落到「插件不存在 / 未挂载」这类不达意分支）。
 * 本测试钉住：拒绝文案必须**指名来源、给出升级/回退与卸载两条具体路径**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { thirdPartyRefusal } from '../lib/ops-logic.js';

const SPEC = 'github:Coco-king/dsh-x-opencode-session#2e7ce82';

test('thirdPartyRefusal: 文案含插件名、来源 pin、profile 与两条指路（升级/回退 + 卸载）', () => {
  const msg = thirdPartyRefusal('mount', 'dsh-x-opencode-session', SPEC, 'web', true);
  assert.match(msg, /^拒绝：dsh-x-opencode-session 是\*\*第三方插件\*\*/);
  assert.match(msg, /§5\.23/);
  assert.match(msg, new RegExp(SPEC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(msg, /web 的 package\.json 里该依赖的 pin/);
  assert.match(msg, /dsh plugin --profile web add <url>#<tag>/);
  assert.match(msg, /dsh plugin --profile web remove dsh-x-opencode-session/);
  assert.match(msg, /bundle 形态：包自带 dsh\.bundle\.patch/);
});

test('thirdPartyRefusal: bundle=false 时不出现 bundle 说明（不编造形态）', () => {
  const msg = thirdPartyRefusal('mount', 'some-registry-plugin', '^0.3.1', 'web', false);
  assert.match(msg, /\^0\.3\.1/);
  assert.doesNotMatch(msg, /bundle 形态/);
});

test('thirdPartyRefusal: 动词按动作变化（挂载/卸载/启动/停用/配置）', () => {
  const verbs = {
    mount: '挂载', unmount: '卸载', start: '启动', stop: '停用', configure: '配置',
  };
  for (const [action, verb] of Object.entries(verbs)) {
    const msg = thirdPartyRefusal(action, 'x', 'spec', 'web', false);
    assert.match(msg, new RegExp('不走本工具的生命周期（' + verb + '）'), action + ' 的动词应为 ' + verb);
  }
});

test('第三方拒绝 ≠ 自研路径：文案必须解释「两条路不可混用」的理由（而不是只说不行）', () => {
  const msg = thirdPartyRefusal('configure', 'x', 'github:a/b#c', 'web', true);
  assert.match(msg, /自研（self-plugins \+ patch 行）与第三方（profile 依赖 \+ bundle）是两条不可混用的管理路/);
  assert.match(msg, /第三方盘点用 plugin_list（source=third-party）与 plugin_boot_status/);
});

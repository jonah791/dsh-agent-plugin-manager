# 语义文档：dsh-agent-plugin-manager（插件管理器）

| 项 | 值 |
|----|----|
| 能力名 | dsh-agent-plugin-manager（插件内 `name = 'agent-plugin-manager'`；组合行 id `agent-plugin-manager`） |
| 主副本路径 | `self-plugins/dsh-agent-plugin-manager/docs/semantic.md` |
| 实现落点 | `self-plugins/dsh-agent-plugin-manager/src/index.ts`（工具面 + 预检门控 + 重启闸门）<br>`.../src/registry.ts`（档案库纯函数：扫描/对账/工具提取）<br>`.../src/profile.ts`（patch 行编辑 / link 依赖 / pnpm install / 预检 / 回滚）<br>`.../src/preflight-gate.ts`（门控纯逻辑：调用者提取 + 进程级裁决）<br>`.../src/sentinel.ts`（哨兵写入）<br>`.../src/client/index.ts` + `src/client/remote.ts` + `src/client/PluginManagerAction.tsx`（client 面） |
| 版本 | 0.1.3（`package.json`） |
| 挂载位置 | `E:\alice\.dsh\profiles\web\cordis.patch.yml` 第 77 行 `- insert:` / 第 78 行 `- id: agent-plugin-manager` / 第 79 行 `name: dsh-agent-plugin-manager`；第 80–85 行 `config`（`dshHome: E:/alice/.dsh`、`selfPluginsDir: E:/alice/self-plugins`、`profilesDir: E:/alice/.dsh/profiles`、`bin: E:/alice/deepseek-harness/apps/cli/lib/bin.js`、`defaultWorkspace: E:/alice`） |
| 状态 | **draft**（补课文档：语义已从源码读出，验收条目多数待线上复核） |
| 依赖服务 | `inject = ['tools', 'loader', 'sessions']`（运行时全量；`ctx.loader.entries()` 是挂载状态的权威源） |
| 外部依赖 | `js-yaml`、`dsh-agent-preflight`（link 依赖，`runPreflightCore`）、`pnpm` CLI、`@deepseek-ai/dsh/lib/bin.js`（试运行入口） |
| 客户端面 | Typert remote 服务 `pluginManagerRemote`（namespace `pluginManager`），方法 `list/inspect/start/stop/unmount/create` |

---

## 1 · 定位与反定位

**定位**：DSH 的**插件档案库 + 生命周期操作面**——把「有哪些插件、什么来源、挂到哪个 profile、装了什么工具、配置是什么」变成一条命令可查（`plugin_list` / `plugin_inspect`），
并把「创建 / 挂载 / 启停 / 卸载 / 改配置」做成**带备份与回滚的闭环操作**（写 patch → 装依赖 → 试运行预检 → 写哨兵 → watch 重启）。
另含两件与「重启」直接相关的职责：`preflight_check`（预检 + 落盘「本 web 进程内调用过」证据）与 `daemon_restart`（重启闸门 + 写哨兵）。

**反定位（本文不管什么）**：
- 不管**进程**生命周期（kill/spawn/保活）——那属于 `dsh-agent-guardian`（守护）与 `dsh-agent-sentinel`（哨兵）；本插件只**写哨兵**请求重启
- 不管**预检的实现**——预检本体（试运行、探活、检查项）属于 `dsh-agent-preflight`（本插件经 `runPreflightCore` 调用，**零重复实现**）
- 不管**语义文档的注册与检查**——那属于 `dsh-semantic-docs`
- **不是**沙箱、不是权限边界：有权限的调用方仍能改任意 profile 文件；本插件只保证「改之前先备份、改坏了能回滚」
- **不是** npm 包管理器：`pnpm install` 是它 spawn 的外部进程，不是它实现的功能

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| 档案（archive） | 一个插件的元信息集合：`name/version/source/path/purpose/category/client/tools/built/status/profiles/config` |
| 来源（source） | `self`（`self-plugins/` 内）/ `official`（`@deepseek-ai/*`）/ `third-party`（profile 里 `link:` 指向 self-plugins 之外的包） |
| 挂载状态（status） | `mounted` / `disabled` / `unmounted`——**以运行时 loader 为权威**，静态快照（`data/system-state.json`）只作补充 |
| 组合变更（composition change） | 改 `cordis.patch.yml` 或改插件代码后重新构建；**此时旧实例健康不构成免检理由**（AGENTS.md §5.11） |
| 未验证构建（unverified build） | 某 `self-plugins/*/lib/index.js` 的 mtime 晚于本 web 进程启动时刻（`hasUnverifiedBuilds()`） |
| 哨兵（sentinel flag） | `<DSH_HOME>/.hot-reload-flag`（JSON：`workspace/sessionId/note`）——写入即请求 watch 执行「预检 → 重启 → 唤醒 → 清哨兵」 |
| 进程级判据 | 重启闸门的判据是「**本 web 进程启动后**是否调用过 `preflight_check`」，**不比对会话 id**（§5.11 §3，设计如此） |
| 回滚（rollback） | 用 `.bak-<ISO 时间戳>` 副本覆盖回原文件（`rollbackFile`） |

## 3 · 概念模型

```
爱丽丝（模型）
  │ 10 个工具（plugin_* / preflight_check / daemon_restart）
  ▼
src/index.ts:apply
  ├─ createOps(...)  ──→  src/registry.ts  扫描 self-plugins + profiles/*/cordis.patch.yml + 官方 bundles
  │                       └─ alignWithLoader(loader.entries())  ← loader 是挂载状态权威
  ├─ 生命周期操作（mount/unmount/setEnabled/configure/create）
  │     └─ src/profile.ts: patchInsert/patchRemove/patchSetDisabled/patchSetConfig
  │                        packageAddLinkDep/packageRemoveDep → spawn('pnpm install --package-import-method=copy')
  │                        preflight() → dsh-agent-preflight/core:runPreflightCore
  │                        失败 → rollbackFile(.bak-<ts>)（**回滚后再抛错，不重启**）
  ├─ triggerReload(note) → src/sentinel.ts:writeSentinel(<DSH_HOME>/.hot-reload-flag)
  ├─ .plugin-manager-events.log 追加事件行（侧车轨迹，供并行实例协调）
  ├─ preflight_check 工具：预检 + recordPreflightInvoked() → <DSH_HOME>/.preflight-invoked.json
  └─ daemon_restart 工具：decidePreflightGate() 放行 → 写哨兵；拒绝 → 返回原因

client（浏览器）：src/client/index.ts ──$mount──→ remote.ts（TYPERT_REMOTE，namespace 'pluginManager'）
  └─ GUI 入口已迁至面板宿主 dsh-panel 的 plugin-manager 面板（本插件保留 $mount 与 remote 能力）
```

不变量（invariants）：
1. **I1 改前必备份**：每次 patch/package.json 修改先 `copyFileSync` 出 `.bak-<ISO>`；没有 `.bak` 的写入是不合规的（可测：改动后目录里必有对应 `.bak-*` 文件）。
2. **I2 预检失败必回滚且不写哨兵**：`preflight().pass === false` 时回滚全部已改文件并**返回 `ok:false`**——`triggerReload` 不得被调用（可测：事件日志里没有该次操作的「哨兵已写」行）。
3. **I3 挂载状态以 loader 为准**：`plugin_list` 的 `status` 与 `ctx.loader.entries()` 一致；静态快照与 loader 冲突时以 loader 胜（`alignWithLoader`）。
4. **I4 重启用进程级闸门**：`daemon_restart` 在「本进程启动后未调用过 `preflight_check`」或「最近一次预检 `pass !== true`」时**必须拒绝**（`decidePreflightGate` 四条判据）。
5. **I5 卸载保留数据**：`plugin_unmount` 只移除 patch 行与 link 依赖，**不删插件目录**（数据目录保留）。
6. **I6 只读面永不抛**：`plugin_list` / `plugin_inspect` 对坏包、缺失目录跳过并继续（`scanSelfPlugins` 逐目录 try/catch），不因单个坏插件整体失败。

## 4 · 契约

### 4.1 配置（`Config` schema）
| 字段 | 默认 | 说明 | 实际使用 |
|------|------|------|---------|
| `dshHome` | `process.env.DSH_HOME ?? ''` | DSH 主目录（哨兵/事件日志/预检记录落点） | 使用 |
| `selfPluginsDir` | `''`（回退 `join(dshHome,'self-plugins')`） | 自研插件根 | 使用 |
| `profilesDir` | `''`（回退 `join(dshHome,'profiles')`） | profile 根 | 使用 |
| `bin` | `''`（回退 `require.resolve('@deepseek-ai/dsh/lib/bin.js')`） | 试运行入口 | 使用 |
| `mainSessionId` | `''` | 哨兵里的唤醒目标；为空则追踪最新活跃主体会话 | 使用 |
| `defaultWorkspace` | `''`（回退 `process.cwd()`） | 工作区（哨兵 + 闸门 workspace 比对） | 使用 |
| `installTimeoutMs` | `600000` | `pnpm install` 超时 | 使用 |
| `registryFile` | `''` | —— | **死配置**：声明 + 默认值存在，全仓库无读取点（`grep registryFile src/` 仅命中声明处） |

### 4.2 工具面（10 个，`src/index.ts`）
| 工具 | 注册行 | 作用 | 关键裁决 |
|------|-------|------|---------|
| `plugin_list` | L410–411 | 档案列表（按 `source`/`status` 过滤，分组渲染） | 状态经 loader 对齐（I3）；**第三方档覆盖四种安装形态**（见 §4.3「第三方盘点」行，2026-09-14 修） |
| `plugin_inspect` | L427–428 | 单插件深度档案 | 不存在 → `ok:false`（第三方档命中后不再误报「不存在」） |
| `plugin_create` | L438–439 | 生成脚手架（`package.json`/`tsconfig.json`/`src/index.ts`/`README.md`） | 目录已存在 / 名字非法 → `ok:false` |
| `plugin_mount` | L451–452 | link 依赖 + install + patch insert + 预检 + 哨兵 | 已挂载 / 官方 bundle / profile 不存在 → 拒绝；**第三方 → 显式拒绝并指路**（`thirdPartyRefusal`，§5.23） |
| `plugin_unmount` | L465–466 | patch 移除 + 依赖移除 + install + 预检 + 哨兵 | 未挂载 → 拒绝；数据目录保留（I5）；**第三方 → 显式拒绝**（第三方卸载走 `dsh plugin remove`） |
| `plugin_start` / `plugin_stop` | 循环注册 L478（`name` 由 `toolName` 计算） | `disabled` 切换 + 预检 + 哨兵 | 已是目标状态 → 拒绝；**第三方 → 显式拒绝**（bundle 形态无 patch 行可控） |
| `plugin_configure` | L493–494 | patch `config` **整体替换** + 预检 + 哨兵 | 未挂载 → 拒绝；**第三方 → 显式拒绝**（其配置由 profile 依赖与包自身约定决定） |
| `preflight_check` | L507–508 | 试运行预检 + 落盘调用记录 | `profile==='web'` 且无未验证构建 → 短路（`probeExistingFirst=true`） |
| `daemon_restart` | L539–540 | 闸门校验通过 → 写哨兵请求重启 | 未调用过预检 / 预检未过 → **拒绝**（I4） |

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号 / 行号） | 时机 |
|-------|--------------------------|------|
| web profile 组合 | `.dsh/profiles/web/cordis.patch.yml:78-85`（`id: agent-plugin-manager` + 5 项 config） | web 启动挂载 |
| 插件本体 | `src/index.ts:355 apply()` → `createOps()`(L132) → `ctx.plugin(PluginManagerRemoteService, ops)`(L361) | 挂载时 |
| 插件本体 | `src/index.ts:410/427/438/451/465/478/493/507/539` 共 10 个 `ctx.tools.register(defineTool({...}))` | 挂载时注册 |
| 档案库 | `src/index.ts:list()/inspect()` → `src/registry.ts:buildRegistry`(L450) ← `scanSelfPlugins`(L213) + `listProfiles`(L256) + `scanOfficialBundles`(L276) + `scanThirdParty`(L347) + `loadOfficialCatalog`(L415) + `loadSystemState`(L431) + `alignWithLoader`(L516) | 每次查询 |
| 工具提取 | `src/registry.ts:extractTools`(L131)（扫 `src/`+`lib/` 的 `.ts/.js/.mjs`，跳过注释行） | 查询时 |
| patch 行编辑 | `src/profile.ts:patchInsert`(L31) / `patchRemove`(L50) / `patchSetDisabled`(L94) / `patchSetConfig`(L133) | 挂载/启停/配置/卸载 |
| 依赖编辑 | `src/profile.ts:packageAddLinkDep`(L188) / `packageRemoveDep`(L204) / `installProfile`(L220，`spawn('pnpm', ...)`，`shell:true`) | 挂载/卸载 |
| 预检 | `src/profile.ts:preflight`(L242) → `runPreflightCore`(L255)（`preflightReadyMs` 默认 90000，`probeExistingFirst` 默认 false） | 每个组合变更操作；`preflight_check` 工具 |
| 回滚 | `src/profile.ts:rollbackFile`(L296) | 预检失败 / install 失败 |
| 哨兵 | `src/sentinel.ts:writeSentinel`(L15) → `<DSH_HOME>/.hot-reload-flag`；`clearSentinel`(L26)（清空为 `''`，本插件不调用） | 每次成功操作与 `daemon_restart` |
| 会话解析 | `src/index.ts:resolveActiveSessionId`(L127)（主体 = `delegationDepth===0`，取最后事件时间最大者） | 写哨兵前 |
| 重启闸门 | `src/index.ts:preflightInvokedInProcess`(L401) → `src/preflight-gate.ts:decidePreflightGate`(L79)；调用者提取 `extractCaller`(L48) | `daemon_restart` |
| 未验证构建检测 | `src/index.ts:hasUnverifiedBuilds`(L78)（本进程启动时刻 = `Date.now() - process.uptime()*1000`，L81；扫 `dshHome/../self-plugins` 等三候选） | `preflight_check` 决定是否短路 |
| client 面 | `src/client/index.ts:16 apply()` → `ctx.remote.$mount(TYPERT_REMOTE)`（15s 超时 ×8 次重试）→ `ctx.plugin({name:'plugin-manager-ui'})`（**槽位注册已于 2026-09-13 撤除**，L41–44 注释保留恢复点） | 每个 web 会话 |
| client remote 契约 | `src/client/remote.ts:39 TYPERT_REMOTE`（`service: 'pluginManagerRemote'`，`namespace: 'pluginManager'`，方法 `list/inspect/start/stop/unmount/create`）；host 侧 `src/index.ts:321 PluginManagerRemoteService`（`@Remote` 于 L327/331/336/340/345/349） | 面板/客户端调用 |
| 落盘产物 | `<DSH_HOME>/.hot-reload-flag`（哨兵）<br>`<DSH_HOME>/.plugin-manager-events.log`（事件行 `[ISO] msg`，L144）<br>`<DSH_HOME>/.preflight-invoked.json`（`at/atMs/workspace/sessionId/pass/mode/caller`，L369/371）<br>`<DSH_HOME>/preflight-fail-report.json`（`src/profile.ts:279`，仅预检 FAIL 时）<br>`<profileDir>/cordis.patch.yml.bak-<ts>`、`<profileDir>/package.json.bak-<ts>` | 操作时 |
| 只读数据源 | `self-plugins/*/package.json`、`data/official-plugins.json`、`data/system-state.json`、各 profile 的 `cordis.patch.yml` + `package.json` + `node_modules/<bundle>/package.json` | 查询时 |
| **第三方盘点** | `registry.ts:classifyDependency(name, spec)`（纯函数：`self-link`/`local-link`/`official`/`third-party-{git,tarball,registry,local}`）+ `scanThirdParty(profilesDir, selfPluginsDir)`：**四种安装形态全覆盖**——`link:`（落点 = link 目标）与 git pin / tarball / registry / `file:`（落点 = `<profileDir>/node_modules/<name>`）；`bundle` = 列在该 profile 的 `dsh.profile.bundles`（自述式挂载 ⇒ mounted）；`spec` 经 `redactSpec` 脱敏后进档案（升级/回退的唯一指纹） | `plugin_list`/`plugin_inspect`（§5.23） |
| 消费方 | 爱丽丝（`plugin_list`/`plugin_inspect` 认知插件面；`plugin_mount` 等实施部署）；`daemon_restart` 被「重启前必须先预检」纪律消费；watch（哨兵文件）；面板宿主 `dsh-panel` 的 `plugin-manager` 面板（经 remote） | 运行时 |
| 测试 | `test/registry.test.mjs`（12 条：parsePatchRows/extractTools/isBuilt/patch* 行编辑/依赖增删/`buildRegistry` 对账）<br>`test/preflight-gate.test.mjs`（门控裁决与调用者提取）<br>`tests/event-log.test.mjs`、`tests/ops-logic.test.mjs`<br>`tests/registry-deps.test.mjs`（**2026-09-14 新增**：第三方四形态判定 + 脱敏 + `scanThirdParty` 夹具〔git-pin 带 bundle ⇒ mounted；registry 未安装 ⇒ unmounted/版本留空〕+ 路径不存在不抛）<br>（`test/debug.mjs`、`test/only-registry.mjs` 为手工调试脚本，非 `node --test` 命名）<br>跑法：`npm test` = `node --test "tests/*.test.mjs" "test/*.test.mjs"` | 离线 |

## 5 · 边界与信任

- 能力边界 ≠ 沙箱：本插件**能改 profile 组合、能 spawn `pnpm install`、能写哨兵触发 web 重启**——它不校验调用者意图，也不阻止误操作。保护来自 ① 备份 + 回滚 ② 预检门控 ③ 上层（爱丽丝/主人的裁决包）。
- 不越界清单：不 kill/spawn web 进程（那是 watch/guardian）；不实现预检本体（调 `dsh-agent-preflight`）；不删插件数据目录；不改插件源码（`plugin_create` 只生成新目录）；不 commit/push。
- 失败面：
  - **写失败**：patch 写入失败 → `ok:false`（不动哨兵）；`pnpm install` 失败 → 回滚 `package.json`（+ patch，若已写）+ 返回 install 输出尾部 200 字符；预检失败 → 回滚全部已改文件 + 返回 FAIL 明细（截断 800 字符）。
  - **读失败**：`registry.ts` 各扫描器逐目录 try/catch，坏包跳过；`loadSystemState`/`loadOfficialCatalog` 读不到 → 返回 `{}`/`[]`（**不抛**）。
  - **闸门读失败**：`.preflight-invoked.json` 不可读/坏 JSON → **fail-closed 拒绝重启**（`preflight-gate.ts:426` 返回 `预检记录不可读`）。
  - **超时**：`pnpm install` 超时（默认 600s）→ kill + `[timeout]` 标记 + 回滚；预检试运行超时 → 判 FAIL（不放行）。
  - **证据行落盘失败**：事件日志/证据行写入失败**不阻断主流程**（try/catch 吞掉，L558/574）。

## 6 · 与既有机制的关系

- 与 **§5.11 组合变更必验证**：本插件是该纪律的两个关键实现点——`hasUnverifiedBuilds()`（L78，构建比进程新 → 强制完整试运行）与 `preflight_gate`（进程级重启闸门）。判据是**进程级**：`rec.atMs >= webStartMs`，**不比对 sessionId**（`sessionId` 字段是历史遗留，真实调用者记在 `caller`）。
- 与 **`dsh-agent-preflight`**：本插件不重写预检（`profile.ts` 头部注释）——`preflight()` 是 `runPreflightCore` 的薄封装（预算 `preflightReadyMs = 90000`，为 48 插件组合实测 40s 的 2.25x 余量）。
- 与 **watch（sentinel/guardian）**：分工 = 「watch 管进程，本插件管插件」。本插件只写哨兵文件；预检 → kill+重启 → 唤醒 → 清哨兵由 watch 侧执行。同一资源的单点所有权见 §5.19。
- 与 **§5.19 单点所有权**：`.hot-reload-flag` 由本插件写、watch 消费并清理；本插件**不**自己 kill/拉起 web。
- 与 **§5.14 并行实例协调**：`.plugin-manager-events.log` 是「另一个我是否正在部署」的判据来源，故它由 `src/event-log.ts:appendLineSafe`（吞错返回 bool）写入，**事件行失败绝不阻断主流程**。
- 与 **§5.20 语义文档系统**：本插件的挂载/配置操作是「组合变更」的典型来源，改组合后须复核本文件与注册表条目。

**生效判据（改代码后怎么证明真的生效）**：
1. **产物比进程新**：`self-plugins/dsh-agent-plugin-manager/lib/index.js` 的 mtime **晚于**当前 web 进程启动时刻（§5.11 进程级判据；`preflight_check` 的 `hasUnverifiedBuilds()` 用同一口径）。
2. **工具面在场**：本会话工具列表能列出 10 个工具（含 `preflight_check`/`daemon_restart`）；`plugin_inspect dsh-agent-plugin-manager` 返回 `status: mounted`、`version 0.1.1`。
3. **行为可答**：`plugin_list` 返回三条来源分组（自研/官方/非官方）；`preflight_check {mode:'quick'}` 返回 `pass` 且 `<DSH_HOME>/.preflight-invoked.json` 的 `atMs` **前进**（这是「我的调用落了盘」的物证）。
4. **闸门可证伪**：未预检时调 `daemon_restart` → 必须被拒绝，且 `.plugin-manager-events.log` 出现 `daemon_restart 门控证据：… 结论=拒绝` 行。

**回退**：`git revert` 本仓库最近一次提交（或 `git checkout -- src/` 丢弃未提交改动）→ `pnpm build` → 预检 → 写哨兵/`daemon_restart` 重启 web。
配置回退：用 `plugin_configure dsh-agent-plugin-manager` 还原上一组 config（patch 整体替换会留 `.bak-<时间戳>`，必要时把 `.bak-*` 复制回 `cordis.patch.yml`）。
单次操作回退：任何被拒/失败的组合变更都已被自动回滚；手工回退用最新的 `cordis.patch.yml.bak-*` + `package.json.bak-*`。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名/命令/日志行/grep） | 状态 |
|---|-----------|------------------------------|------|
| A1 | 工具面恰为 10 个（含 `preflight_check`/`daemon_restart`） | `grep -c "name: 'plugin_\|name: 'preflight_check'\|name: 'daemon_restart'" src/index.ts` 与工具列表对照 | 已实测（独立复核：8 个字面 `name:` + 1 行循环覆盖 start/stop = 10） |
| A2 | patch 行编辑保留注释与其余块（幂等：同 id 再插返回 `inserted:false`） | `node --test test/registry.test.mjs`（`patchInsert`/`patchSetDisabled`/`patchSetConfig`/`patchRemove` 四组用例） | 待验收 |
| A3 | 档案状态以 loader 为权威（静态快照不覆盖动态状态） | `test/registry.test.mjs:buildRegistry 全量对账` + `plugin_list` 与 `plugin_inspect` 对同一插件状态一致 | 待验收 |
| A4 | 未验证构建 → 强制完整试运行（不短路） | 构建任一插件后调 `preflight_check`：耗时应为数十秒（完整试运行），而非毫秒级 | 待验收 |
| A5 | 闸门 fail-closed：未预检 / 预检未过 / 记录不可读 → `daemon_restart` 拒绝 | `test/preflight-gate.test.mjs` 中 `decidePreflightGate` 四条判据用例；线上：删除/改坏 `.preflight-invoked.json` 后重启必须被拒 | 待验收 |
| A6 | 预检失败必回滚且不写哨兵 | 造一次必然 FAIL 的插入 → 操作返回 `ok:false` + `.bak-*` 已还原 + `.hot-reload-flag` 未更新 | 待验收 |
| A7 | 事件日志吞错不阻断（观测不反噬主流程） | `grep -n "appendLineSafe\|catch" src/event-log.ts`（返回 bool、不抛）+ `.plugin-manager-events.log` 存在且末行格式 `[ISO] 消息` | 待验收 |
| A8 | 卸载保留插件数据目录 | `plugin_unmount` 后 `self-plugins/<name>/` 仍存在，仅 patch 行与 `link:` 依赖消失 | 待验收 |
| A9 | client 槽位已撤除（GUI 单一入口 = 面板宿主） | `grep -n "session.header.actions" src/client/index.ts` 无注册语句（仅注释） | 已实测（独立复核：仅 L42 注释命中） |
| A10 | **第三方四种安装形态全部可盘点**（git pin / tarball / registry / `file:`）；`link:` 到 self-plugins 的自研**不混入**；bundle 形态标 `bundle=true` 且判 mounted | `node --test tests/registry-deps.test.mjs`（夹具：git-pin 带 `dsh.profile.bundles` ⇒ mounted；registry 未安装 ⇒ unmounted 且版本留空；自研/官方不入第三方档） | 已证（单测；线上见 A11） |
| A11 | 线上 `plugin_list --source third-party` 能看到 bundle 形态的第三方（此前为空） | 重启后调 `plugin_list {source:'third-party'}` → 含 `dsh-x-opencode-session`（bundle=true、spec 带 commit pin） | **已证（2026-09-14 15:47:57 重启后实测）**：`▸ 非官方（第三方）（1）• dsh-x-opencode-session 0.1.0 [mounted]` + `挂载: web` + `bundle: true` + `来源: github:Coco-king/dsh-x-opencode-session#2e7ce82…`；修前同一调用返回空列表 |
| A12 | **第三方不得走自研生命周期**：`plugin_mount`/`unmount`/`start`/`stop`/`configure` 对第三方一律拒绝，且文案指名来源与两条指路（改 pin / `dsh plugin`） | `node --test tests/third-party-refusal.test.mjs`（4 条：文案含名/pin/profile/两条命令/§5.23 依据；bundle=false 不编造形态；五个动作动词各异） | 单测已证；**线上待验收**（对 `dsh-x-opencode-session` 调 `plugin_mount` 应返回拒绝文案，且**不写任何文件**） |

## 8 · 与实现的关系

- 主实现：`src/index.ts`（工具面 / 门控 / 生命周期编排）+ `src/registry.ts`（纯函数档案库）+ `src/profile.ts`（文件级操作与回滚）+ `src/preflight-gate.ts`（纯逻辑门控）+ `src/sentinel.ts`（28 行薄壳）。
- 同语义副本：无。预检本体语义属 `dsh-agent-preflight`（其 `docs/semantic.md` 为主副本）；哨兵协议消费方语义属 watch 侧（`dsh-agent-sentinel` 文档）。
- **并行写入声明（2026-09-14 实测）**：本次补课期间另一实例正在重构 `src/index.ts`（`git status` 显示 `M src/index.ts` + 未跟踪 `src/event-log.ts`/`src/ops-logic.ts`，mtime 10:24–10:25）。本文行号口径为**该时刻的磁盘状态**（`Select-String` 实测）；重构合入后行号可能漂移——**以符号名（`plugin_list`/`decidePreflightGate`/`hasUnverifiedBuilds`）为准**。
- 未实现/未验证部分（显式标注）：
  - `registryFile` 为**死配置**（声明 + 默认值，无读取点）。
  - README 的工具表只列 7 个（未含 `preflight_check`/`daemon_restart`），且来源表述为「self/official」——实际来源有 `third-party` 一类（计数漂移）。
  - `test/preflight-gate.test.mjs` 覆盖纯逻辑层；**端到端**（真改 profile → 真预检 → 真回滚）无自动化测试，A1/A4/A6/A8/A9 需线上取证。

## 9 · 实践修订记录

- **2026-09-14 补课：本插件此前无语义文档（可维护性工程）**
  - 语义**被确认**：10 工具面 / 改前必备份 + 预检失败必回滚 / 挂载状态以 loader 为权威 / 重启闸门是**进程级**判据（不比对 sessionId）/ 卸载保留数据目录。
  - 语义**被补充**：三处散落产物此前未在任何文档成文——`<DSH_HOME>/.plugin-manager-events.log`（并行实例协调的判据，§5.22 要求的侧车轨迹）、`<DSH_HOME>/.preflight-invoked.json`（含 `caller` 真实调用者）、`<DSH_HOME>/preflight-fail-report.json`（预检 FAIL 自动落盘报告）。
  - 语义**被修正**：无（首次成文）；但记录两处「文案与事实不符」的历史订正已在源码注释中（`sessionId` 字段不是调用者；闸门不比对会话 id，见 `preflight-gate.ts` 头注）。
  - 教训：**契约表必须写「实际使用」列**——`registryFile` 这类「声明了但没人读」的字段只有把声明与使用并排比对才看得出来；只抄 schema 会把死配置当成能力写进文档。
- **2026-09-14 §5.23 修仪器：第三方档只认 `link:` 形态（0.1.2）**
  - 现场：主人装了 `dsh-x-opencode-session`（依赖声明 `github:Coco-king/…#commit` + `dsh.profile.bundles`），实测 `plugin_list --source third-party` **返回空**——`scanThirdParty` 第 354 行 `if (!spec.startsWith('link:')) continue` 把 git pin / tarball / registry 三种形态整条跳过；「非自研插件」的盘点因此不完整。
  - 修法：抽出**纯函数** `classifyDependency(name, spec)` 七档（自研 link / 本地 link / 官方 / 第三方四形态）+ `redactSpec` 脱敏；`scanThirdParty` 按形态解析落点（`link:` → 目标目录；其余 → `<profileDir>/node_modules/<name>`）；档案新增 `bundle`（自述式挂载 ⇒ mounted）与 `spec`（升级/回退指纹）。
  - 教训：**「第三方 = 本地 clone 链接进来」是 2026-08 的世界观**——包管理器形态一变（git pin/bundle），盘点器就静默失灵；**盘点器必须按「安装形态」枚举，而不是按某一种形态的特例写死**。与本次 `dsh-plugin-bootreport` 的同类缺口（只扫 self-plugins）同源，两处一并修（§5.23）。
- **2026-09-14 §5.23 第二拍：生命周期原语的「适用性」也要显式化（0.1.3）**
  - 现场：第三方已被盘点到（A11 已证），但 `plugin_mount <第三方>` 仍会走**自研路径**——写 `link:` 依赖（形态错误）+ 插 patch 行（bundle 形态本不需要），或落到「插件不存在 / 未挂载」这类不达意分支。
  - 修法：纯函数 `thirdPartyRefusal(action, name, spec, profile, bundle)` 生成拒绝文案（指名来源 pin、给出「改 profile 依赖 pin → install → 重启」与「官方 `dsh plugin add/remove`」两条指路、引 §5.23 依据），五个生命周期方法在 `findArchive` 之后**统一拦截**（与既有 `official` 拦截同位置同风格）。
  - 教训：**「工具能看见某资源」≠「工具的操作语义对它有定义」**——可见性（A11）与适用性（A12）是两件事，前者补完必须立刻问一句「那我的写操作对它意味着什么」。这条与 §5.9 的「能力断言先探测」是同一族：**先定义语义，再允许动手**。

## 10 · 未决问题

- **U1 死配置 `registryFile`**：删除字段（破坏兼容）还是接上（用它替代硬编码的 `data/*.json` 路径）？倾向：先标注、由后续重构决定，不在补课中改代码。
- **U2 `preflight_check` 的短路口径**：`probeExistingFirst` 只在 `profile==='web' && !hasUnverifiedBuilds()` 时为真——非 web profile 永远走完整试运行（更慢但更严）。是否需要为非 web profile 也提供短路？（倾向：保持现状，宁严勿漏）
- **U3 README 与实现漂移**：README 工具表 7 项 vs 实际 10 项、来源三类 vs README 两类——是否把 `preflight_check`/`daemon_restart` 补进 README？（补课纪律：本文只报不改，处置归主体）
- **U4 端到端验收缺口**：A4/A6/A8 需要「真改一个 profile 再回滚」的破坏性实验，代价是可能触发重启——是否值得为它造一个一次性 sandbox profile（如 `at-test`）来跑？（倾向：值得，用 `at-test` profile 隔离）
- **U5 并行实例写入**：本仓库正被另一实例重构（§8 声明）。补课文档与重构结果谁先合入、行号以哪版为准——需队长在收口时统一复读一次。
- **U6 第三方档的下一步（§5.23）**：① ~~`plugin_mount` 对第三方应当显式拒绝并指路~~ → **2026-09-14 已做**（0.1.3，五个生命周期方法统一拦截，A12）；② 第三方升级/回退要不要做成工具（换 pin + 重装 + 重启 = 现在只能手改 profile `package.json` 或用官方 CLI）；③ `plugin_unmount` 对 bundle 形态的语义（删 `dsh.profile.bundles` 条目？还是只从依赖移除？）——已在拒绝文案里指路官方 CLI，但**本工具是否应当代劳**仍是开放问题，需主人定调或至少一次实测。
- **U7 拒绝文案的「动作粒度」**：五个动作现在共用同一文案模板（仅动词不同）。`plugin_stop` 对 bundle 形态其实**有可能**通过「从 `dsh.profile.bundles` 摘除」实现——一律拒绝是否过严？（倾向：先一律拒绝，等 U6-③ 有定论再细分）

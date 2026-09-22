# 语义文档：dsh-agent-plugin-manager（插件管理器）

| 项 | 值 |
|----|----|
| 能力名 | dsh-agent-plugin-manager（插件内 `name = 'agent-plugin-manager'`；组合行 id `agent-plugin-manager`） |
| 主副本路径 | `self-plugins/dsh-agent-plugin-manager/docs/semantic.md` |
| 实现落点 | `self-plugins/dsh-agent-plugin-manager/src/index.ts`（工具面 + 预检门控 + 重启闸门）<br>`.../src/registry.ts`（档案库纯函数：扫描/对账/工具提取）<br>`.../src/profile.ts`（patch 行编辑 / link 依赖 / pnpm install / 预检 / 回滚）<br>`.../src/preflight-gate.ts`（门控纯逻辑：调用者提取 + 进程级裁决）<br>`.../src/sentinel.ts`（哨兵写入）<br>`.../src/drift.ts`（档案漂移检测纯逻辑，2026-09-17）<br>`.../src/redact-config.ts`（配置凭据脱敏纯逻辑，2026-09-17）<br>`.../src/client/index.ts` + `src/client/remote.ts` + `src/client/PluginManagerAction.tsx`（client 面） |
| 版本 | 0.1.5（`package.json`；本文成文于 0.1.3，2026-09-22 复核回写至 0.1.5） |
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
| 配置脱敏（redactConfig） | 档案出口投影时**按键名**把秘密值替换为 `[redacted]`（连长度与前缀都不留）；非密字段原样保留（2026-09-17 起，I7） |
| 漂移（drift） | 「档案自述」与「档案事实」不一致的五类：自述工具数 ≠ 清单长度 / 声称有工具却空清单 / 无用途描述 / 声明挂载但未构建 / 挂载零工具未声称（`detectDrift`，I8） |

## 3 · 概念模型

```
爱丽丝（模型）
  │ 11 个工具（plugin_* / plugin_audit / preflight_check / daemon_restart）
  ▼
src/index.ts:apply
  ├─ createOps(...)  ──→  src/registry.ts  扫描 self-plugins + profiles/*/cordis.patch.yml + 官方 bundles
  │                       └─ alignWithLoader(loader.entries())  ← loader 是挂载状态权威
  ├─ 生命周期操作（mount/unmount/setEnabled/configure/create）
  │     └─ src/profile.ts: patchInsert/patchRemove/patchSetDisabled/patchSetConfig
  │                        packageAddLinkDep/packageRemoveDep → spawn('pnpm install --package-import-method=copy')
  │                        preflight() → dsh-agent-preflight/core:runPreflightCore
  │                        失败 → rollbackFile(.bak-<ts>)（**回滚后再抛错，不重启**）
  ├─ 档案投影（plugin_list/plugin_inspect 出口）：ops-logic.ts:publicArchive → redact-config.ts:redactConfig(config)
  │     └─ 键名命中 token/secret/password/api key/webhook/chat id… ⇒ 值替换为 '[redacted]'（I7）
  ├─ plugin_audit 工具：drift.ts:detectDrift(档案) → 「自述 vs 档案事实」漂移清单（只读，I8）
  ├─ triggerReload(note, caller) → 绑定**触发者会话**（exec.agent 且为 session-* ⇒ 用它；否则回退活跃会话并留 trigger= 标记）
  │     └─ src/sentinel.ts:writeSentinel(<DSH_HOME>/.hot-reload-flag)
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
7. **I7 工具面不拉凭据**（2026-09-17 起）：`plugin_list`/`plugin_inspect` 出口的 `config` 一律经 `redactConfig`——键名命中秘密模式（`token|secret|password|api key|webhook|chat id|private key|mnemonic|auth…`）时值替换为 `[redacted]`，**连长度与前缀都不保留**；非密字段原样保留（配置仍可读）。判据是**键名结构**，不猜值形态。理由：工具输出 ⇒ 上下文 ⇒ 会话日志。
8. **I8 审计只读且边界显式**：`plugin_audit` 只比对**档案内**可验证的一致性（自述工具数 ≠ 清单长度 / 声称有工具却空清单 / 无用途描述 / 挂载未构建 / 挂载零工具未声称），默认只看自研（`sources=['self']`）；不改任何文件，且**看不见运行时真实工具面**（那要靠 `toolface status` 与实调）。

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

### 4.2 工具面（11 个，`src/index.ts`；行号为 2026-09-22 复核时刻，漂移时以工具名为准）
| 工具 | 注册行 | 作用 | 关键裁决 |
|------|-------|------|---------|
| `plugin_list` | L461 | 档案列表（按 `source`/`status` 过滤，分组渲染） | 状态经 loader 对齐（I3）；**第三方档覆盖四种安装形态**（见 §4.3「第三方盘点」行，2026-09-14 修）；`config` 经 `redactConfig`（I7） |
| `plugin_inspect` | L478 | 单插件深度档案 | 不存在 → `ok:false`（第三方档命中后不再误报「不存在」）；`config` 经 `redactConfig`（I7，2026-09-17 修） |
| `plugin_audit` | L489 | 档案漂移审计（只读）：自述工具数 ≠ 清单长度 / 声称有工具却空清单 / 无用途描述 / 挂载未构建 / 挂载零工具未声称 | 默认只看自研（官方 bundle 不背我的 `purpose` 约定 ⇒ 不参与）；**看不见运行时真实工具面**（2026-09-17 新增，I8） |
| `plugin_create` | L512 | 生成脚手架（`package.json`/`tsconfig.json`/`src/index.ts`/`README.md`） | 目录已存在 / 名字非法 → `ok:false` |
| `plugin_mount` | L525 | link 依赖 + install + patch insert + 预检 + 哨兵 | 已挂载 / 官方 bundle / profile 不存在 → 拒绝；**第三方 → 显式拒绝并指路**（`thirdPartyRefusal`，§5.23） |
| `plugin_unmount` | L539 | patch 移除 + 依赖移除 + install + 预检 + 哨兵 | 未挂载 → 拒绝；数据目录保留（I5）；**第三方 → 显式拒绝**（第三方卸载走 `dsh plugin remove`） |
| `plugin_start` / `plugin_stop` | 循环注册 L551–553（`name` 由 `toolName` 计算） | `disabled` 切换 + 预检 + 哨兵 | 已是目标状态 → 拒绝；**第三方 → 显式拒绝**（bundle 形态无 patch 行可控） |
| `plugin_configure` | L567 | patch `config` **整体替换** + 预检 + 哨兵 | 未挂载 → 拒绝；**第三方 → 显式拒绝**（其配置由 profile 依赖与包自身约定决定） |
| `preflight_check` | L581 | 试运行预检 + 落盘调用记录 | `profile==='web'` 且无未验证构建 → 短路（`probeExistingFirst=true`） |
| `daemon_restart` | L613 | 闸门校验通过 → 写哨兵请求重启 | 未调用过预检 / 预检未过 → **拒绝**（I4）；哨兵 `sessionId` 绑定**触发者会话**（2026-09-17 修，§5.18） |

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号 / 行号） | 时机 |
|-------|--------------------------|------|
| web profile 组合 | `.dsh/profiles/web/cordis.patch.yml:78-85`（`id: agent-plugin-manager` + 5 项 config） | web 启动挂载 |
| 插件本体 | `src/index.ts:405 apply()` → `createOps()`(L135) → `ctx.plugin(PluginManagerRemoteService, ops)`(L411) | 挂载时 |
| 插件本体 | `src/index.ts:461/478/489/512/525/539/551/567/581/613` 共 **11** 个 `ctx.tools.register(defineTool({...}))`（9 个字面 `name:` + 1 行循环覆盖 `plugin_start`/`plugin_stop`） | 挂载时注册 |
| 档案投影（凭据闸门） | `src/ops-logic.ts:publicArchive`(L93，`config: redactConfig(a.config)` L99) → `src/redact-config.ts:redactConfig`(L22) / `redactedPaths`(L35)；`plugin_list` 与 `plugin_inspect` 共用一个出口 | 每次查询 |
| 漂移审计 | `src/drift.ts:detectDrift`(L54) / `declaredToolCount`(L28) / `formatDrift`(L85) ← `plugin_audit` 工具；默认 `sources=['self']` | 每次调用 |
| 档案库 | `src/index.ts:list()/inspect()` → `src/registry.ts:buildRegistry`(L450) ← `scanSelfPlugins`(L213) + `listProfiles`(L256) + `scanOfficialBundles`(L276) + `scanThirdParty`(L347) + `loadOfficialCatalog`(L415) + `loadSystemState`(L431) + `alignWithLoader`(L516) | 每次查询 |
| 工具提取 | `src/registry.ts:extractTools`(L173)（扫 `src/`+`lib/` 的 `.ts/.js/.mjs`，跳过注释行）——**四种注册形态**：字面量 / `defineTool(标识符)` / 递归扫 / **数据驱动注册**（L196，2026-09-17 修：`ctx.tools.register(defineTool({...tool}))` 时 `name:` 落在 500 字窗口外，blue-team/sec-tools 曾因此报 0 个） | 查询时 |
| patch 行编辑 | `src/profile.ts:patchInsert`(L31) / `patchRemove`(L50) / `patchSetDisabled`(L94) / `patchSetConfig`(L133) | 挂载/启停/配置/卸载 |
| 依赖编辑 | `src/profile.ts:packageAddLinkDep`(L188) / `packageRemoveDep`(L204) / `installProfile`(L220，`spawn('pnpm', ...)`，`shell:true`) | 挂载/卸载 |
| 预检 | `src/profile.ts:preflight`(L242) → `runPreflightCore`(L255)（`preflightReadyMs` 默认 90000，`probeExistingFirst` 默认 false） | 每个组合变更操作；`preflight_check` 工具 |
| 回滚 | `src/profile.ts:rollbackFile`(L296) | 预检失败 / install 失败 |
| 哨兵 | `src/index.ts:triggerReload`(L171)：**调用者会话优先**（`caller.sessionId` 且形如 `session-*` ⇒ 用它，note 追加 `trigger=caller`）→ `src/sentinel.ts:writeSentinel`(L15) → `<DSH_HOME>/.hot-reload-flag`；`clearSentinel`(L26)（清空为 `''`，本插件不调用） | 每次成功操作与 `daemon_restart` |
| 会话解析（**仅回退路径**） | `src/index.ts:resolveActiveSessionId`(L130)（主体 = `delegationDepth===0`，取最后事件时间最大者）——2026-09-17 起只在「拿不到调用者会话 / 调用者是派生会话」时使用，且来源写进 note（`trigger=fallback-active…`） | 写哨兵前（回退时） |
| 重启闸门 | `src/index.ts:preflightInvokedInProcess`(L451) ← 记录点 `recordPreflightInvoked`(L421) → `src/preflight-gate.ts:decidePreflightGate`(L79)；调用者提取 `extractCaller`(L48) | `daemon_restart` |
| 未验证构建检测 | `src/index.ts:hasUnverifiedBuilds`(L81)（本进程启动时刻 = `Date.now() - process.uptime()*1000`；扫 `dshHome/../self-plugins` 等三候选） | `preflight_check` 决定是否短路 |
| client 面 | `src/client/index.ts:16 apply()` → `ctx.remote.$mount(TYPERT_REMOTE)`（15s 超时 ×8 次重试）→ `ctx.plugin({name:'plugin-manager-ui'})`（**槽位注册已于 2026-09-13 撤除**，L41–44 注释保留恢复点） | 每个 web 会话 |
| client remote 契约 | `src/client/remote.ts:39 TYPERT_REMOTE`（`service: 'pluginManagerRemote'`，`namespace: 'pluginManager'`，方法 `list/inspect/start/stop/unmount/create`）；host 侧 `src/index.ts:321 PluginManagerRemoteService`（`@Remote` 于 L327/331/336/340/345/349） | 面板/客户端调用 |
| 落盘产物 | `<DSH_HOME>/.hot-reload-flag`（哨兵）<br>`<DSH_HOME>/.plugin-manager-events.log`（事件行 `[ISO] msg`，L144）<br>`<DSH_HOME>/.preflight-invoked.json`（`at/atMs/workspace/sessionId/pass/mode/caller`，L369/371）<br>`<DSH_HOME>/preflight-fail-report.json`（`src/profile.ts:279`，仅预检 FAIL 时）<br>`<profileDir>/cordis.patch.yml.bak-<ts>`、`<profileDir>/package.json.bak-<ts>` | 操作时 |
| 只读数据源 | `self-plugins/*/package.json`、`data/official-plugins.json`、`data/system-state.json`、各 profile 的 `cordis.patch.yml` + `package.json` + `node_modules/<bundle>/package.json` | 查询时 |
| **第三方盘点** | `registry.ts:classifyDependency(name, spec)`（纯函数：`self-link`/`local-link`/`official`/`third-party-{git,tarball,registry,local}`）+ `scanThirdParty(profilesDir, selfPluginsDir)`：**四种安装形态全覆盖**——`link:`（落点 = link 目标）与 git pin / tarball / registry / `file:`（落点 = `<profileDir>/node_modules/<name>`）；`bundle` = 列在该 profile 的 `dsh.profile.bundles`（自述式挂载 ⇒ mounted）；`spec` 经 `redactSpec` 脱敏后进档案（升级/回退的唯一指纹） | `plugin_list`/`plugin_inspect`（§5.23） |
| 消费方 | 爱丽丝（`plugin_list`/`plugin_inspect` 认知插件面；`plugin_mount` 等实施部署）；`daemon_restart` 被「重启前必须先预检」纪律消费；watch（哨兵文件）；面板宿主 `dsh-panel` 的 `plugin-manager` 面板（经 remote） | 运行时 |
| 测试 | `test/registry.test.mjs`（12 条：parsePatchRows/extractTools/isBuilt/patch* 行编辑/依赖增删/`buildRegistry` 对账）<br>`test/preflight-gate.test.mjs`（门控裁决与调用者提取）<br>`tests/event-log.test.mjs`、`tests/ops-logic.test.mjs`<br>`tests/registry-deps.test.mjs`（**2026-09-14 新增**：第三方四形态判定 + 脱敏 + `scanThirdParty` 夹具〔git-pin 带 bundle ⇒ mounted；registry 未安装 ⇒ unmounted/版本留空〕+ 路径不存在不抛）<br>`tests/third-party-refusal.test.mjs`（**2026-09-14**：第三方生命周期拒绝文案 4 条）<br>`tests/drift.test.mjs`（**2026-09-17 新增**：漂移五类 + 两条尸体测试〔干净档案不报警 / 抠不到数字不猜〕）<br>`tests/redact-config.test.mjs`（**2026-09-17 新增**：7 条，含两条尸体测试〔输出不得含原值形态 / 普通键名不得误伤〕）<br>（`test/debug.mjs`、`test/only-registry.mjs` 为手工调试脚本，非 `node --test` 命名）<br>跑法：`npm test` = `node --test "tests/*.test.mjs" "test/*.test.mjs"`；**2026-09-22 复核实测 78/78 绿** | 离线 |

## 5 · 边界与信任

- 能力边界 ≠ 沙箱：本插件**能改 profile 组合、能 spawn `pnpm install`、能写哨兵触发 web 重启**——它不校验调用者意图，也不阻止误操作。保护来自 ① 备份 + 回滚 ② 预检门控 ③ 上层（爱丽丝/主人的裁决包）。
- 不越界清单：不 kill/spawn web 进程（那是 watch/guardian）；不实现预检本体（调 `dsh-agent-preflight`）；不删插件数据目录；不改插件源码（`plugin_create` 只生成新目录）；不 commit/push。
- **凭据面（2026-09-17 起，I7）**：本插件的只读出口**不得把凭据拉进会话**——`plugin_list`/`plugin_inspect` 的 `config` 一律经 `redactConfig`。事故形态：`plugin_inspect(dsh-agent-guardian)` 曾把主人的 telegram bot token 与 chat id 当场渲进工具输出 ⇒ 进上下文 ⇒ 进会话日志。**遗留（不属本插件职责）**：凭据本身仍以明文存在 profile 的插件配置里（§5.25 规则 2 要求单一来源），是否迁移由主人裁决。
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
| A1 | 工具面恰为 **11** 个（含 `plugin_audit`/`preflight_check`/`daemon_restart`） | `grep -n "^\s*name: '" src/index.ts` → 9 个字面 `name:`（plugin_list/inspect/audit/create/mount/unmount/configure/preflight_check/daemon_restart）+ 1 行循环（L551 `for` 覆盖 plugin_start/plugin_stop）= **11** | 已实测（2026-09-22 复核实测：修前口径 10 个已过时，plugin_audit 于 2026-09-17 加入） |
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
| A12 | **第三方不得走自研生命周期**：`plugin_mount`/`unmount`/`start`/`stop`/`configure` 对第三方一律拒绝，且文案指名来源与两条指路（改 pin / `dsh plugin`） | `node --test tests/third-party-refusal.test.mjs`（4 条：文案含名/pin/profile/两条命令/§5.23 依据；bundle=false 不编造形态；五个动作动词各异） | **已证（2026-09-14 16:42:34 重启后线上实测）**：对 `dsh-x-opencode-session` 调 `plugin_mount` → 返回拒绝文案（含 pin `#2e7ce82…`、bundle 说明、两条指路）；**零副作用已核**：`package.json` sha256 `6AF91603ED0EA991`、`cordis.patch.yml` sha256 `34EFC6E767F70FE4` 前后逐字相同、mtime 未变、哨兵未写 |
| A13 | **工具面不拉凭据**：`plugin_inspect` 输出的 `config` 中，键名命中秘密模式者值恒为 `[redacted]`，非密键名原样保留 | `node --test tests/redact-config.test.mjs`（7 条；含尸体测试：输出不得含原值任何形态、普通键名不得误伤） | 已实测（2026-09-22 复核实测：全套 78/78 绿；事故形态为 `plugin_inspect(dsh-agent-guardian)` 曾把 telegram bot token 渲进工具输出） |
| A14 | **漂移审计只读且默认只看自研**：自述工具数 ≠ 档案清单长度 / 声称有工具却空清单 / 无用途描述 / 挂载未构建 / 挂载零工具未声称 ⇒ 报；干净档案不报 | `node --test tests/drift.test.mjs`（10 条；含两条尸体测试：一致不报警、抠不到数字不猜） | 已实测（2026-09-22 复核实测：全套 78/78 绿） |

## 8 · 与实现的关系

- 主实现：`src/index.ts`（工具面 / 门控 / 生命周期编排）+ `src/registry.ts`（纯函数档案库）+ `src/profile.ts`（文件级操作与回滚）+ `src/preflight-gate.ts`（纯逻辑门控）+ `src/sentinel.ts`（28 行薄壳）。
- 同语义副本：无。预检本体语义属 `dsh-agent-preflight`（其 `docs/semantic.md` 为主副本）；哨兵协议消费方语义属 watch 侧（`dsh-agent-sentinel` 文档）。
- **并行写入声明（2026-09-14 实测 → 2026-09-22 结案）**：补课期间另一实例正在重构 `src/index.ts`（当时 `git status` 显示 `M src/index.ts` + 未跟踪 `src/event-log.ts`/`src/ops-logic.ts`）；该重构已合入。**2026-09-22 复核时全文行号已按当前磁盘状态重基**（`src/index.ts` 669 行）。行号仍会随后续改动漂移——**以符号名（`plugin_list`/`decidePreflightGate`/`hasUnverifiedBuilds`/`redactConfig`/`detectDrift`）为准**。
- 未实现/未验证部分（显式标注，2026-09-22 复核更新）：
  - `registryFile` 为**死配置**（声明 + 默认值，全仓库无读取点；2026-09-22 复核 `grep -rn "registryFile" src/` 仅命中 `src/index.ts:56/66`）。
  - README 的工具表列 **10** 个（未含 2026-09-17 新增的 `plugin_audit`）——实现为 **11** 个（计数漂移仍在，见 U3）；README 的**来源表述已修**（现为 `self`/`official`/`third-party` 三类，2026-09-14 后同步）。
  - `test/preflight-gate.test.mjs` 覆盖纯逻辑层；**端到端**（真改 profile → 真预检 → 真回滚）无自动化测试，A4/A6/A8 需线上取证（A1/A9/A13/A14 已实测）。

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
- **2026-09-22 复核回写（语义 drift D3 复核：doc 停在 0.1.3，实现已到 0.1.5）**
  - **判据（先取证再落笔，不是 touch 消警）**：本条目 impl 最后写入 2026-09-17 18:03（`6292747`），doc 最后提交 2026-09-14 16:43（`0c5f66d`）⇒ doc **早于 impl 三日**。`git log --since='2026-09-14 16:43' -- src/index.ts src/ops-logic.ts src/event-log.ts tests/ops-logic.test.mjs` 得三条**语义性**提交：`36cd4ff`（触发者绑定 + `extractTools` 形态 4）、`c05e3a4`（新增 `plugin_audit` + `src/drift.ts`）、`6292747`（配置凭据脱敏 + `src/redact-config.ts`，v0.1.5）；另有 `a67a8d2` 只改 `package.json` 版本号。
  - 语义**被修正**：① 工具面 **10 → 11**（补 `plugin_audit` 的契约行 / 概念模型 / 调用点，A1 计数与证据同步）② 版本 **0.1.3 → 0.1.5** ③ §8 的旧断言「README 只列 7 个、来源只有 self/official」→ 现为 README 列 **10** 个（仍缺 `plugin_audit`）且来源表述**已修**为三类。
  - 语义**被补充**：① **I7 工具面不拉凭据**（`publicArchive → redactConfig`；2026-09-17 事故：`plugin_inspect(dsh-agent-guardian)` 把主人 telegram bot token 与 chat id 当场渲进工具输出）② **I8 审计只读 + 边界显式**（`plugin_audit` 默认只看自研，**看不见运行时真实工具面**）③ 哨兵 `sessionId` **绑定触发者会话**（§5.18），`resolveActiveSessionId` 降级为**回退路径**且来源写进 note（`trigger=`）④ `extractTools` **第四注册形态**（数据驱动注册；blue-team/sec-tools 工具数由 0 → 8/11）⑤ 新增两条验收 A13/A14（2026-09-22 复跑 `node --test tests/*.test.mjs test/*.test.mjs` = **78/78 绿**）。
  - 教训：**「提交时间在后」既不保证内容被吸收，也不保证文档没过时**；且**同一条 impl 清单里各文件 mtime 各异**（`src/event-log.ts` 与 `tests/ops-logic.test.mjs` 仍停在 09-14），D3 只取清单里最新的那个 ⇒ 复核判据应是「doc 最后提交 vs **逐文件** impl 最后提交 + 提交内容是否触及本条语义」，**不能只看一次 mtime 差就下结论**。

- **2026-09-22 新增能力：重启门控（在飞分身）· 0.1.6**
  - **起因（主人）**：「重启的时候会打断分身，想办法解决一下」。实测：`subagent` 子代理与 web **同进程**，一 `daemon_restart` 即斩断；而它**不可寻址**（`send_message` → 不是 teammate）、**不是 job**（`job_list` 空）、**无 settle 通知** ⇒ 重启 = 整轮工作蒸发（当日三次同型：分身最后产出 14:57:27，我 14:57:32 重启）。
  - **契约**：`daemon_restart` 在写哨兵**之前**检查在飞分身；命中 ⇒ 拒绝并列出 id/静默时长；`force: true` 可覆盖。配置 `inflightWindowMs`（默认 600000；设 0 关闭，但日志会写明「按配置关闭」，**不静默**）。判据本体两条：`findInFlightSubagents`（内存会话表）与 `findInFlightSessionDirs`（**会话目录真源**），任一命中即拒。
  - **中途纠错（假防线级，必须记）**：v1 只用 `ctx.sessions.list()`，真机第一次调用即露馅——日志原文「候选会话 2 · 命中 0（放行）」，而当时**确有一个分身正在跑**。⇒ 内存会话表**不含在飞的子代理**，这道防线**永远放行**。改用文件系统真源 `<DSH_HOME>/sessions/<工作区组>/<会话id>/`，以目录 mtime（最后写入 ≈ 还在跑）判在飞，并用本仓既有 id 约定区分（子代理 = **裸 uuid**；用户会话 = `session-` 前缀，见 `pickActiveSessionId` 测例）⇒ 精确、不误伤并行实例，且**无状态**（跑完自然滑出窗口，无需清理逻辑）。
  - **已知局限（未解，见 U9）**：时间窗判据区分不了「在跑」与「刚死不到一个窗口」——实测把已被上次重启斩掉的会话（366s 前）也列为在飞。代价：重启后一个窗口内无法再重启（除非 `force`）；可读作「防重启循环的护栏」，但必须明说。
  - 教训：**「有防线」≠「防线在拦」**——判据必须能被**已知坏样本**证明（§5.9·2）。本次是靠「故意在有分身时调一次」当场抓到假防线；若只跑单测（纯函数全绿），我会一路以为自己防住了。

## 10 · 未决问题

- **U1 死配置 `registryFile`**：删除字段（破坏兼容）还是接上（用它替代硬编码的 `data/*.json` 路径）？倾向：先标注、由后续重构决定，不在补课中改代码。
- **U2 `preflight_check` 的短路口径**：`probeExistingFirst` 只在 `profile==='web' && !hasUnverifiedBuilds()` 时为真——非 web profile 永远走完整试运行（更慢但更严）。是否需要为非 web profile 也提供短路？（倾向：保持现状，宁严勿漏）
- **U3 README 与实现漂移**：README 工具表 **10** 项 vs 实际 **11** 项（缺 2026-09-17 新增的 `plugin_audit`）——是否把 `plugin_audit` 补进 README 工具表与 front-matter `tools:` 行？（补课纪律：本文只报不改，处置归主体；来源三类表述已于 2026-09-14 后对齐，此项可结）
- **U4 端到端验收缺口**：A4/A6/A8 需要「真改一个 profile 再回滚」的破坏性实验，代价是可能触发重启——是否值得为它造一个一次性 sandbox profile（如 `at-test`）来跑？（倾向：值得，用 `at-test` profile 隔离）
- **U5** ~~并行实例写入~~ → **已结案（2026-09-22）**：另一实例的重构已合入，本文行号已按当前磁盘状态重基（§8 声明已更新为结案态）。
- **U8（2026-09-22 新增）** `plugin_audit` 的「service-only 插件」判读**依赖人工**：2026-09-17 收窄后自研档 5 条发现全落在 `dsh-agent-guardian/preflight/runtime/sentinel/panel`（确实只提供 service/client UI）。发现文案已写明「若不是则是采集漏」，但**没有机制区分这两种形态**——是否给这类插件一个显式声明位（如 `package.json` 里标 `serviceOnly: true`），让判据可自证而非靠人认？
- **U6 第三方档的下一步（§5.23）**：① ~~`plugin_mount` 对第三方应当显式拒绝并指路~~ → **2026-09-14 已做**（0.1.3，五个生命周期方法统一拦截，A12）；② 第三方升级/回退要不要做成工具（换 pin + 重装 + 重启 = 现在只能手改 profile `package.json` 或用官方 CLI）；③ `plugin_unmount` 对 bundle 形态的语义（删 `dsh.profile.bundles` 条目？还是只从依赖移除？）——已在拒绝文案里指路官方 CLI，但**本工具是否应当代劳**仍是开放问题，需主人定调或至少一次实测。
- **U7 拒绝文案的「动作粒度」**：五个动作现在共用同一文案模板（仅动词不同）。`plugin_stop` 对 bundle 形态其实**有可能**通过「从 `dsh.profile.bundles` 摘除」实现——一律拒绝是否过严？（倾向：先一律拒绝，等 U6-③ 有定论再细分）
- **U9（2026-09-22 新增）「在飞分身」门控的时间窗局限**：判据是「会话目录 mtime 在窗口内」，**区分不了「在跑」与「刚死不到一个窗口」**——实测把已被上一次重启斩掉的会话（366s 前）也列为在飞。代价：重启后一个窗口（默认 10 分钟）内无法再重启（除非 `force: true`）；这可读作「防重启循环的护栏」，但**必须对使用者明说**。改进候选：① 用**工具管道**（订阅 `tools/result`，在 `subagent`/`subagent_fork` 调用上维护显式在飞注册表，结束时清除）——精度最高，但「子代理结束」是否有可靠信号**尚未取证**（如果没有，这正是它的失败面）；② 结合宿主可能存在的「子代理注册表」服务（`ctx.agents` 未取证）；③ 缩短窗口到 2–3 分钟（实现最简单，但会漏掉「长思考不写盘」的分身）。倾向：先按现状跑，等出现**真实误锁**样本再选（不为想象的需求加机制）。

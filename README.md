<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 插件管理器：插件档案库（来源/版本/用途/工具/挂载状态/配置摘要）+ 生命周期管理（创建/挂载/启停/卸载/改配置）+ 重启闸门（preflight_check / daemon_restart）。
  inject: 'tools','loader','sessions'（host）；client 侧 inject = 'slots','remote'
  tools: plugin_list,plugin_inspect,plugin_create,plugin_mount,plugin_unmount,plugin_start,plugin_stop,plugin_configure,preflight_check,daemon_restart（共 10 个）
  runtime: host + client（GUI 槽位已于 2026-09-13 撤除，界面迁至 dsh-panel 宿主的 plugin-manager 面板；本插件保留 $mount 与 typert remote）
  envDeps: pnpm CLI（挂载/卸载时 spawn install）、@deepseek-ai/dsh/lib/bin.js（试运行入口）、js-yaml、link 依赖 dsh-agent-preflight（预检本体）
  boundary: 能力边界 ≠ 沙箱——有权限的调用方仍能改任意 profile 文件；本插件只保证「改前必备份、失败即回滚、预检不过不重启」；不 kill/spawn web 进程（那属 watch 侧）
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6 / dsh-typert-protocol ^0.1.0-rc.6 / dsh-client-runtime,client-ui-settings,client-ui-slots,client-locale ^0.1.0-rc.6 / react ^18.2.0
-->
# dsh-agent-plugin-manager

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-plugin-manager"><img src="https://img.shields.io/badge/version-0.1.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-49%20passed-brightgreen" alt="tests">
</p>

**一句话**：DSH 的**插件档案库 + 生命周期操作面**——把「有哪些插件、什么来源、挂到哪个 profile、装了什么工具、配置是什么」变成一条命令可查，把「创建 / 挂载 / 启停 / 卸载 / 改配置」做成**带备份与回滚的闭环**，并附带一道会**拒绝执行**的重启闸门。

**为什么值得用**：不用它，改一次插件组合是「手编 `cordis.patch.yml` → 手动 `pnpm install` → 试运行看会不会崩 → 崩了自己翻 `.bak`」；用了它，同一件事是一条 `plugin_mount`——**每一步都有备份，预检失败自动回滚全部已改文件且不写哨兵**（组合回不到坏状态，进程不会带着坏组合重启）。另一半价值在「认知」：50 个自研插件 + 官方 bundles + 第三方，来源/版本/工具面/挂载状态（以运行时 loader 为权威，不吃陈旧快照）一条 `plugin_list` 全出来，而不是翻目录猜。第三件是 `daemon_restart` 的**进程级闸门**：本进程没调过 `preflight_check` 或最近一次预检没过，重启**直接被拒**——把「先预检再重启」从纪律变成机制。

## 能力

**工具面 10 个**（名称逐字来自 `src/index.ts` 的 `defineTool({ name })`）：

| 工具 | 用途 |
|------|------|
| `plugin_list` | 列出全部插件档案（来源/版本/用途/工具/挂载状态/配置摘要）——按「自研 / 官方 / 非官方」分组；可按 `source`（`self`/`official`/`third-party`）/ `status`（`mounted`/`disabled`/`unmounted`）过滤 |
| `plugin_inspect` | 单个插件的深度档案（用途/工具/配置/挂载详情） |
| `plugin_create` | 创建新插件脚手架：在 self-plugins 生成 `package.json`/`tsconfig.json`/`src/index.ts`/`README.md`，随后可 `plugin_mount` 挂载 |
| `plugin_mount` | 挂载到 profile：写 link 依赖 + `pnpm install` + patch insert + 沙盒预检 + 哨兵重启（全自动闭环） |
| `plugin_unmount` | 卸载：patch 移除 + 依赖移除 + 预检 + 哨兵重启；**保留插件数据目录** |
| `plugin_start` / `plugin_stop` | 启停插件（patch `disabled` 切换 + 预检 + 哨兵重启） |
| `plugin_configure` | 更新插件配置（patch `config` **整体替换**）+ 预检 + 哨兵重启 |
| `preflight_check` | 执行组合试运行预检并落盘「本 web 进程内已调用过」记录；`mode=full`（完整试运行，约 20s）/ `quick`（约 8s） |
| `daemon_restart` | 重启 web 守护服务（预检 → kill+重启 → 唤醒 → 清哨兵）；`reason` 必填留痕；**前置门控见下** |

行为侧（无工具）：档案库每次查询**实时**扫描 `self-plugins/*`、各 profile 的 `cordis.patch.yml`、官方 bundles 目录，再用 `ctx.loader.entries()` 对齐挂载状态。

**client 面（现状须知）**：`src/client/` 仍做 `$mount`（15s 超时 ×8 次重试）与 typert remote（namespace `pluginManager`，方法 `list/inspect/start/stop/unmount/create`），但**会话头按钮已于 2026-09-13 撤除**（主人定调：GUI 只留一个入口）——插件管理界面现在是面板宿主 `dsh-panel` 里的一页（`panels/plugin-manager.ts`，id `plugin-manager`）。要恢复旧入口，在 `src/client/index.ts` 的 `apply` 里重新 register 槽位即可（恢复点注释保留）。

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-agent-plugin-manager": "link:<工作区>/self-plugins/dsh-agent-plugin-manager"
```

> 本插件自身还有一个 link 依赖：`dsh-agent-preflight`（预检本体）。缺它时 `preflight()` 无法调用 ⇒ 生命周期操作会走「预检失败」分支 —— 先把它装好。

**2) 挂组合**（profile 的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: agent-plugin-manager
      name: dsh-agent-plugin-manager
      config:
        dshHome: ${DSH_HOME}
        selfPluginsDir: <工作区>/self-plugins
        profilesDir: ${DSH_HOME}/profiles
        bin: <工作区>/deepseek-harness/apps/cli/lib/bin.js
        defaultWorkspace: <工作区>
```

（四项路径均可留空回退：`selfPluginsDir`/`profilesDir` 回退到 `${DSH_HOME}/` 下同名目录，`bin` 回退 `require.resolve('@deepseek-ai/dsh/lib/bin.js')`，`defaultWorkspace` 回退 `process.cwd()`。**显式配置更清晰**——回退值依赖进程 cwd，非 web profile 下未必是你想要的。）

**3) 30 秒验证**：调 `plugin_list` → 期望返回三条来源分组（自研/官方/非官方）且 `count` 与列表长度一致；再 `plugin_inspect dsh-agent-plugin-manager` → 期望 `ok: true`、`status` 与运行时 loader 一致、`version` 为 `0.1.1`。

> 只读面永不抛：单个坏插件（缺 `package.json`、目录不可读）会被逐目录 `try/catch` 跳过，不影响整体返回。

## 配置

`Config` schema（`src/index.ts`，默认值逐字取自源码）：

| 项 | 默认 | 说明 |
|----|------|------|
| `dshHome` | `process.env.DSH_HOME ?? ''` | DSH 主目录——哨兵、事件日志、预检记录、失败报告的落点 |
| `selfPluginsDir` | `''` → `${dshHome}/self-plugins` | 自研插件根（档案库扫描源） |
| `profilesDir` | `''` → `${dshHome}/profiles` | profile 根（`cordis.patch.yml` + `package.json` 落点） |
| `bin` | `''` → `require.resolve('@deepseek-ai/dsh/lib/bin.js')` | 试运行预检入口 |
| `mainSessionId` | `''` | 哨兵里的唤醒目标；**留空 = 追踪最新活跃主体会话**（`delegationDepth === 0` 且最后事件时间最大者）——推荐留空 |
| `defaultWorkspace` | `''` → `process.cwd()` | 工作区（写入哨兵 + 闸门 workspace 比对） |
| `registryFile` | `''` | **死配置**：声明与默认值存在，全仓库无读取点（见「未支持项」） |
| `installTimeoutMs` | `600000` | `pnpm install` 超时（超时 → kill + 标 `[timeout]` + 回滚） |

## 落盘与自证（出问题时先看这里）

本插件有**四处落盘产物**，全部在 `${DSH_HOME}/` 下（或 profile 目录内）：

| 产物 | 写入时机 | 内容 |
|------|---------|------|
| `.plugin-manager-events.log` | 每次生命周期操作、每次重启 | 一行一事件：`[ISO 时刻] 消息`。并**行实例协调**的判据来源（动共享资产前先看它，AGENTS §5.14） |
| `.preflight-invoked.json` | 每次 `preflight_check` | `{ at, atMs, workspace, sessionId, pass, mode, caller{ sessionId, isMain, hasAgent, cwd } }`——`caller` 是**真实调用者**（来自 `exec.agent`），`sessionId` 是历史遗留字段（= 活跃会话，**不是**调用者，排查看 `caller`） |
| `.hot-reload-flag` | 每次操作成功 / `daemon_restart` | 哨兵：JSON `{ workspace, sessionId, note }`——写入即请求 watch 执行「预检 → kill+重启 → 唤醒 → 清哨兵」。**本插件只写哨兵，不自己 kill/拉起进程** |
| `preflight-fail-report.json` | **仅预检 FAIL 时** | 预检失败明细报告（`src/profile.ts`） |

另有两类**回滚副本**（`profile.ts`，每次写前必留）：`<profileDir>/cordis.patch.yml.bak-<ISO 时间戳>`、`<profileDir>/package.json.bak-<ISO 时间戳>`。

**事件日志的阶段枚举**（`grep` 可分辨「走到哪一拍」）：

| 事件行形态 | 含义 |
|-----------|------|
| `哨兵已写: <file> \| <note>` | 该次操作走到最后一拍（预检已过、哨兵已落） |
| `<挂载\|启动\|停用\|卸载\|配置更新> … 完成` | 主流程成功收尾 |
| `预检失败已回滚: <name>` / `启停预检失败已回滚` / `卸载预检失败已回滚` | **断在预检段**，文件已还原、未写哨兵 |
| `daemon_restart 门控证据：… 结论=放行/拒绝(原因) · 调用者比对：…` | 重启闸门的裁决证据行（谁按的按钮、为什么放行/拒绝） |
| `创建插件 <name> @ <dir>` | 脚手架生成 |

**一条命令答五问**：

```bash
tail -3 "${DSH_HOME}/.plugin-manager-events.log"      # ③④ 主证据（阶段 + 结果）
cat    "${DSH_HOME}/.preflight-invoked.json"          # ② 真实调用者  ③ 预检 pass/mode
ls -l  "${DSH_HOME}/.hot-reload-flag"                 # 是否已请求重启（在 = 已请求）
stat -c '%y' self-plugins/dsh-agent-plugin-manager/lib/index.js   # ① 本插件构建时刻
# ① 跑的是哪个构建 → 轨迹**无 build 字段**（缺口）；只能 lib/index.js 的 mtime vs web 进程启动时刻 对照
# ② 谁发起 / 调了什么 → `.preflight-invoked.json` 的 caller{cwd,isMain,hasAgent} + 事件行的操作名与插件名
# ③ 断在哪一段     → 事件行阶段枚举：有「哨兵已写」= 走完；只有「…已回滚」= 断在预检；什么都没有 = 断在更早（入参/插件不存在/profile 不存在）
# ④ 结果质量       → 该次操作的收尾行（`完成` / `已回滚` / `门控证据 … 结论=`）+ 预检的 `pass`
# ⑤ 耗时与预算     → **未落盘**（缺口）：事件行只有 ISO 时刻，无 durationMs；`installTimeoutMs=600000` 是配置预算、不是实测值
```

**行为级验证**（无需读文件）：`plugin_list` 能返回分组列表 ⇒ 档案库活着；`preflight_check {mode:'quick'}` 后 `.preflight-invoked.json` 的 `atMs` **前进** ⇒ 「我的调用真的落了盘」（改动前后各读一次，前进为准）。

隐私与容错：事件日志与证据行走 `appendLineSafe`（**吞错返回 bool，绝不抛**）——写盘失败不阻断挂载/启停/重启这类主流程。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：

1. **行为级（最直接）**：本会话工具列表里 10 个工具齐（含 `preflight_check`/`daemon_restart`）；`plugin_inspect dsh-agent-plugin-manager` 返回 `status: mounted`、`version: 0.1.1`。
2. **证据级**：调 `preflight_check {mode:'quick'}` 前后各 `cat` 一次 `${DSH_HOME}/.preflight-invoked.json`，`atMs` **前进** ⇒ 当前进程在跑本插件（不是「文件里有过记录」）。
3. **进程级**：`self-plugins/dsh-agent-plugin-manager/lib/index.js` 的 mtime **≤** web 进程启动时刻，且 `src/` 不新于 `lib/`（源码改了没构建 = 跑的还是旧产物）。

> ⚠ **重新构建 ≠ 生效**：产物 mtime 新只证明「构建过」，**进程启动时间晚于产物 mtime 才算「在跑它」**（AGENTS §5.11 §6）。本插件自己就用这个口径：`hasUnverifiedBuilds()` 发现任一 `self-plugins/*/lib/index.js` 比本进程启动晚 → 强制**完整试运行**（约数十秒）；毫秒级返回 = 短路（走了「现有实例健康」），数十秒 = 真试运行。
>
> 另注意：`npm test` 脚本**不含构建步骤**，改完源码务必先 `npm run build`——`tests/*.test.mjs` 是从 `../lib/*.js` 导入的。
>
> 日志旁证（`dsh-agent-plugin-manager 就绪`、闸门证据行的 logger 副本）走宿主 logger，**不落盘**；持久证据只有上面那张表里的文件。

**回退**（三档）：

- **源码级**：`git -C self-plugins/dsh-agent-plugin-manager revert <commit>`（或 `git checkout -- src/` 丢弃未提交改动）→ `npm run build` → `preflight_check` → 重启；
- **组合级**：profile patch 给 `agent-plugin-manager` 行加 `disabled: true`（或删除该行）→ 该行工具全部消失、档案库不再可查（**注意**：`preflight_check`/`daemon_restart` 也随之消失，重启闸门失效——此时只剩纪律兜底）；
- **运行期**：单次操作**失败即已自动回滚**（patch + `package.json` 都还原自 `.bak-<ts>`，且**不写哨兵**），手工回退用最新的 `cordis.patch.yml.bak-*` + `package.json.bak-*` 覆盖回去。本插件自身**无持久业务状态**，事件日志/预检记录可随时删除，删掉不影响功能。

回退后用同一套判据复验（工具面数量 / `atMs` 是否仍前进 / `versions` 是否退回）。

## 测试

```bash
npm run build && npm test     # test = node --test "tests/*.test.mjs" "test/*.test.mjs"
```

**49 例离线测试，全部 pass**（实跑：`# tests 49 / # pass 49 / # fail 0`，约 583ms）。测试**从 `../lib/*.js` 导入**（与运行时同源），所以脚本本身不含 `tsc`——改源码后必须先 `npm run build`，否则跑的是旧产物（假绿陷阱）。

| 文件 | 例数 | 覆盖 |
|------|------|------|
| `tests/ops-logic.test.mjs` | 19 | 纯决策逻辑：档案过滤、插件名校验、loader 快照映射、活跃会话挑选、列表渲染、脚手架生成（含空描述/无 `dsh-` 前缀的保守占位） |
| `test/preflight-gate.test.mjs` | 14 | **重启闸门**：`decidePreflightGate` 四条判据（未调用 / 预检未过 / 记录不可读 / 时间早于进程启动）+ 调用者提取与比对文案 |
| `test/registry.test.mjs` | 12 | 档案库：`parsePatchRows`（行解析）、`extractTools`、`isBuilt`、`patchInsert/patchSetDisabled/patchSetConfig/patchRemove` 行编辑、`packageAddLinkDep/packageRemoveDep`、`buildRegistry` 对账 |
| `tests/event-log.test.mjs` | 4 | 事件日志薄壳：行格式、**尸体测试**（不可写路径 → 返回 `false` 且**不抛**） |

**无需网络、无需真实外部依赖**（`pnpm`、`dsh` bin、真实 profile 在测试中都不触碰；临时目录用 `mkdtempSync`）。

**未覆盖**（诚实声明）：挂载/卸载/启停/`daemon_restart` 的**端到端**路径（真改 profile → 真预检 → 真回滚 → 真写哨兵）没有自动化测试——那会触发真实重启；`registry.ts` 的官方 bundles / 第三方扫描分支亦无夹具。对应缺口见 [`docs/semantic.md`](docs/semantic.md) §10 U4。

## 设计要点

- **不变量 I1 改前必备份**：每次 `cordis.patch.yml` / `package.json` 修改先落 `.bak-<ISO 时间戳>`；目录里没有对应 `.bak-*` 的写入即视为不合规。
- **不变量 I2 预检失败必回滚且不写哨兵**：`preflight().pass === false` → 还原**全部**已改文件并返回 `ok:false`，`triggerReload` 不得被调用。**组合永远回不到坏状态，进程也永远不会带着坏组合重启**——这是本插件最核心的约束。
- **不变量 I3 挂载状态以 loader 为权威**：`plugin_list` 的 `status` 与 `ctx.loader.entries()` 一致（`alignWithLoader`）；静态快照（`data/system-state.json`）只作补充。历史事故：陈旧快照把已归一的插件仍标 `mounted`。
- **不变量 I4 重启走进程级闸门**：`daemon_restart` 的判据是「**本 web 进程启动后**是否调用过 `preflight_check` 且最近一次 `pass === true`」——**不比对 sessionId**（设计如此，§5.11 §3）；`.preflight-invoked.json` 不可读/坏 JSON 时 **fail-closed 拒绝**。`sessionId` 字段是历史遗留，真实调用者记在 `caller`，门控**不用它**做判断，只作证据留痕。
- **不变量 I5 卸载保留数据**：`plugin_unmount` 只移除 patch 行与 link 依赖，**不删插件目录**。
- **不变量 I6 只读面永不抛**：`plugin_list`/`plugin_inspect` 对坏包、缺失目录逐目录 `try/catch` 跳过并继续；`loadSystemState`/`loadOfficialCatalog` 读不到返回 `{}`/`[]`。
- **`pnpm install --package-import-method=copy`**：copy 导入方式绕开 Windows 上 link/rename 的 EPERM（`spawn(..., { shell: true })`）。
- **预检本体零重复实现**：`profile.ts:preflight()` 是 `dsh-agent-preflight` 的 `runPreflightCore` 薄封装，预算 `preflightReadyMs = 90000`（为 48 插件组合实测约 40s 留 2.25x 余量）。
- **并行实例协调的判据**：`.plugin-manager-events.log` 由 `event-log.ts:appendLineSafe` 写入（吞错返回 bool）——**事件行失败绝不阻断主流程**，但它是「另一个我是否正在部署」的唯一线索。
- **反定位**（本文不管什么）：不管**进程**生命周期（kill/spawn/保活归 `dsh-agent-guardian`/`dsh-agent-sentinel`，本插件只写哨兵）；不管**预检实现**（归 `dsh-agent-preflight`）；不管语义文档注册（归 `dsh-semantic-docs`）；**不是**沙箱、不是权限边界；**不是** npm 包管理器。

**未支持项 / 已知缺口**（不吹）：

| 项 | 状态 |
|----|------|
| `registryFile` 配置项 | **死配置**——声明 + 默认值存在，全仓库无读取点 |
| 自证轨迹的 `build` 字段（五问①） | **缺**——事件日志无「跑的是哪个构建」自报，只能靠 mtime 对照 |
| 自证轨迹的耗时字段（五问⑤） | **缺**——事件行只有 ISO 时刻，无 `durationMs`/预算字段 |
| 端到端自动化测试 | **缺**——真改 profile → 真预检 → 真回滚链路无夹具 |
| 调用者鉴权 | **无**——有权限的调用方即可操作；保护来自备份 + 回滚 + 预检门控 + 上层裁决包 |
| `plugin_unmount` 名称 | 与 `plugin_remove` 同义（工具名如此，描述里已注明）；数据目录不含在内 |

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语表、概念模型与 6 条不变量、契约（配置实际使用列 + 10 工具 + 调用点清单）、边界与信任、与既有机制的关系、可证伪验收清单（A1–A9）、实现关系、实践修订记录、未决问题 U1–U5 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `plugin-workflow` | 插件全生命周期编排（检查 → 升级 → 测试 → 命名 → 发布 → 回退） |
| 技能 `plugin-maintainability` / `dsh-plugin-development` | 机制自证与可维护性工程、DSH 插件开发方法论 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。

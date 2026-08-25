<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 插件管理器：插件档案库（清单/用途/工具/配置认知）+ 生命周期管理（创建/挂载/启停/卸载/配置），host 工具面 + 官方设置页「插件管理」tab。
  inject: 'tools','loader','sessions'
  tools: plugin_*,daemon_restart
  runtime: host + client
  envDeps: 无（纯逻辑/标准 Node）
  boundary: 无特殊授权边界
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-agent-plugin-manager — 插件管理器

DSH（DeepSeek Harness）插件：插件清单与生命周期管理——档案库（来源/版本/用途/工具/配置/状态）+ 创建/启停/改配置/卸载，host 工具面给 agent，client 以「插件管理」tab 挂在官方设置页。

## 功能特性

- **插件档案库**：来源（self/official）、版本、用途、工具面、挂载状态、配置摘要
- **生命周期管理**：创建（脚手架）/挂载/启动/停用/卸载/改配置
- **中文全覆盖**：插件简介/状态中文化，未挂载数真实化
- **安全**：profile 文件修改前备份；哨兵触发前沙盒预检（失败回滚不重启）；卸载保留数据目录

## 安装

```bash
cd <你的 self-plugins 目录>
git clone https://github.com/jonah791/dsh-agent-plugin-manager.git
cd dsh-agent-plugin-manager
pnpm install
pnpm build
```

## 使用

| 工具 | 说明 |
|------|------|
| `plugin_list` | 插件档案列表（来源/状态过滤） |
| `plugin_inspect` | 单个插件深度档案 |
| `plugin_create` | 创建新插件脚手架 |
| `plugin_mount` / `plugin_unmount` | 挂载/卸载（含依赖安装与哨兵重启闭环） |
| `plugin_start` / `plugin_stop` | 启用/停用 |
| `plugin_configure` | 更新配置 + 预检 + 哨兵重启 |

## 技术要点

- 与 dsh-agent-watch 分工：watch 管进程，本插件管插件
- 每次修改 profile 先备份，预检失败回滚——免疫层兜底

## 相关

- [我的数字生命爱丽丝 — 插件生态中心（架构总览）](https://github.com/jonah791/alice-digital-life)

## License

MIT

# AMC — Agent Management CLI

[English](README.md)

<p align="center">
  <img src="docs/assets/amc-hero.png" alt="AMC Skills 管理界面" width="100%">
</p>

<p align="center"><strong>Claude Code、Pi 与 Codex 的统一终端控制面。</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@i-xor/amc"><img src="https://img.shields.io/badge/npm-%40i--xor%2Famc-cc785c" alt="npm 软件包"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-5db872" alt="Node.js 22 或更高版本">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-a09d96" alt="macOS 与 Linux">
  <img src="https://img.shields.io/badge/license-Apache--2.0-a09d96" alt="Apache-2.0 许可证">
</p>

AMC 用于管理 Claude Code、Pi 和 Codex 的 Agent Skills、Hooks、Plugins 与
MCP servers。它在 `~/.amc/skills/` 中保留一份规范 Skill，通过符号链接连接
各提供方，并在迁移或修改配置前保留原始内容。

## 为什么选择 AMC

- **一份 canonical Skill，独立控制各提供方。** 复用内容，同时避免维护相互分叉的副本。
- **内置 Marketplace。** 浏览 skills.sh 与经过验证的公开 GitHub 仓库，查看描述、安装并检测更新。
- **不止管理 Skills。** 在同一个键盘优先 TUI 中检查和管理 Hooks、Plugins 与 MCP servers。
- **默认安全失败。** 冲突、本地漂移、不安全远程条目、陈旧计划与路径占用都会明确显示，不会被覆盖。

<p align="center">
  <img src="docs/assets/amc-showcase.png" alt="AMC Marketplace、Plugins 与 MCP 界面" width="100%">
</p>

## 安装

```bash
npm install --global @i-xor/amc
```

AMC **仅支持 macOS 和 Linux**，要求 **Node.js 22 或更高版本**。不支持
Windows junction。

## 安全开始

先运行只读清单和接管预览：

```bash
amc list
amc reconcile
amc migrate --all
```

这些无头预览不会创建、移动或改写文件。脚本需要显式授权才能应用安全项：

```bash
amc reconcile --apply --yes
```

直接运行 `amc` 会打开交互式 TUI，并自动接管没有歧义的用户级 Skill。AMC
扫描 `~/.agent/skills`、`~/.agents/skills`、Claude、Pi 和 Codex 目录；通过
原子移动将选定目录纳入 canonical store，不复制完整内容；再创建 AMC 自有软链接。
共享目录会拆成可独立启停的 Pi、Codex 链接。内容差异、外部链接、无效、陈旧或
目标占用项保持原状，等待用户明确选择来源。

旧迁移预览继续可用，存在差异的直接提供方副本仍不会被自动选择：

```bash
amc migrate --all --yes
amc migrate writing-text --source claude
```

## 命令

```text
amc
amc list [--page <n>] [--limit <1-100>] [--search <text>]
amc list --all [--search <text>]
amc list --diagnostics [--page <n>] [--limit <1-100>] [--search <text>]
amc list --diagnostics --all [--search <text>]
amc enable <skill> [--target claude|pi|codex]
amc disable <skill> [--target claude|pi|codex]
amc migrate <skill> [--source claude|pi|codex]
amc migrate --all [--yes]
amc reconcile
amc reconcile --apply --yes
amc reconcile <skill> --source agents|agent|claude|pi|codex|canonical --apply --yes
amc search <query> [--source skills.sh|github]
amc auth github login
amc auth github set --token-stdin
amc auth github status
amc repos list
amc repos add <owner/repo> [--branch <branch>]
amc repos refresh <owner/repo>
amc repos enable|disable <owner/repo>
amc repos remove <owner/repo>
amc install <owner/repo> --skill <name> [--branch <branch>]
amc upgrade <skill>
amc updates check [<skill>]
amc delete <skill> --yes --confirm <skill>
amc plugins list [--page <n>] [--limit <1-100>] [--search <text>] [--all]
amc plugins enable|disable <plugin-id>
amc hooks list [--page <n>] [--limit <1-100>] [--search <text>] [--all]
amc hooks edit <hook-id>
amc hooks enable|disable <hook-id>
amc mcp list [--page <n>] [--limit <1-100>] [--search <text>] [--all]
amc mcp enable|disable <mcp-id>
amc --help
amc --version
```

列表默认每页 20 行；`--all` 输出完整结果，搜索不区分大小写。重定向输出不包含
ANSI 样式。Skill 的 enable/disable 默认针对三个提供方，`--target` 可限定一个。
`shared` 表示即使没有提供方专属链接，Pi/Codex 仍可通过 `.agent` 或 `.agents`
发现该 Skill。无头命令不会交互询问：成功退出码为 `0`，操作失败为 `1`，用法错误为 `2`。

### GitHub 认证

AMC 支持通过官方 `gh` CLI 完成 GitHub OAuth，也支持手动 Token。OAuth 模式要求预先独立安装 `gh`，AMC 不会自动安装。缺少 `gh` 时，AMC 会显示当前平台的安装指引、重试命令和 Token 备选方案。OAuth 凭据继续由 `gh` 管理，AMC 只记录所选认证方式。Token 仅允许通过非 TTY stdin 输入，并以 `0600` 权限保存到 `0700` 的 `~/.amc/credentials/github-token` 目录中。`GITHUB_TOKEN` 环境变量优先级最高，Authorization 只会发送给 `api.github.com`。

```bash
amc auth github login
gh auth token | amc auth github set --token-stdin
amc auth github status
```

状态命令只显示认证方式、有效性、剩余 API 请求和重置时间，不输出凭据。

### Skill 市场与生命周期

`amc search` 聚合公开 skills.sh registry 与已启用的 GitHub 仓库。Marketplace TUI 默认展示公开的 skills.sh 历史热门榜，选中项接近当前列表末尾时自动增量加载后续榜单页，同时使用与其他 tabs 使用相同主题配色和选中样式、并包含 canonical 安装状态的自适应结果表格，并按当前选中项懒加载 GitHub 描述与来源信息。仅接受公开 `github.com` 仓库；受限扫描至少发现一个 frontmatter 中包含非空字符串 `name` 和 `description` 的 `SKILL.md` 后才会保存。支持根目录和嵌套 Skill，无效条目会报告并跳过。仓库内的重复镜像会优先选择精确 `skills/<name>` 路径，其次选择非隐藏目录；仍无法唯一确定时继续阻断。远程 symlink 与 submodule 永远不会被跟随或安装：只有异常条目位于当前嵌套 Skill 目录内时才拒绝该 Skill，仓库其他目录不会阻断安全描述。

安装前会重新解析仓库、分支、相对路径和提交。同名但来源不同或未知的 Skill 不会覆盖或自动改名。新安装默认不会为任何提供方启用。`amc updates check [<skill>]` 会只读检查一个或全部已应用 canonical Skills，报告最新、可更新、本地漂移、未追踪或错误；同来源扫描会复用，不创建 staging，也不自动升级。升级仅适用于记录了来源的安装，发现本地内容漂移就终止；v1 没有 force 模式。

`amc delete` 不可逆，也不等同于 disable。无头删除必须同时提供 `--yes` 和完全匹配的 `--confirm <skill>`。它会删除 canonical 内容、AMC 自有的启用/停放链接、来源记录，以及 AMC backup/staging/failed 中可识别的该 Skill 副本。中断时仅保留不含 Skill 内容的日志，下次相同删除请求会继续；已经删除的字节无法恢复。外部或非 AMC 所有的同名条目绝不会被删除。

### 提供方资源

- **Plugins：**Claude Code 使用原生无头命令；Codex 在备份后更新配置中的
  `plugins.<id>.enabled`，采用原子替换、验证和失败回滚。Pi 仅提供 package
  安装清单，没有 package 级启用状态，因此显示为 `installed`；具体资源仍需
  通过 `pi config` 交互管理。
- **MCP：**显示 Claude Code 的 user/local/project 定义和 Codex 原生清单。
  enable/disable 会保留 server 定义。AMC 不为 Pi 提供原生 MCP registry。
- **Hooks：**清单扫描绝不执行 Hook。enable/disable 会停放或恢复 JSON Hook，
  或更新 Pi extension override。`hooks edit` 优先使用 `$VISUAL`，其次使用
  `$EDITOR`，未配置时采用平台 fallback（macOS 为 `open -t`，Linux 为 `vi`）
  打开所选的提供方源文件。

## TUI 按键

| 按键 | 操作 |
| --- | --- |
| `Tab` | 切换 Skills、Marketplace、Hooks、Plugins 和 MCP |
| `↑` / `↓`、`j` / `k` | 移动选择 |
| `Page Up` / `Page Down` | 移动一个可见页面 |
| `Home` / `End` | 跳到第一项或最后一项 |
| `←` / `→` | 选择 All、Claude、Pi 或 Codex 范围 |
| `Space` | 在当前范围切换所选项目 |
| `1`、`2`、`3` | 为 Claude、Pi 或 Codex 切换 Skill |
| `/` | 开始实时搜索 |
| `Enter` | 接受当前搜索 |
| `Esc` | 取消、关闭帮助或清空搜索 |
| `m` | 检查 Skill 迁移；用 `1`/`2`/`3` 选择来源，用 `y` 确认 |
| `c` / `C` | 检查当前 Skill / 一键检查全部已应用 canonical Skills 的更新状态 |
| `u` | 升级当前记录了来源的 Skill |
| `d` | 经警告和完整名称确认后永久删除当前 Skill |
| Marketplace 中的 `/`、`a`、`i` | 搜索、添加已验证 GitHub 仓库、安装当前结果 |
| `e` | 编辑所选 Hook 源文件 |
| `r` | 刷新清单 |
| `?` | 显示或关闭按键帮助 |
| `q` | 退出 |

资源视图仅在提供方支持受控切换时响应 `Space`。Pi 的交互式 Plugin 会显示操作
提示。AMC 根据终端高度限制可见行数；小于 44 列或 10 行时显示调整尺寸提示。
可设置 `AMC_THEME=dark`、`AMC_THEME=light` 或 `AMC_THEME=mono`；`NO_COLOR`
始终选择 mono。

## 安全与凭据

AMC 对提供方拥有的状态采取保守策略：

- 清单、迁移预览和 `amc reconcile` 预览保持只读；
- 只有直接启动交互式 TUI 会隐式执行安全接管；
- 接管时把选定来源原子移动到 canonical，并把其他原始副本移动到唯一备份根目录；
- canonical 有效时，可明确修复无效或断链的共享/provider 条目：先归档异常条目，再重建托管链接，不替换 canonical 内容；已有停放链接继续保持 disabled，重复的 AMC 自有启用/停放链接会安全归档并恢复为单一一致状态；
- 配置写入采用独占临时文件、备份、验证，并在验证失败时恢复；
- 过期计划、冲突路径、无效记录和不支持的项目会终止操作，而不是被覆盖；
- 不自动移除备份、停放链接或失败产物；唯一例外是经二次确认的永久删除会清除该精确 Skill 的 AMC 自有副本；
- 列表输出不包含 MCP 环境变量值、headers、OAuth tokens 或其他凭据；
- Hook 扫描只读取元数据，不执行 Hook；
- editor 命令经 token 化后直接启动，不通过 shell 求值。

请勿在 issue 中粘贴凭据、token、私有配置或敏感路径。机密报告方式见
[安全政策](SECURITY.md)。

## 文件系统布局

```text
~/.amc/
├── skills/<skill>/
├── backups/<operation>/<target>/<skill>/
├── backups/<operation>/links/<target>/<skill>
├── backups/<operation>/staging/<skill>/
├── backups/<operation>/sources/<source>/<skill>/
├── disabled-links/<target>/<skill>
├── disabled-hooks/<hook-id>.json
├── credentials/github-token
├── github-auth.json
├── marketplace.json
├── skills-lock.json
├── delete-journals/<skill>.json
├── reconcile-journals/<operation>.json
├── staging/<operation>/<skill>/
└── failed/<operation>/
```

规范 Skill 链接到：

| 提供方 | Skill 目录 |
| --- | --- |
| Claude Code | `~/.claude/skills/` |
| Pi | `~/.pi/agent/skills/` |
| Codex | `~/.codex/skills/` |

停用 Hook 记录使用仅所有者可读写的权限。成功恢复的记录和失败写入会以说明性
后缀保留，不会静默删除。

## 恢复

每个 Skill 迁移都是独立事务。批量迁移遇到首个意外错误会停止，报告已完成和
待处理项目，并可基于最新清单重新运行。如果 rollback 遇到新对象，AMC 会保留
双方并报告精确恢复路径。手工操作前先检查错误中报告的 backup 或 `failed` 根目录，
并为其另做备份。

永久删除有意不提供 rollback。若操作中断，请重新执行完全相同的删除命令继续日志中尚未完成的路径；不要手工复用或修改日志。

配置变更会报告备份路径。确认失败通常会自动恢复原配置；如果恢复本身失败，请
保持双方文件不动，并按错误中的路径处理。

## 架构

```text
src/cli/           命令解析、帮助、格式化和无头执行
src/tui/           Ink 组件、Skill/resource 视图和键盘状态
src/core/skills/   Skill 扫描、切换、迁移、安装、升级、删除和恢复
src/core/marketplace/ 公开 registry/GitHub 发现、验证、缓存和来源记录
src/core/resources/ resource model、持久化、Plugins、MCP、Hooks
src/presentation/  终端主题和颜色角色
src/runtime.ts     注入的提供方命令与 editor 启动
```

CLI 和 TUI 使用相同的 typed core operation。提供方命令与 editor 通过 resource
runtime 注入；纯 presentation 和 TUI view helper 不访问文件系统。

## 开发

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run coverage
npm run build
npm pack --dry-run
```

`npm run build` 把生产文件输出到 `dist/src/`；测试构建把测试输出到 `dist/test/`。
测试使用隔离的临时 home，不写入当前用户的提供方目录。

## 项目政策

- [贡献指南](CONTRIBUTING.md)
- [安全政策](SECURITY.md)
- [行为准则](CODE_OF_CONDUCT.md)
- [变更日志](CHANGELOG.md)

AMC 使用 [Apache License 2.0](LICENSE)，归属信息见 [NOTICE](NOTICE)。

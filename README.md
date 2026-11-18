# CLI 安装检测

CC GUI 设置页插件：逐个探测宿主支持的 CLI 引擎，检查每个引擎的 PATH 入口、运行中进程、版本与 SHA256 是否一致。

## 为什么需要

CC GUI 支持多个 CLI 引擎，它们各有自己的安装来源：

- **Claude Code** 有 npm 全局安装和 CC GUI 自带的 SDK 副本两条独立升级路径
- **OpenCode**、**Codex** 等通过 npm 或官方安装器落地，可能在不同目录留下多份
- 每个引擎升级时只动自己那份，其他副本不会跟着变

一旦版本错开，同一个引擎在 CC GUI 里和终端里的行为就会不同。这个插件把每个引擎的差异直接摊开：路径、版本、SHA256、运行中实例数与归属。

## 检测的引擎

| 引擎 | 探测命令 |
|---|---|
| Claude Code | `claude` |
| Codex | `codex`、`codex-cli` |
| OpenCode | `opencode` |
| Qoder | `qoder` |
| Qoder (CN) | `qoder-cn`、`qoder` |
| Kimi CLI | `kimi` |
| Grok CLI | `grok` |
| CodeBuddy | `codebuddy` |
| MiniMax | `minimax` |
| OMP | `omp` |
| DSH | `dsh` |
| AGY | `agy` |
| Pi | `pi`、`hermes` |

引擎 id 来自 `ccgui-next.exe` 的 `AgentFrameProviderSection` 枚举；候选命令名参考宿主自带的 CLI 搜索目录（`.codex-cli\bin`、`.omp\bin`、`OpenAI\Codex\bin`、`AppData\Roaming\npm` 等）。

**命令名对不上时只会显示「未安装」，不会误报。** 每个「未安装」的引擎都会把探测过的命令名列出来，方便你对照自己实际装的是什么。

## 每个引擎检查什么

| 来源 | 怎么拿到 |
|---|---|
| PATH 解析顺序 | `Get-Command <命令> -All`，与 cmd / PowerShell 执行时一致 |
| 运行中进程 | 所有进程的 `ExecutablePath`，按目标文件路径匹配 |
| 进程实例数 | 同一路径的多个进程合并计数，卡片显示「运行中 ×2」 |
| 进程归属 | 回溯父进程链，标出 `CC GUI`、`终端` 或 `其他` |

npm 生成的 `.cmd` / `.bat` shim 会先解析成它实际调用的 exe 再算哈希，避免把 160 字节的包装脚本误判成「另一个安装」。

归属判定是往上找最多 12 层父进程：链上出现 `ccgui` / `codemoss` 归为 CC GUI，出现 Windows Terminal、cmd、PowerShell、VS Code 等归为终端。同一份二进制可能同时被两边使用，卡片会显示 `CC GUI + 终端`。

结论按引擎分别给出：

- **一致** — 该引擎所有入口的 SHA256 相同
- **版本相同，文件不同** — 可能是不同构建
- **版本分叉** — 已存在实质差异
- **未安装** — PATH 里没找到任何候选命令

## 安装与使用

CC GUI 侧边栏「插件」→ 在市场里搜索「CLI 安装检测」，或从本地目录安装。

两个入口：

- **设置页**：设置 → 插件 → CLI 安装检测 → 「CLI 安装检测」区块
- **命令面板**：搜「CLI 安装检测」，直接跳到上面那个区块

进入区块即自动检测一次，右上角「重新检测」手动重跑。引擎较多时首次约 10 秒。

## 权限

| 权限 | 用途 |
|---|---|
| `ui:settings-section` | 设置页里的检测区块 |
| `ui:command` | 命令面板入口 |
| `exec:powershell` | 调用 PowerShell 读取进程列表、版本与文件哈希 |

不联网、不写文件、不读对话内容。

> 为什么需要 `exec:powershell`：插件 SDK 没有文件系统 API，读进程与算 SHA256 只能经宿主授权的子进程完成。PowerShell 是唯一需要的二进制。

## 已知限制

- 仅 Windows（依赖 `Win32_Process`）。
- 检测串行执行：每个已安装引擎都要跑一次 `--version`，大文件再各算一次 SHA256，引擎越多越慢。
- 进程按可执行文件**路径**分组，同一路径跑 N 个实例只显示一个文件、标「×N」。
- `--version` 有 4 秒超时；不支持的 CLI 会显示「版本未读取」，但仍会比较哈希。
- 部分引擎的候选命令名来自推断，可能与本机实际安装名不同，此时显示「未安装」。
- 归属依赖父进程链，链被提前终止（如以服务方式启动）时可能归为「其他」。

## 开发

```bash
node scripts/validate-manifest.mjs
```

发版：升 `manifest.json` 的 `version`，打同名 tag（无 `v` 前缀），Release 由 Action 生成。

## 许可

MIT

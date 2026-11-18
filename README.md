# CLI 安装检测

CC GUI 设置页插件：探测宿主支持的 CLI 引擎，检查每个引擎的 PATH 入口、运行中进程、版本与 SHA256 是否一致。打开时只做秒级命令发现，选中引擎后才读版本与哈希。

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
| Qoder (CN) | `qoder-cn` |
| Kimi CLI | `kimi` |
| Grok CLI | `grok` |
| CodeBuddy | `codebuddy` |
| MiniMax | `minimax` |
| OMP | `omp` |
| DSH | `dsh` |
| AGY | `agy` |
| Pi | `pi` |

引擎 id 来自 `ccgui-next.exe` 的 `AgentFrameProviderSection` 枚举；候选命令名参考宿主自带的 CLI 搜索目录（`.codex-cli\bin`、`.omp\bin`、`OpenAI\Codex\bin`、`AppData\Roaming\npm` 等）。

**命令名对不上时只会显示「未安装」，不会误报。** 每个「未安装」的引擎都会把探测过的命令名列出来，方便你对照自己实际装的是什么。

## 检测是怎么分段的

一次全量深度检测要跑十几次 `--version`，还要对每个二进制算 SHA256，实测约 9 秒——打开设置页就等这么久不合理。所以拆成两段：

| 阶段 | 触发 | 耗时 | 做什么 |
|---|---|---|---|
| 恢复缓存 | 打开区块（存在历史结果时） | 毫秒级 | 从 `ctx.storage` 读回上次结果，不跑 PowerShell |
| 命令发现 | 首次打开、点「重新发现」 | 约 1–2 秒 | 只跑 `Get-Command`，列出 13 个引擎里哪些已安装 |
| 深度检测 | 在下拉框选中引擎、点「检测」 | 单引擎约 1–5 秒 | 解析 shim、读 `--version`、算 SHA256、匹配运行中进程 |

切换下拉框即触发该引擎的检测；结果写入 `ctx.storage` 并在会话内缓存，切回来直接显示。「重新检测」忽略缓存重扫当前引擎。

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

进入区块先做一次命令发现（约 1–2 秒），列出 13 个引擎里哪些已安装。在下拉框里选中某个引擎后，才读取它的版本、SHA256 与运行中进程；结果在本次会话内缓存，切回来直接显示。右上角「重新发现」重扫 PATH。

## 权限

| 权限 | 用途 |
|---|---|
| `ui:settings-section` | 设置页里的检测区块 |
| `ui:command` | 命令面板入口 |
| `exec:powershell` | 调用 PowerShell 读取进程列表、版本与文件哈希 |
| `storage` | 经 `ctx.storage` 保存上次检测结果 |

不联网、不读对话内容、不写文件。唯一写入的是宿主提供的插件键值存储（`ctx.storage`），不碰文件系统。

> 为什么需要 `exec:powershell`：插件 SDK 没有文件系统 API，读进程与算 SHA256 只能经宿主授权的子进程完成。PowerShell 是唯一需要的二进制。

## 数据存在哪里

检测结果写在 `ctx.storage` 的 `audit-cache-v1` 键下：

```js
{
  version: 1,            // 结构版本，不匹配就丢弃
  engines: [...],        // 上次命令发现结果
  details: {             // 按引擎分开存取
    claude: { engine: {...}, at: "2026-11-18T06:32:10.000Z" },
    ...
  },
  savedAt: 1763447530000
}
```

- **重启 CC GUI 后**直接显示上次结果，不重跑 PowerShell
- 每个引擎的结果独立标注「检测于 …」，不会把旧数据当成当前状态
- 点「重新检测」才刷新，发现结果用「重新发现」刷新
- 存储不可用时静默降级为纯内存缓存，功能不受影响

## 已知限制

- 仅 Windows（依赖 `Win32_Process`）。
- 深度检测按引擎串行执行：版本探测与 SHA256 都在同一个 PowerShell 进程里顺序完成，单个引擎约 1–5 秒。
- 进程按可执行文件**路径**分组，同一路径跑 N 个实例只显示一个文件、标「×N」。
- `--version` 有 4 秒超时；不支持的 CLI 会显示「版本未读取」，但仍会比较哈希。
- 部分引擎的候选命令名来自推断，可能与本机实际安装名不同，此时显示「未安装」。
- 引擎清单是静态表（`main.js` 顶部的 `ENGINES`）。宿主新增引擎时需要发版才能覆盖：`ctx.models.listEngines()` 能给出宿主的引擎目录，但不提供可执行文件名，PATH 检测仍依赖命令名映射。
- Qoder 与 Qoder (CN) 共用 `qoder` 命令时只会识别为 Qoder，不重复计数。
- 归属依赖父进程链，链被提前终止（如以服务方式启动）时可能归为「其他」。

## 开发

```bash
node scripts/validate-manifest.mjs
```

发版：升 `manifest.json` 的 `version`，打同名 tag（无 `v` 前缀），Release 由 Action 生成。

## 许可

MIT

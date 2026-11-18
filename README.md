# Claude 安装检测

CC GUI 面板插件：检查本机多个 Claude Code 二进制是不是同一个文件。

## 为什么需要

CC GUI 启动的是它自己下载的 SDK 副本，而你的终端用的是 npm 全局安装。两者是**两条独立的升级路径**：

- CC GUI 点「更新至 x.y.z」只更新 `~/.codemoss/dependencies/claude-sdk/`
- `npm i -g @anthropic-ai/claude-code@latest` 只更新 npm 全局

一旦版本错开，你在 CC GUI 里看到一个行为，在终端里看到另一个。这个插件把差异直接摊开：路径、版本、SHA256。

## 检测什么

| 来源 | 怎么拿到 |
|---|---|
| PATH 解析顺序 | `Get-Command claude -All`，与 cmd / PowerShell 执行时一致 |
| CC GUI 自带 SDK | `~/.codemoss/dependencies/claude-sdk/.../claude.exe` |
| 运行中进程 | 所有 `claude.exe` 的 `ExecutablePath`（最权威，反映「自定义 Claude Code 路径」是否生效） |
| 进程实例数 | 同一路径的多个进程合并计数，卡片显示「运行中 ×2」 |
| 进程归属 | 回溯父进程链，标出 `CC GUI`、`终端` 或 `其他` |

归属判定是往上找最多 12 层父进程：链上出现 `ccgui` / `codemoss` 归为 CC GUI，出现 Windows Terminal、cmd、PowerShell、VS Code 等归为终端。同一份二进制可能同时被两边使用，卡片会显示 `CC GUI + 终端`。

npm 生成的 `.cmd` shim 会先解析成它实际调用的 exe 再算哈希，避免把 160 字节的包装脚本误判成"另一个安装"。

结论分三档：

- **SHA256 只有一个** → 同一个文件
- **版本相同、哈希不同** → 可能是不同构建
- **版本不同** → 已分叉

## 安装与使用

CC GUI 侧边栏「插件」→ 在市场里搜索「Claude 安装检测」，或从本地目录安装。

两个入口：

- **设置页**：设置 → 插件 → Claude 安装检测 → 「安装检测」区块
- **命令面板**：搜「Claude 安装检测」，直接跳到上面那个区块

进入区块即自动检测一次，右上角「重新检测」手动重跑。首次约 3 秒。

## 权限

| 权限 | 用途 |
|---|---|
| `ui:settings-section` | 设置页里的「安装检测」区块 |
| `ui:command` | 命令面板入口 |
| `exec:powershell` | 一次调用 PowerShell 读取进程列表与文件哈希 |

不联网、不写文件、不读对话内容。

> 为什么需要 `exec:powershell`：插件 SDK 没有文件系统 API，读进程与算 SHA256 只能经宿主授权的子进程完成。PowerShell 是唯一需要的二进制。

## 已知限制

- 仅 Windows（依赖 `Win32_Process`）。
- 两个 300MB+ 文件各算一次 SHA256，首次检测约 3 秒。
- 进程按可执行文件**路径**分组，同一路径跑 N 个实例只显示一个文件、标「×N」。
- 进程过滤只认 `claude.exe`；改名后的二进制不会被「运行中」捕获，只能靠 PATH 发现。
- 没有运行中的 `claude.exe` 时，只能按自带 SDK 推断 CC GUI 用哪一份。
- 归属依赖父进程链，链被提前终止（如以服务方式启动）时可能归为「其他」。

## 开发

```bash
node scripts/validate-manifest.mjs
```

发版：升 `manifest.json` 的 `version`，打同名 tag（无 `v` 前缀），Release 由 Action 生成。

## 许可

MIT

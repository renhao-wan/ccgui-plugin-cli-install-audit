// 引擎清单：id 来自 ccgui-next.exe 的 AgentFrameProviderSection 枚举，
// 候选命令名参考宿主的 npm/CLI 搜索目录常量（.codex-cli\bin、.omp\bin、OpenAI\Codex\bin 等）。
// 名字对不上时只会显示「未安装」，不会误报。
const ENGINES = [
  { id: 'claude', label: 'Claude Code', cmds: ['claude'] },
  { id: 'codex', label: 'Codex', cmds: ['codex', 'codex-cli'] },
  { id: 'opencode', label: 'OpenCode', cmds: ['opencode'] },
  { id: 'qoder', label: 'Qoder', cmds: ['qoder'] },
  { id: 'qoder-cn', label: 'Qoder (CN)', cmds: ['qoder-cn'] },
  { id: 'kimi', label: 'Kimi CLI', cmds: ['kimi'] },
  { id: 'grok', label: 'Grok CLI', cmds: ['grok'] },
  { id: 'codebuddy', label: 'CodeBuddy', cmds: ['codebuddy'] },
  { id: 'minimax', label: 'MiniMax', cmds: ['minimax'] },
  { id: 'omp', label: 'OMP', cmds: ['omp'] },
  { id: 'dsh', label: 'DSH', cmds: ['dsh'] },
  { id: 'agy', label: 'AGY', cmds: ['agy'] },
  { id: 'pi', label: 'Pi', cmds: ['pi'] },
];

const PS_TEMPLATE = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$mode = '@@MODE@@'
$onlyId = '@@ENGINE@@'
$engineDefs = '@@ENGINES@@' | ConvertFrom-Json

# ---------- discover：只做命令发现，不算哈希 ----------
if ($mode -eq 'discover') {
  $list = @()
  foreach ($def in $engineDefs) {
    $resolved = @()
    foreach ($cmd in @($def.cmds)) {
      # 与 detail 阶段保持同一判定：必须是 PATH 中真实存在的 exe/cmd/bat
      $hits = @(Get-Command $cmd -All -ErrorAction SilentlyContinue)
      $ok = $false
      foreach ($c in $hits) {
        $src = $null
        if ($c.Source) { $src = [string]$c.Source }
        elseif ($c.Path) { $src = [string]$c.Path }
        if (-not $src) { continue }
        if ($src -notmatch '\.(exe|cmd|bat)$') { continue }
        if (-not (Test-Path -LiteralPath $src)) { continue }
        $ok = $true
        break
      }
      if ($ok) { $resolved += [string]$cmd }
    }
    $list += [ordered]@{
      id       = [string]$def.id
      label    = [string]$def.label
      cmds     = [object[]]@($def.cmds)
      resolved = [object[]]$resolved
    }
  }
  @{ engines = [object[]]$list } | ConvertTo-Json -Depth 6 -Compress
  exit 0
}

# ---------- detail：只扫一个引擎 ----------
$def = $engineDefs | Where-Object { $_.id -eq $onlyId } | Select-Object -First 1
if (-not $def) {
  @{ error = 'unknown engine: ' + $onlyId } | ConvertTo-Json -Compress
  exit 0
}

$allProc = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
$procTable = @{}
foreach ($p in $allProc) { $procTable[[int]$p.ProcessId] = $p }

function Get-AncestorNames([int]$startPid) {
  $names = @()
  $cur = $startPid
  $depth = 0
  while ($cur -gt 0 -and $depth -lt 12) {
    $node = $procTable[$cur]
    if (-not $node) { break }
    $names += [string]$node.Name
    $cur = [int]$node.ParentProcessId
    $depth++
  }
  return $names
}

function Get-OwnerKind($names) {
  $j = ($names -join '|').ToLowerInvariant()
  if ($j -match 'ccgui|codemoss') { return 'ccgui' }
  if ($j -match 'windowsterminal\.exe|\bwt\.exe\b|cmd\.exe|powershell\.exe|pwsh\.exe|conhost\.exe|\bcode\.exe\b|wezterm|alacritty|tabby\.exe|hyper\.exe|mintty|bash\.exe') { return 'terminal' }
  return 'other'
}

$procGroups = @{}
foreach ($p in $allProc) {
  $ppath = [string]$p.ExecutablePath
  if (-not $ppath) { continue }
  $pkey = $ppath.ToLowerInvariant()
  if (-not $procGroups.Contains($pkey)) {
    $procGroups[$pkey] = [ordered]@{ path = $ppath; count = 0; owners = @() }
  }
  $g = $procGroups[$pkey]
  $g['count'] = [int]$g['count'] + 1
  $owner = Get-OwnerKind (Get-AncestorNames ([int]$p.ParentProcessId))
  if ($g['owners'] -notcontains $owner) { $g['owners'] += $owner }
}

function Resolve-Shim([string]$p) {
  $dir = Split-Path -Parent $p
  $raw = Get-Content -LiteralPath $p -Raw -ErrorAction SilentlyContinue
  if (-not $raw) { return $null }
  $t = $raw -replace '(?i)%~dp0\\?', ($dir + '\')
  $t = $t -replace '(?i)%dp0%\\?', ($dir + '\')

  # npm 的 JS bin：优先解析 node_modules 下的脚本，避免误把 node.exe 当成目标
  $js = [regex]::Match($t, '"([^"\r\n]+?\.(?:js|mjs|cjs))"')
  if ($js.Success) {
    $cand = $js.Groups[1].Value
    if (Test-Path -LiteralPath $cand) { return $cand }
  }

  # 其次找 .exe，但排除 node 运行时本身
  $m = [regex]::Match($t, '"([^"\r\n]+?\.exe)"')
  if (-not $m.Success) { $m = [regex]::Match($t, '([A-Za-z]:\\[^"\r\n]+?\.exe)') }
  if ($m.Success) {
    $cand = $m.Groups[1].Value
    if ($cand -match '(?i)\\node\.exe$') { return $null }
    if (Test-Path -LiteralPath $cand) { return $cand }
  }
  return $null
}

# 带超时的版本读取，避免某个 CLI 不支持 --version 时卡住。
# 先异步读流再等待退出，防止子进程写满管道后双方互锁。
function Get-CliVersion([string]$file, [string]$argText = '--version') {
  $proc = $null
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $file
    $psi.Arguments = $argText
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit(4000)) {
      try { $proc.Kill() } catch {}
      return $null
    }
    try { [void][System.Threading.Tasks.Task]::WaitAll(@($outTask, $errTask), 1500) } catch {}
    $so = if ($outTask.IsCompleted) { [string]$outTask.Result } else { '' }
    $se = if ($errTask.IsCompleted) { [string]$errTask.Result } else { '' }
    $text = ([string]$so + ' ' + [string]$se).Trim()
    if ($text) {
      $line = ($text -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -First 1)
      if ($line) {
        try { $proc.Dispose() } catch {}
        return [string]$line.Trim()
      }
    }
  } catch {
  } finally {
    if ($proc) { try { $proc.Dispose() } catch {} }
  }
  return $null
}

$installs = @()
$seen = @{}
$resolvedCmds = @()

foreach ($cmd in @($def.cmds)) {
  $found = @(Get-Command $cmd -All -ErrorAction SilentlyContinue)
  $cmdOk = $false

  foreach ($c in $found) {
    $src = $null
    if ($c.Source) { $src = [string]$c.Source }
    elseif ($c.Path) { $src = [string]$c.Path }
    if (-not $src) { continue }
    if ($src -notmatch '\.(exe|cmd|bat)$') { continue }
    if (-not (Test-Path -LiteralPath $src)) { continue }
    $cmdOk = $true

    $target = $src
    $kind = 'exe'
    if ($src -match '\.(cmd|bat)$') {
      $rs = Resolve-Shim $src
      if ($rs) {
        $target = $rs
        if ($target -match '\.(js|mjs|cjs)$') { $kind = 'script' }
      } else {
        $kind = 'shim'
      }
    }
    $key = $target.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true

    $ver = $null
    if ($kind -eq 'exe') { $ver = Get-CliVersion $target '--version' }
    elseif ($kind -eq 'script') { $ver = Get-CliVersion 'node' ('"' + $target + '" --version') }

    $hash = $null
    try { $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower() } catch {}

    $size = 0
    try { $size = [long](Get-Item -LiteralPath $target).Length } catch {}

    $pg = $procGroups[$key]
    $ownerList = @()
    $pc = 0
    if ($pg) { $pc = [int]$pg.count; $ownerList = @($pg.owners) }

    $installs += [ordered]@{
      entry        = $src
      target       = $target
      kind         = $kind
      version      = $ver
      sha256       = $hash
      size         = $size
      processCount = $pc
      owners       = [object[]]$ownerList
    }
  }

  if ($cmdOk) { $resolvedCmds += [string]$cmd }
}

@{
  engine = [ordered]@{
    id       = [string]$def.id
    label    = [string]$def.label
    cmds     = [object[]]@($def.cmds)
    resolved = [object[]]$resolvedCmds
    installs = [object[]]$installs
  }
} | ConvertTo-Json -Depth 8 -Compress
`;

function buildScript(mode, engineId) {
  const defs = ENGINES.map((e) => ({ id: e.id, label: e.label, cmds: e.cmds }));
  // PowerShell 单引号字符串内 ' 需要写成 ''；一次性替换，避免值里再出现占位符
  const psStr = (s) => String(s).replace(/'/g, "''");
  const values = {
    '@@ENGINES@@': psStr(JSON.stringify(defs)),
    '@@MODE@@': psStr(mode),
    '@@ENGINE@@': psStr(engineId || ''),
  };
  return PS_TEMPLATE.replace(/@@(ENGINES|MODE|ENGINE)@@/g, (m) => values[m]);
}

// PowerShell -EncodedCommand 需要 UTF-16LE 的 base64
function toEncodedCommand(script) {
  const bytes = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i);
    bytes[i * 2] = c & 0xff;
    bytes[i * 2 + 1] = (c >> 8) & 0xff;
  }
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}

// 已安装的排前面，组内按显示名首字母排序
function sortEngines(list) {
  return [...list].sort((a, b) => {
    const ai = a.resolved.length > 0 ? 0 : 1;
    const bi = b.resolved.length > 0 ? 0 : 1;
    if (ai !== bi) return ai - bi;
    return String(a.label).localeCompare(String(b.label), 'en');
  });
}

function fmtSize(n) {
  if (!n) return '-';
  return (n / 1024 / 1024).toFixed(1) + ' MiB';
}

function shortHash(h) {
  if (!h) return '(读取失败)';
  return h.slice(0, 12) + '…';
}

// 加载与过渡动画：颜色全部走宿主 token，深浅色主题自动跟随
const UI_CSS = `
@keyframes cli-audit-spin { to { transform: rotate(360deg); } }
@keyframes cli-audit-pulse { 0%, 100% { opacity: .55; } 50% { opacity: .18; } }
@keyframes cli-audit-fade { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
.cli-audit-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  flex: none;
  border: 2px solid var(--color-separator-border, rgba(127,127,127,.3));
  border-top-color: var(--color-accent-primary-default, #3b82f6);
  border-radius: 50%;
  animation: cli-audit-spin .8s linear infinite;
}
.cli-audit-skeleton {
  height: 10px;
  border-radius: 5px;
  background: var(--color-background-tertiary-hover, rgba(127,127,127,.15));
  animation: cli-audit-pulse 1.2s ease-in-out infinite;
}
.cli-audit-fade { animation: cli-audit-fade 180ms ease-out; }
.cli-audit-menu { animation: cli-audit-fade 120ms ease-out; }
@media (prefers-reduced-motion: reduce) {
  .cli-audit-spinner, .cli-audit-skeleton, .cli-audit-fade, .cli-audit-menu { animation: none; }
}
`;

export default function activate(ctx) {
  const { createElement: h, useState, useEffect, useCallback } = ctx.react;

  const PLUGIN_ID = 'cli-install-audit';
  const PLUGIN_NAME = 'CLI 安装检测';
  const CACHE_KEY = 'audit-cache-v1';
  // 反馈中转。改主机名要同步 manifest.json 的 network:<host>（精确匹配，不支持通配）。
  const FEEDBACK_ENDPOINT = 'https://ccgui-feedback.2653990378.workers.dev';
  const FEEDBACK_REPO = 'renhao-wan/ccgui-plugin-cli-install-audit';
  const FEEDBACK_TIMEOUT_MS = 15000;

  /* ------------------------------------------------------------ 反馈纯函数
   * 从 ccgui-plugin-github-trending 的 src/lib/feedback.mjs 原样复制（这个插件
   * 没有构建步骤，只能整段内联）。改这里记得同步那边，两边应当逐字一致。
   * 只回答「发什么」和「回什么」，网络在下方 sendFeedback / fetchQuota 里。
   */

  /** 正文上限。再长就不是一条反馈，而是一篇文档了。 */
  const TEXT_LIMIT = 1000;

  /**
   * 收敛用户输入：去控制字符、统一换行、折叠连续空行与行尾空白、限长。
   * 保留大小写、中文、emoji 与**换行**——用户最常贴的就是报错日志，
   * 压成一行后堆栈就没法看了。
   */
  function normaliseFeedbackText(raw) {
    return String(raw === undefined || raw === null ? '' : raw)
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, ' ')
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f�]/g, '')
      // 只去行尾空白与整段首尾空白；正文内行首缩进要留着（堆栈靠它对齐）。
      .replace(/[ \t]+$/gm, '')
      .replace(/^[ \t]+/, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+|\n+$/g, '')
      .slice(0, TEXT_LIMIT)
      .replace(/[ \t\n]+$/, '');
  }

  /**
   * GitHub 新建 Issue 的预填链接。
   *
   * 用预填而不是直接调 API：API 要 PAT，PAT 写进插件源码等于公开。预填链接
   * 只依赖用户浏览器里已有的登录态，插件一行网络代码都不用写。
   */
  function buildIssueUrl(o) {
    const text = normaliseFeedbackText(o.text);
    const body = [
      text || '_（请在这里描述问题或建议）_',
      '',
      '---',
      '插件：' + String(o.pluginName || '') + ' ' + String(o.pluginVersion || ''),
      'CC GUI：' + String(o.hostVersion || ''),
    ].join('\n');
    const q = new URLSearchParams({
      title: '[反馈] ' + String(o.pluginName || ''),
      body,
    });
    return 'https://github.com/' + String(o.repo || '') + '/issues/new?' + q.toString();
  }

  /** 请求体允许的字段。白名单而非黑名单：漏传字段比误传路径好。 */
  const PAYLOAD_FIELDS = ['text', 'pluginId', 'pluginVersion', 'hostVersion', 'ts'];

  /** 组装发往中转的请求体，只保留白名单字段。 */
  function buildFeedbackPayload(o) {
    const src = {
      text: normaliseFeedbackText(o.text),
      pluginId: String(o.pluginId || ''),
      pluginVersion: String(o.pluginVersion || ''),
      hostVersion: String(o.hostVersion || ''),
      ts: Number(o.now) || Date.now(),
    };
    const out = {};
    for (const k of PAYLOAD_FIELDS) out[k] = src[k];
    return out;
  }

  /** 把服务端给的额度字段收敛成 number | null。别用 Number.isFinite(Number(v))：
   *  Number(null) 与 Number('') 都是 0，会把「没给」读成「今天 0 条额度」。 */
  function quotaCount(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') {
      if (!v.trim()) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  /** 发送成功后更新剩余额度：服务端回传的优先，没给就按旧值自减一条。 */
  function nextQuota(prev, fromServer) {
    const n = quotaCount(fromServer);
    if (n !== null) {
      return { remaining: n, dailyLimit: (prev && prev.dailyLimit) || 30 };
    }
    const prevRemaining = prev && typeof prev.remaining === 'number' ? prev.remaining : null;
    if (prevRemaining === null) return prev;
    return { remaining: Math.max(0, prevRemaining - 1), dailyLimit: prev.dailyLimit || 30 };
  }

  function parseJsonBody(body) {
    if (typeof body !== 'string' || !body) return null;
    try {
      const v = JSON.parse(body);
      return v && typeof v === 'object' ? v : null;
    } catch {
      return null;
    }
  }

  /**
   * 把一次中转响应翻译成界面文案。
   *
   * 一条原则：**永远给出「你还能做什么」**。反馈发不出去不是用户的错，
   * 所以每条失败文案都要么说清原因，要么指向还能走的路（GitHub Issue）。
   */
  function describeFeedbackResult(r) {
    if (r && r.error) {
      const raw = String(r.error.message || r.error);
      if (/timed?\s*out|timeout|ETIMEDOUT/i.test(raw)) {
        return {
          ok: false,
          kind: 'timeout',
          message: '发送超时。中转可能被网络挡住，可改用 GitHub Issue 反馈',
          remaining: null,
        };
      }
      if (/network:|permission|授权/i.test(raw)) {
        return { ok: false, kind: 'denied', message: '网络权限未生效，请重新安装插件', remaining: null };
      }
      return {
        ok: false,
        kind: 'network',
        message: '连不上反馈服务，请检查网络或代理，也可改用 GitHub Issue 反馈',
        remaining: null,
      };
    }

    const status = Number(r && r.status) || 0;
    const data = parseJsonBody(r && r.body);
    const remaining = data ? quotaCount(data.remaining) : null;
    const code = data && typeof data.error === 'string' ? data.error : '';

    if (status >= 200 && status < 300) {
      // 成功响应必须带 ok:true。只看状态码会把运营商劫持页、登录门户、
      // 代理错误页（都会返回 200）当成「已发送」——用户以为发出去了，
      // 实际什么都没有。
      if (!data || data.ok !== true) {
        return {
          ok: false,
          kind: 'garbled',
          message: '反馈服务返回了无法识别的内容，可能被网络拦截，可改用 GitHub Issue 反馈',
          remaining: null,
        };
      }
      return { ok: true, kind: 'sent', message: '反馈已发送，谢谢', remaining };
    }

    if (status === 429) {
      const burst = data && data.kind === 'burst';
      return {
        ok: false,
        kind: 'rate_limited',
        message: burst
          ? '发得太快了，稍等几分钟再试，或改用 GitHub Issue 反馈'
          : '今天的反馈额度已用完，明天再来，或改用 GitHub Issue 反馈',
        // burst 时今天还有额度，写死 0 会让界面谎报「今天用完了」。
        remaining: burst ? remaining : 0,
      };
    }

    if (status === 413) {
      return { ok: false, kind: 'invalid', message: '反馈内容太长了，请缩短后重试', remaining };
    }

    if (status === 400) {
      if (code === 'unknown_plugin') {
        return {
          ok: false,
          kind: 'invalid',
          message: '中转不认识这个插件版本，请更新插件，或改用 GitHub Issue 反馈',
          remaining,
        };
      }
      if (code === 'empty_text') {
        return { ok: false, kind: 'invalid', message: '反馈内容是空的，写点内容再发', remaining };
      }
      return { ok: false, kind: 'invalid', message: '反馈内容不合要求，请缩短后重试', remaining };
    }

    if (status === 502 || status === 503 || status === 500) {
      return {
        ok: false,
        kind: 'http',
        message: '中转暂时不可用，稍后再试，或改用 GitHub Issue 反馈',
        remaining,
      };
    }

    if (status === 0) {
      return {
        ok: false,
        kind: 'network',
        message: '连不上反馈服务，请检查网络或代理，也可改用 GitHub Issue 反馈',
        remaining: null,
      };
    }

    return {
      ok: false,
      kind: 'http',
      message: '发送失败（HTTP ' + status + '），可改用 GitHub Issue 反馈',
      remaining,
    };
  }

  /**
   * 额度提示文案。两种「查不到」要分开：
   *   - `{offline: true}`：请求失败。说「额度有限」会把网络故障说成用户在刷屏。
   *   - 其他：服务端回了但字段脏，或压根没查。这时该提醒别刷屏。
   */
  function describeQuota(quota) {
    if (quota && quota.offline) {
      return { remaining: null, message: '暂时连不上反馈服务，发送时再试', canRetry: true };
    }
    // Number(null) === 0、Number('') === 0：不显式挡掉，脏数据会被读成「0 条」。
    const raw = quota ? quota.remaining : undefined;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return { remaining: null, message: '额度有限，请勿刷屏', canRetry: true };
    }
    const remaining = Math.max(0, raw);
    if (remaining === 0) {
      return { remaining: 0, message: '今天的反馈额度已用完，明天再来', canRetry: true };
    }
    return { remaining, message: '今天还可发 ' + remaining + ' 条反馈', canRetry: false };
  }

  /** 给桥接调用加一层超时。宿主侧若一直挂着，界面不能永远停在「发送中…」。 */
  /**
   * 反馈渠道的网络层：`send` 发一条反馈，`quota` 查今天还剩几条。
   *
   * 用工厂而不是两个裸函数，是为了让「插件身份」只能从一处来：`pluginId`
   * 同时决定请求体里的 pluginId 和 User-Agent 前缀，不可能出现「体里是 A、
   * UA 里是 B」的错位。宿主版本也只在这里读一次。
   *
   * 这一层只做「发什么、怎么发、回什么」的搬运；文案全部交给
   * describeFeedbackResult / describeQuota，隐私边界由 buildFeedbackPayload
   * 的白名单钉住。
   */

  /**
   * 给 promise 加超时。超时抛 `Error("<label> timeout")`，
   * describeFeedbackResult 靠这个字符串识别超时。
   *
   * 名字带 `fbNet` 前缀：库文件会和 main.head.js 拼进同一作用域，
   * 那边已经有一个给工作区登记与解读用的顶层 withTimeout，重名不是覆盖
   * 而是整个模块语法错误（build.mjs 的顶层重名自检会直接拦住）。
   *
   * @template T
   * @param {Promise<T>} promise
   * @param {number} ms
   * @param {string} label
   * @returns {Promise<T>}
   */
  function fbNetTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label + " timeout")), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * 宿主版本。老版本宿主可能没有这一项，取不到就留空——不能因此发不出反馈。
   *
   * @param {object} ctx
   * @returns {string}
   */
  function fbNetHostVersion(ctx) {
    try {
      return ctx && ctx.host && typeof ctx.host.appVersion === "string" ? ctx.host.appVersion : "";
    } catch {
      return "";
    }
  }

  /**
   * 建一整套反馈网络调用。
   *
   * @param {object} ctx 插件上下文（要用 ctx.bridge / ctx.version / ctx.host）
   * @param {{endpoint: string, pluginId: string, timeoutMs?: number}} opts
   *   endpoint 必须与 manifest 的 `network:<host>` 一致，否则宿主会拒。
   * @returns {{send: (text: string) => Promise<object>, quota: () => Promise<object|null>}}
   */
  function createFeedbackNet(ctx, opts) {
    const endpoint = String(opts.endpoint || "").replace(/\/+$/, "");
    const pluginId = String(opts.pluginId || "");
    const timeoutMs = Number(opts.timeoutMs) || 15000;
    const userAgent = () => "ccgui-" + pluginId + "/" + ctx.version;

    /**
     * 发一条反馈。返回值就是 describeFeedbackResult 的结果，界面直接渲染。
     *
     * 不做连接层重试：反馈是 POST，重试会把同一条内容发两遍——用户看到
     * 「发送失败」再点一次，比静默重复更可控。
     *
     * @param {string} text
     * @returns {Promise<object>}
     */
    async function send(text) {
      const payload = buildFeedbackPayload({
        text,
        pluginId,
        pluginVersion: ctx.version,
        hostVersion: fbNetHostVersion(ctx),
      });
      try {
        const res = await fbNetTimeout(
          ctx.bridge.invoke("plugin_http_request", {
            method: "POST",
            url: endpoint + "/feedback",
            headers: { "Content-Type": "application/json", "User-Agent": userAgent() },
            body: JSON.stringify(payload),
          }),
          timeoutMs,
          "feedback",
        );
        return describeFeedbackResult({ status: Number(res && res.status) || 0, body: res && res.body });
      } catch (error) {
        return describeFeedbackResult({ error });
      }
    }

    /**
     * 查今天的剩余额度。失败时返回 `{offline: true}`——额度查不到不能挡住
     * 发反馈，但要让界面知道「是连不上」而不是「额度紧张」，两句话说给用户
     * 听的意思完全不同。
     *
     * @returns {Promise<{remaining: number, dailyLimit: number}|{offline: true}|null>}
     */
    async function quota() {
      try {
        const res = await fbNetTimeout(
          ctx.bridge.invoke("plugin_http_request", {
            method: "GET",
            url: endpoint + "/quota",
            headers: { "User-Agent": userAgent() },
            body: null,
          }),
          timeoutMs,
          "quota",
        );
        const status = Number(res && res.status) || 0;
        if (!(status >= 200 && status < 300)) return { offline: true };
        const body = res && typeof res.body === "string" ? res.body : "";
        // 劫持页、登录门户都返回 200 + HTML：JSON.parse 会抛，被外层 catch 接住，
        // 与「请求失败」同样按连不上处理——不需要单独再判一次。
        const data = body ? JSON.parse(body) : null;
        // 用 quotaCount 而不是 Number.isFinite(Number(...))：后者把 null/"" 读成 0，
        // 界面会说「今天的额度已用完」。
        const remaining = data ? quotaCount(data.remaining) : null;
        return remaining === null ? null : { remaining, dailyLimit: Number(data.dailyLimit) || 30 };
      } catch {
        return { offline: true };
      }
    }

    return { send, quota };
  }

  /* ---- 反馈区行为层：与 ccgui-plugin-github-trending/src/lib/feedback-ui.mjs 逐字相同 ---- */
  /**
   * 反馈区的行为层：状态、提交、额度、Issue 链接全在这里，四个插件共用。
   *
   * 为什么分成「行为 + 渲染」两步而不是一个组件：
   * - 每日热点 / 工作志 / 斜杠面板有 CSS 文件，类名各有前缀（gt- / wl- / sp-）；
   * - CLI 安装检测整套 UI 用内联 style，根本没有 CSS 文件。
   *
   * 所以这里只输出「长得一样」的元素树，类名与样式类由调用方传进来；
   * 内联 style 的那个插件可以只用 useFeedbackForm、自己写渲染。
   *
   * 逻辑部分原本在四个插件里各抄一份，而重复的恰好是最容易写错的那几段：
   * sendingRef 挡双击、成功后只清「这次发出去的那段」、额度不能被 null 读成 0。
   * 这些行为现在由 test/feedback-ui.test.mjs 逐个钉住。
   *
   * 依赖 feedback.mjs 的纯函数。内联进 main.js 后两者在同一作用域；
   * 单测里通过这条 import 直接解析。build.mjs 会剥掉这行 import。
   */


  /**
   * 反馈区的状态与动作。
   *
   * @param {{useState: Function, useRef: Function, useEffect: Function}} R React 子系统
   *   （插件里是 ctx.react，测试里是假 React 的 api）。
   * @param {object} opts
   * @param {string} opts.repo           Issue 落到哪个仓库（owner/name）。
   * @param {string} opts.pluginName     Issue 标题里的插件中文名。
   * @param {string} opts.pluginVersion  写进请求体与 Issue 的插件版本。
   * @param {string} [opts.hostVersion]  CC GUI 版本，取不到就留空。
   * @param {(text: string) => Promise<object>} opts.send
   * @param {() => Promise<object|null>} opts.quota
   * @returns {object} 状态 + 动作 + `render(h, styleOpts)`
   */
  function useFeedbackForm(R, opts) {
    const textState = R.useState("");
    const text = textState[0];
    const setText = textState[1];
    // "" -> "sending" -> "sent"/"error"
    const sendState = R.useState("");
    const sendStatus = sendState[0];
    const setSendStatus = sendState[1];
    const resultState = R.useState(null);
    const result = resultState[0];
    const setResult = resultState[1];
    const quotaState = R.useState(null);
    const quota = quotaState[0];
    const setQuota = quotaState[1];
    // 「只在挂载时查一次额度」的标志。用 ref 而不是 state：它只在 effect
    // 里读写，不该触发重渲染。
    const quotaTried = R.useRef(false);
    // 同步的在途标志。canSend 是渲染时的闭包值，同一 tick 内两次触发都会
    // 读到旧的 sendStatus=""，只在状态里防不住双击。
    const sendingRef = R.useRef(false);

    // 查不到就保持 {canRetry:true}，UI 说明是「连不上」而不是「额度紧张」
    // ——两句话对用户的意思完全不同。
    async function loadQuota() {
      const q = await opts.quota();
      setQuota(q);
      return q;
    }

    R.useEffect(() => {
      if (quotaTried.current) return;
      quotaTried.current = true;
      void loadQuota();
      // 只在挂载时查一次；之后由「重试」按钮或发送结果更新。
    }, []);

    const trimmed = normaliseFeedbackText(text);
    const canSend = trimmed.length > 0 && sendStatus !== "sending";

    const issueUrl = buildIssueUrl({
      repo: opts.repo,
      pluginName: opts.pluginName,
      text: trimmed,
      pluginVersion: opts.pluginVersion,
      hostVersion: opts.hostVersion || "",
    });

    async function submit() {
      // sendingRef 是同步的：同一 tick 内两次触发都会读到 true，挡住双击。
      // sendStatus 要等重渲染才更新，靠它挡不住。
      if (!canSend || sendingRef.current) return;
      sendingRef.current = true;
      const submitted = trimmed;
      setSendStatus("sending");
      setResult(null);

      let r;
      try {
        r = await opts.send(submitted);
      } finally {
        sendingRef.current = false;
      }

      setSendStatus(r.ok ? "sent" : "error");
      setResult(r);
      // 失败时正文原样留着：用户重打一遍比什么都糟。
      if (!r.ok) return;

      // 只清掉「这次发出去的那段」。发送期间用户可能又敲了内容（那几个请求
      // 往返里 textarea 没禁用），直接清空会把他新写的也抹掉。
      setText((cur) => (cur === submitted ? "" : cur));

      // 额度优先用服务端回传的真实值。查额度时失败了也不要紧——成功响应里
      // 带了 remaining，正好顺手把「暂时连不上」纠正过来。没有回传就自减一格。
      setQuota((prev) => nextQuota(prev, r.remaining));
    }

    /** 正文变化。重新输入等于开了一条新反馈，上一条的回执（成功或失败）都该撤掉。 */
    function changeText(value) {
      setText(value);
      if (sendStatus !== "sending") {
        setSendStatus("");
        setResult(null);
      }
    }

    const quotaText = describeQuota(quota);
    const statusText =
      sendStatus === "sending" ? "发送中…" : result ? result.message : "";
    // 成功时正文被清空，按钮会变成不可点的死按钮。若文案还停在「发送反馈」，
    // 用户看到的就是「点了没反应」——回执必须落在按钮自己身上。
    const sendLabel =
      sendStatus === "sending" ? "发送中…" : sendStatus === "sent" ? "已发送" : "发送反馈";

    /**
     * 渲染成元素树。
     *
     * @param {Function} h createElement
     * @param {object} [style]
     * @param {string} [style.prefix]      类名前缀，如 "gt"；产出 `${prefix}-feedback-*`
     * @param {number} [style.rows]        正文框行数
     * @param {string} [style.variant]     "section"（带 section 外壳）或 "bare"
     * @param {object} [style.classes]     各插件的样式类：input / primaryBtn /
     *   secondaryBtn / hint / note / linkBtn。缺省为空。
     */
    function render(h, style) {
      const s = style || {};
      const prefix = s.prefix || "fb";
      const rows = s.rows || 5;
      const c = s.classes || {};
      // 统一样式钩子（行为稳定、可被任何插件套）与各插件自己的样式类
      // （决定长什么样）拼在一起。两者都要，缺了哪一半都不行。
      const cls = (name, extra) => {
        const own = prefix + "-feedback-" + name;
        return extra ? own + " " + extra : own;
      };
      const join = (a, b) => (a && b ? a + " " + b : a || b || "");

      const head =
        s.variant === "section"
          ? h(
              "div",
              { className: prefix + "-section-label" },
              h("h2", null, "反馈"),
              h("p", null, "遇到问题或想提建议，两种方式任选其一。"),
            )
          : null;

      const body = [
        h("textarea", {
          className: cls("text", c.input),
          value: text,
          rows: rows,
          maxLength: TEXT_LIMIT,
          placeholder: "描述问题或建议…（最多 " + TEXT_LIMIT + " 字）",
          spellCheck: false,
          "aria-label": "反馈正文",
          onChange: (e) => changeText(e.target.value),
        }),
        h(
          "div",
          { className: cls("row") },
          h("span", { className: cls("count", c.hint) }, text.length + " / " + TEXT_LIMIT),
          h(
            "span",
            { className: cls("quota", c.hint) },
            quotaText.message,
            // 额度查不到 / 用完了都给一条重试路径，否则用户只能重开设置页。
            quotaText.canRetry
              ? h(
                  "button",
                  {
                    type: "button",
                    className: cls("quota-retry", c.linkBtn),
                    disabled: sendStatus === "sending",
                    onClick: () => void loadQuota(),
                  },
                  "重试",
                )
              : null,
          ),
        ),
        h(
          "div",
          { className: cls("actions") },
          h(
            "a",
            {
              className: join(
                cls("issue", c.secondaryBtn),
                // 正文为空时 Issue 链接仍可点，但看起来不该和「能发」时一样重。
                // 判断口径必须与 canSend 一致，所以这里用同一个 trimmed，
                // 不能让调用方自己再算一遍（那样两边迟早漂开）。
                trimmed ? "" : c.muted || "",
              ),
              href: issueUrl,
              target: "_blank",
              rel: "noreferrer noopener",
              title: "在浏览器里打开预填好的 Issue 页面",
            },
            "通过 GitHub 提 Issue",
          ),
          h(
            "button",
            {
              type: "button",
              className: cls("send", c.primaryBtn) + (sendStatus === "sent" ? " " + cls("sent") : ""),
              disabled: !canSend,
              onClick: () => void submit(),
            },
            sendLabel,
          ),
        ),
        statusText
          ? h(
              "p",
              {
                className:
                  cls("status", c.note) +
                  (sendStatus === "sent" ? " is-ok" : "") +
                  (sendStatus === "error" ? " is-bad" : ""),
                role: "status",
                "aria-live": "polite",
              },
              statusText,
            )
          : null,
        h(
          "p",
          { className: c.hint || "" },
          "发送的内容只有这段文字、插件版本与 CC GUI 版本。不含会话、代码或本机路径。",
        ),
      ].filter(Boolean);

      if (s.variant === "section") {
        return h(
          "section",
          { className: prefix + "-section" },
          head,
          h("div", { className: prefix + "-section-panel" }, body),
        );
      }
      return h("div", { className: prefix + "-feedback" }, body);
    }

    return {
      text,
      setText: changeText,
      sendStatus,
      result,
      quota,
      quotaText,
      canSend,
      submit,
      retryQuota: loadQuota,
      issueUrl,
      statusText,
      sendLabel,
      render,
    };
  }

  /** 宿主版本。老版本宿主可能没有这一项，取不到就留空，不能因此发不出反馈。 */
  function hostAppVersion() {
    try {
      return ctx && ctx.host && typeof ctx.host.appVersion === 'string' ? ctx.host.appVersion : '';
    } catch {
      return '';
    }
  }

  // 端点与插件 id 只从常量来，不可能出现「请求体是 A、User-Agent 是 B」的错位。
  const feedbackNet = createFeedbackNet(ctx, {
    endpoint: FEEDBACK_ENDPOINT,
    pluginId: PLUGIN_ID,
    timeoutMs: FEEDBACK_TIMEOUT_MS,
  });
  function sendFeedback(text) {
    return feedbackNet.send(text);
  }
  function fetchQuota() {
    return feedbackNet.quota();
  }

  // 会话内缓存：引擎列表 + 每个引擎的详情，设置页重挂载或切换回来都不重扫
  const cache = { engines: null, details: {}, savedAt: null };

  function toValidDate(v) {
    if (!v) return null;
    const ts = v instanceof Date ? v.getTime() : Date.parse(v);
    return Number.isFinite(ts) ? new Date(ts) : null;
  }

  // 缓存来自磁盘，字段一律按「可能缺失或损坏」处理
  function normalizeEngines(raw) {
    const out = [];
    for (const e of asArray(raw)) {
      if (!e || typeof e.id !== 'string' || !e.id) continue;
      out.push({
        id: e.id,
        label: String(e.label || e.id),
        cmds: asArray(e.cmds),
        resolved: asArray(e.resolved),
      });
    }
    return out;
  }

  // Date 序列化成 ISO 字符串存盘，读回时还原成 Date
  function normalizeDetails(raw) {
    const out = {};
    for (const [id, d] of Object.entries(raw || {})) {
      if (!d || typeof d !== 'object') continue;
      out[id] = d.engine ? { engine: d.engine, at: toValidDate(d.at) } : d;
    }
    return out;
  }

  // 返回写入成功的时间戳；失败返回 null，调用方据此决定是否更新「缓存于」
  async function persist() {
    if (!ctx.storage) return null;
    try {
      const details = {};
      for (const [id, d] of Object.entries(cache.details)) {
        if (!d) continue;
        const at = d.at instanceof Date && Number.isFinite(d.at.getTime()) ? d.at.toISOString() : null;
        details[id] = d.engine ? { engine: d.engine, at } : d;
      }
      const savedAt = Date.now();
      await ctx.storage.set(CACHE_KEY, {
        version: 1,
        engines: cache.engines,
        details,
        savedAt,
      });
      cache.savedAt = savedAt;
      return savedAt;
    } catch {
      // 存储不可用时静默降级为纯内存缓存
      return null;
    }
  }

  // 启动时恢复上次结果；不阻塞 activate，组件首次渲染时再等它
  const restorePromise = (async () => {
    if (!ctx.storage) return;
    try {
      const saved = await ctx.storage.get(CACHE_KEY);
      if (!saved || saved.version !== 1) return;
      const engines = normalizeEngines(saved.engines);
      if (engines.length === 0) return;
      cache.engines = engines;
      cache.details = normalizeDetails(saved.details);
      const ts = Number(saved.savedAt);
      cache.savedAt = Number.isFinite(ts) && ts > 0 ? ts : null;
    } catch {
      // 读不到就当没有缓存
    }
  })();

  async function exec(mode, engineId) {
    const r = await ctx.bridge.invoke('plugin_exec_run', {
      bin: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', toEncodedCommand(buildScript(mode, engineId))],
      timeoutMs: mode === 'discover' ? 30000 : 120000,
    });
    if (r && typeof r.code === 'number' && r.code !== 0) {
      throw new Error((r.stderr || '').trim() || 'powershell 退出码 ' + r.code);
    }
    const text = String((r && r.stdout) || '').replace(/^﻿/, '').trim();
    if (!text) throw new Error('没有拿到输出');
    return JSON.parse(text);
  }

  async function discover() {
    const d = await exec('discover', '');
    return asArray(d.engines).map((e) => ({
      ...e,
      cmds: asArray(e.cmds),
      resolved: asArray(e.resolved),
    }));
  }

  async function loadDetail(engineId) {
    const d = await exec('detail', engineId);
    if (d && d.error) throw new Error(d.error);
    if (!d || !d.engine) throw new Error('返回数据缺少 engine 字段');
    return {
      engine: {
        ...d.engine,
        cmds: asArray(d.engine.cmds),
        resolved: asArray(d.engine.resolved),
        installs: asArray(d.engine.installs),
      },
      at: new Date(),
    };
  }

  function engineVerdict(eng) {
    const installs = asArray(eng.installs);
    if (installs.length === 0) return { kind: 'missing', text: '未安装' };
    // 未解析的 .cmd/.bat wrapper 只是包装脚本，不参与一致性比较
    const solid = installs.filter((x) => x.kind !== 'shim' && x.sha256);
    if (solid.length === 0) return { kind: 'unknown', text: '无法读取文件' };
    const hashes = [...new Set(solid.map((x) => x.sha256))];
    const versions = [...new Set(solid.map((x) => x.version).filter(Boolean))];
    if (hashes.length === 1) return { kind: 'same', text: '一致' };
    if (versions.length === 1) return { kind: 'warn', text: '版本相同，文件不同' };
    return { kind: 'diverged', text: '版本分叉' };
  }

  const VERDICT = {
    same: { dot: '#22c55e' },
    warn: { dot: '#eab308' },
    diverged: { dot: '#ef4444' },
    unknown: { dot: '#94a3b8' },
    missing: { dot: '#cbd5e1' },
  };

  const OWNER = { ccgui: 'CC GUI', terminal: '终端', other: '其他' };
  const OWNER_ORDER = ['ccgui', 'terminal', 'other'];

  function ownerLabel(it) {
    const list = asArray(it.owners).filter((o) => typeof o === 'string');
    // 'other' 只是兜底分类，有明确归属时不展示
    const meaningful = list.filter((o) => o !== 'other');
    const use = meaningful.length > 0 ? meaningful : list;
    return use
      .sort((a, b) => OWNER_ORDER.indexOf(a) - OWNER_ORDER.indexOf(b))
      .map((o) => OWNER[o] || o)
      .join(' + ');
  }

  function FeedbackPanel() {
    // 这个插件整套 UI 用内联 style（没有 CSS 文件），所以这里只取共用的
    // 行为层、自己写渲染——渲染层是给有 CSS 的插件用的，套到这里会把
    // 内联 style 变成一堆参数。
    const form = useFeedbackForm(ctx.react, {
      repo: FEEDBACK_REPO,
      pluginName: PLUGIN_NAME,
      pluginVersion: ctx.version,
      hostVersion: hostAppVersion(),
      send: (text) => sendFeedback(text),
      quota: () => fetchQuota(),
    });

    const t = {
      border: 'var(--color-separator-border, rgba(127,127,127,0.3))',
      text: 'var(--color-text-primary, inherit)',
      text3: 'var(--color-text-tertiary, inherit)',
      accent: 'var(--color-accent-primary-default, #3b82f6)',
      ok: 'var(--color-text-success, #2e7d32)',
      bad: 'var(--color-text-danger, #c4242a)',
    };

    const btnStyle = {
      height: 30,
      padding: '0 10px',
      borderRadius: 7,
      border: '1px solid ' + (form.sendStatus === 'sent' ? t.ok : t.border),
      background: 'transparent',
      color: form.sendStatus === 'sent' ? t.ok : 'inherit',
      cursor: form.canSend ? 'pointer' : 'not-allowed',
      fontSize: 12,
      lineHeight: 1,
      // :disabled 的透明度会把它糊成灰色，成功态要压回 1
      opacity: form.sendStatus === 'sent' ? 1 : form.canSend ? 1 : 0.45,
    };

    return h(
      'div',
      { style: { marginTop: 14, color: t.text } },
      h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, '反馈'),
      h(
        'div',
        { style: { color: t.text3, fontSize: 12, marginBottom: 8 } },
        '遇到问题或想提建议，两种方式任选其一。发送的内容只有这段文字、插件版本与 CC GUI 版本，不含会话、代码或本机路径。',
      ),
      h('textarea', {
        className: 'cli-audit-feedback-text',
        value: form.text,
        rows: 4,
        maxLength: TEXT_LIMIT,
        placeholder: '描述问题或建议…（最多 ' + TEXT_LIMIT + ' 字）',
        spellCheck: false,
        'aria-label': '反馈正文',
        style: {
          width: '100%',
          minHeight: 84,
          boxSizing: 'border-box',
          resize: 'vertical',
          padding: '8px 10px',
          border: '1px solid ' + t.border,
          borderRadius: 7,
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          fontSize: 12,
          lineHeight: 1.6,
        },
        onChange: (e) => form.setText(e.target.value),
      }),
      h(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 4 } },
        h(
          'span',
          { className: 'cli-audit-feedback-count', style: { color: t.text3, fontSize: 12 } },
          form.text.length + ' / ' + TEXT_LIMIT,
        ),
        h(
          'span',
          { className: 'cli-audit-feedback-quota', style: { color: t.text3, fontSize: 12, textAlign: 'right' } },
          form.quotaText.message,
          // 额度查不到 / 用完了都给一条重试路径，否则用户只能重开设置页。
          form.quotaText.canRetry
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'cli-audit-feedback-quota-retry',
                  disabled: form.sendStatus === 'sending',
                  onClick: () => void form.retryQuota(),
                  style: {
                    marginLeft: 6,
                    padding: 0,
                    border: 0,
                    background: 'none',
                    font: 'inherit',
                    fontSize: 12,
                    color: t.accent,
                    textDecoration: 'underline',
                    cursor: 'pointer',
                  },
                },
                '重试',
              )
            : null,
        ),
      ),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
        h(
          'a',
          {
            className: 'cli-audit-feedback-issue',
            href: form.issueUrl,
            target: '_blank',
            rel: 'noreferrer noopener',
            title: '在浏览器里打开预填好的 Issue 页面',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              height: 30,
              boxSizing: 'border-box',
              padding: '0 10px',
              borderRadius: 7,
              border: '1px solid ' + t.border,
              color: 'inherit',
              fontSize: 12,
              lineHeight: 1,
              textDecoration: 'none',
            },
          },
          '通过 GitHub 提 Issue',
        ),
        h(
          'button',
          {
            type: 'button',
            className:
              'cli-audit-feedback-send' + (form.sendStatus === 'sent' ? ' cli-audit-feedback-sent' : ''),
            disabled: !form.canSend,
            onClick: () => void form.submit(),
            style: btnStyle,
          },
          form.sendLabel,
        ),
      ),
      form.statusText
        ? h(
            'div',
            {
              className: 'cli-audit-feedback-status',
              role: 'status',
              'aria-live': 'polite',
              style: {
                marginTop: 8,
                fontSize: 12,
                lineHeight: 1.6,
                color: form.sendStatus === 'sent' ? t.ok : form.sendStatus === 'error' ? t.bad : t.text3,
                fontWeight: form.sendStatus === 'sent' ? 500 : 400,
              },
            },
            form.statusText,
          )
        : null,
    );
  }

  function SettingsPanel() {
    const [engines, setEngines] = useState(cache.engines || []);
    const [discoverPhase, setDiscoverPhase] = useState(cache.engines ? 'done' : 'idle');
    const [selectedId, setSelectedId] = useState('');
    const [details, setDetails] = useState(cache.details);
    const [savedAt, setSavedAt] = useState(cache.savedAt);
    const [runningId, setRunningId] = useState(null);
    const [error, setError] = useState(null);
    const [pickerFocused, setPickerFocused] = useState(false);
    const [open, setOpen] = useState(false);
    const [hoverId, setHoverId] = useState(null);
    const [focusIdx, setFocusIdx] = useState(0);
    const [batch, setBatch] = useState(null);
    const [hoverBtn, setHoverBtn] = useState(null);

    const runDiscover = useCallback(async () => {
      setDiscoverPhase('running');
      setError(null);
      try {
        const list = await discover();
        cache.engines = list;
        // 重新发现后已经不存在的引擎，旧详情必须失效，
        // 否则会同时显示「未安装」和上一次的版本/哈希
        const live = new Set(list.filter((e) => e.resolved.length > 0).map((e) => e.id));
        for (const id of Object.keys(cache.details)) {
          if (!live.has(id)) delete cache.details[id];
        }
        setEngines(list);
        setDetails({ ...cache.details });
        setDiscoverPhase('done');
        const ordered = sortEngines(list);
        setSelectedId((prev) => {
          if (prev && ordered.some((e) => e.id === prev)) return prev;
          return ordered[0] ? ordered[0].id : '';
        });
        void persist().then((ts) => {
          if (ts) setSavedAt(ts);
        });
      } catch (e) {
        setError(String((e && e.message) || e));
        setDiscoverPhase('error');
      }
    }, []);

    useEffect(() => {
      if (cache.engines) return;
      let alive = true;
      void restorePromise.then(() => {
        if (!alive) return;
        if (cache.engines) {
          setEngines(cache.engines);
          setDiscoverPhase('done');
          setDetails({ ...cache.details });
          setSavedAt(cache.savedAt);
          setSelectedId(sortEngines(cache.engines)[0]?.id || '');
        } else {
          void runDiscover();
        }
      });
      return () => {
        alive = false;
      };
    }, [runDiscover]);

    const runDetail = useCallback(async (id, force) => {
      if (!id) return;
      if (!force && cache.details[id] && cache.details[id].engine) {
        setDetails({ ...cache.details });
        return;
      }
      setRunningId(id);
      try {
        const d = await loadDetail(id);
        cache.details[id] = d;
        setDetails({ ...cache.details });
        void persist().then((ts) => {
          if (ts) setSavedAt(ts);
        });
      } catch (e) {
        cache.details[id] = { error: String((e && e.message) || e) };
        setDetails({ ...cache.details });
      } finally {
        setRunningId((cur) => (cur === id ? null : cur));
      }
    }, []);

    const t = {
      border: 'var(--color-separator-border, rgba(127,127,127,0.3))',
      cardBg: 'var(--color-background-secondary-default, rgba(127,127,127,0.06))',
      text: 'var(--color-text-primary, inherit)',
      text2: 'var(--color-text-secondary, inherit)',
      text3: 'var(--color-text-tertiary, inherit)',
      hover: 'var(--color-background-tertiary-hover, rgba(127,127,127,0.15))',
      mono: 'ui-monospace, Consolas, "Courier New", monospace',
    };

    const style = {
      root: { fontSize: 13, lineHeight: 1.6, color: t.text },
      head: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
      hint: { color: t.text3, fontSize: 12, marginBottom: 10 },
      card: {
        border: '1px solid ' + t.border,
        borderRadius: 8,
        padding: '9px 11px',
        marginBottom: 10,
        background: t.cardBg,
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      dot: { width: 8, height: 8, borderRadius: 4, flex: 'none' },
      path: { fontFamily: t.mono, fontSize: 11, wordBreak: 'break-all', color: t.text2 },
      meta: { color: t.text3, fontSize: 12 },
      btn: {
        height: 30,
        padding: '0 10px',
        borderRadius: 7,
        border: '1px solid ' + t.border,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 12,
        lineHeight: 1,
        transition: 'background 120ms ease, opacity 120ms ease',
      },
      trigger: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 30,
        minWidth: 200,
        maxWidth: 280,
        padding: '0 10px',
        borderRadius: 7,
        border: '1px solid ' + (open || pickerFocused ? 'var(--color-accent-primary-default, #3b82f6)' : t.border),
        background: open ? t.hover : 'transparent',
        color: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
        outline: 'none',
        textAlign: 'left',
        transition: 'border-color 120ms ease, background 120ms ease',
      },
      triggerText: {
        flex: '1 1 auto',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      caret: {
        flex: 'none',
        fontSize: 8,
        lineHeight: 1,
        color: t.text3,
        transform: open ? 'rotate(180deg)' : 'none',
        transition: 'transform 120ms ease',
      },
      dropdown: {
        position: 'relative',
        display: 'inline-flex',
      },
      menu: {
        position: 'absolute',
        top: 'calc(100% + 6px)',
        left: 0,
        zIndex: 50,
        minWidth: '100%',
        width: 'max-content',
        maxWidth: 320,
        padding: 4,
        background: 'var(--color-background-secondary-default, #242a35)',
        color: 'var(--color-text-primary, inherit)',
        border: '1px solid ' + t.border,
        borderRadius: 8,
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
      },
      groupTitle: {
        padding: '6px 8px 2px',
        fontSize: 11,
        color: t.text3,
        userSelect: 'none',
      },
      menuItem: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 28,
        padding: '0 8px',
        borderRadius: 6,
        cursor: 'pointer',
        fontSize: 12,
      },
      btnPrimary: {
        height: 30,
        padding: '0 14px',
        borderRadius: 7,
        border: '1px solid transparent',
        background: 'var(--color-accent-primary-default, #3b82f6)',
        color: '#fff',
        cursor: 'pointer',
        fontSize: 12,
        fontWeight: 500,
        transition: 'opacity 120ms ease, filter 120ms ease',
      },
    };

    const ordered = sortEngines(engines);
    const installedList = ordered.filter((e) => e.resolved.length > 0);
    const missingList = ordered.filter((e) => e.resolved.length === 0);
    const installedCount = installedList.length;
    const selected = ordered.find((e) => e.id === selectedId) || null;
    const detail = selectedId ? details[selectedId] : null;
    const isRunning = runningId === selectedId;
    const hasResult = !!(detail && detail.engine);
    const batchRunning = batch !== null;
    const discoverDisabled = discoverPhase === 'running' || batchRunning;
    const batchDisabled = batchRunning || installedCount === 0 || discoverPhase === 'running';
    const detailDisabled = isRunning || batchRunning;

    const btnHover = (id, disabled) => ({
      onMouseEnter: () => {
        if (!disabled) setHoverBtn(id);
      },
      onMouseLeave: () => setHoverBtn((cur) => (cur === id ? null : cur)),
    });
    const hoverBg = (id, disabled) => (!disabled && hoverBtn === id ? t.hover : 'transparent');

    const menuOrder = [...installedList, ...missingList];
    const selectedIdx = Math.max(0, menuOrder.findIndex((e) => e.id === selectedId));

    function focusOption(idx) {
      const e = menuOrder[idx];
      if (!e || typeof document === 'undefined') return;
      const el = document.getElementById('cli-audit-opt-' + e.id);
      if (el && typeof el.focus === 'function') el.focus();
    }

    function focusTrigger() {
      if (typeof document === 'undefined') return;
      const el = document.querySelector('[data-role="engine-trigger"]');
      if (el && typeof el.focus === 'function') el.focus();
    }

    function openMenu() {
      setFocusIdx(selectedIdx);
      setOpen(true);
    }

    function chooseEngine(e) {
      setOpen(false);
      setHoverId(null);
      if (e.id !== selectedId) setSelectedId(e.id);
      void runDetail(e.id, false);
    }

    // 串行刷新所有已安装引擎，避免同时拉起多个 PowerShell
    async function runAll() {
      const targets = installedList.map((e) => e.id);
      if (targets.length === 0) return;
      setBatch({ done: 0, total: targets.length });
      for (let i = 0; i < targets.length; i++) {
        await runDetail(targets[i], true);
        setBatch({ done: i + 1, total: targets.length });
      }
      setBatch(null);
    }

    useEffect(() => {
      if (!open) return;
      focusOption(focusIdx);
    }, [open]);

    const head = h(
      'div',
      { style: style.head },
      h('style', null, UI_CSS),
      h('span', { style: { fontWeight: 600 } }, 'CLI 安装检测'),
      h(
        'button',
        {
          style: {
            ...style.btn,
            marginLeft: 'auto',
            background: hoverBg('discover', discoverDisabled),
            opacity: discoverDisabled ? 0.55 : 1,
            cursor: discoverDisabled ? 'not-allowed' : 'pointer',
          },
          disabled: discoverDisabled,
          ...btnHover('discover', discoverDisabled),
          onClick: () => void runDiscover(),
        },
        h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
          discoverPhase === 'running' && h('span', { className: 'cli-audit-spinner' }),
          discoverPhase === 'running' ? '扫描中…' : '重新发现',
        ),
      ),
    );

    const hint = h(
      'div',
      { style: style.hint },
      '先只检查命令是否存在，选中引擎后才读取版本、SHA256 与运行中进程。',
    );

    // 早期 return 的分支（扫描中 / 扫描失败 / 空闲骨架）也要带上反馈区：
    // 「扫描失败」恰恰是最需要用户反馈的场景，不能因为提前 return 就把入口藏掉。
    const feedback = h(FeedbackPanel, null);

    if ((discoverPhase === 'running' || discoverPhase === 'idle') && engines.length === 0) {
      return h(
        'div',
        { style: style.root },
        head,
        hint,
        h(
          'div',
          { className: 'cli-audit-fade', style: style.card },
          h(
            'div',
            { style: { ...style.row, marginBottom: 10 } },
            h('span', { className: 'cli-audit-spinner' }),
            h(
              'span',
              { style: style.meta },
              discoverPhase === 'idle' ? '正在读取上次结果…' : '正在扫描 PATH…',
            ),
          ),
          h('div', { className: 'cli-audit-skeleton', style: { width: '38%', marginBottom: 7 } }),
          h('div', { className: 'cli-audit-skeleton', style: { width: '64%', marginBottom: 7 } }),
          h('div', { className: 'cli-audit-skeleton', style: { width: '52%' } }),
        ),
        feedback,
      );
    }

    if (discoverPhase === 'error') {
      return h(
        'div',
        { style: style.root },
        head,
        hint,
        h(
          'div',
          { style: style.card },
          h(
            'div',
            { style: style.row },
            h('span', { style: { ...style.dot, background: VERDICT.diverged.dot } }),
            h('span', null, '扫描失败：' + error),
          ),
        ),
        feedback,
      );
    }

    const summaryDot =
      installedCount > 0 ? VERDICT.same.dot : VERDICT.missing.dot;

    const menuItem = (e, idx) => {
      const active = e.id === selectedId;
      const hovered = hoverId === e.id;
      return h(
        'div',
        {
          key: e.id,
          id: 'cli-audit-opt-' + e.id,
          'data-engine': e.id,
          role: 'option',
          'aria-selected': active,
          tabIndex: idx === focusIdx ? 0 : -1,
          onMouseEnter: () => setHoverId(e.id),
          onMouseLeave: () => setHoverId((cur) => (cur === e.id ? null : cur)),
          onFocus: () => setFocusIdx(idx),
          onKeyDown: (ev) => {
            if (ev.key === 'ArrowDown') {
              ev.preventDefault();
              const n = Math.min(menuOrder.length - 1, idx + 1);
              setFocusIdx(n);
              focusOption(n);
            } else if (ev.key === 'ArrowUp') {
              ev.preventDefault();
              const n = Math.max(0, idx - 1);
              setFocusIdx(n);
              focusOption(n);
            } else if (ev.key === 'Home') {
              ev.preventDefault();
              setFocusIdx(0);
              focusOption(0);
            } else if (ev.key === 'End') {
              ev.preventDefault();
              const n = menuOrder.length - 1;
              setFocusIdx(n);
              focusOption(n);
            } else if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              chooseEngine(e);
            } else if (ev.key === 'Escape') {
              ev.preventDefault();
              setOpen(false);
              focusTrigger();
            } else if (ev.key === 'Tab') {
              setOpen(false);
            }
          },
          onClick: () => chooseEngine(e),
          style: {
            ...style.menuItem,
            background: hovered
              ? 'var(--color-background-tertiary-hover, rgba(127,127,127,0.15))'
              : active
                ? 'var(--color-background-tertiary-default, rgba(127,127,127,0.1))'
                : 'transparent',
            color: 'inherit',
            fontWeight: active ? 500 : 400,
          },
        },
        h(
          'span',
          {
            style: {
              width: 12,
              flex: 'none',
              opacity: active ? 1 : 0,
              color: 'var(--color-accent-primary-default, #3b82f6)',
              fontSize: 11,
            },
          },
          '✓',
        ),
        h('span', { style: { flex: '1 1 auto' } }, e.label),
      );
    };

    const menuBody = [];
    let menuIdx = 0;
    if (installedList.length > 0) {
      menuBody.push(h('div', { key: 'h-on', style: style.groupTitle }, '已安装'));
      for (const e of installedList) menuBody.push(menuItem(e, menuIdx++));
    }
    if (missingList.length > 0) {
      menuBody.push(h('div', { key: 'h-off', style: style.groupTitle }, '未安装'));
      for (const e of missingList) menuBody.push(menuItem(e, menuIdx++));
    }

    const picker = h(
      'div',
      { style: { ...style.card, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
      h('span', { style: { ...style.meta, flex: 'none' } }, '引擎'),
      h(
        'div',
        { style: style.dropdown },
        h(
          'button',
          {
            type: 'button',
            'data-role': 'engine-trigger',
            'aria-haspopup': 'listbox',
            'aria-expanded': open,
            'aria-controls': open ? 'cli-audit-engine-menu' : undefined,
            style: {
              ...style.trigger,
              background:
                open || (!batchRunning && hoverBtn === 'trigger') ? t.hover : 'transparent',
              opacity: batchRunning ? 0.55 : 1,
              cursor: batchRunning ? 'not-allowed' : 'pointer',
            },
            disabled: batchRunning,
            ...btnHover('trigger', batchRunning),
            onFocus: () => setPickerFocused(true),
            onBlur: () => setPickerFocused(false),
            onClick: () => {
              if (open) setOpen(false);
              else openMenu();
            },
            onKeyDown: (ev) => {
              if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                ev.preventDefault();
                if (!open) openMenu();
              } else if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                if (open) setOpen(false);
                else openMenu();
              } else if (ev.key === 'Escape' && open) {
                ev.preventDefault();
                setOpen(false);
              }
            },
          },
          h('span', { style: style.triggerText }, selected ? selected.label : '选择引擎'),
          h('span', { style: style.caret }, '▼'),
        ),
        open &&
          h(
            'div',
            {
              id: 'cli-audit-engine-menu',
              className: 'cli-audit-menu',
              style: style.menu,
              role: 'listbox',
              'data-role': 'engine-menu',
              'aria-activedescendant': menuOrder[focusIdx]
                ? 'cli-audit-opt-' + menuOrder[focusIdx].id
                : undefined,
            },
            menuBody,
          ),
      ),
      h(
        'button',
        {
          type: 'button',
          'data-role': 'batch-run',
          style: {
            ...style.btn,
            marginLeft: 'auto',
            background: hoverBg('batch', batchDisabled),
            opacity: batchDisabled ? 0.55 : 1,
            cursor: batchDisabled ? 'not-allowed' : 'pointer',
          },
          disabled: batchDisabled,
          ...btnHover('batch', batchDisabled),
          onClick: () => void runAll(),
        },
        h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
          batchRunning && h('span', { className: 'cli-audit-spinner' }),
          batchRunning ? '检测中 ' + batch.done + '/' + batch.total : '全部检测',
        ),
      ),
      h(
        'button',
        {
          style: {
            ...style.btnPrimary,
            opacity: detailDisabled ? 0.55 : 1,
            cursor: detailDisabled ? 'not-allowed' : 'pointer',
            filter: !detailDisabled && hoverBtn === 'detail' ? 'brightness(0.94)' : 'none',
          },
          disabled: detailDisabled,
          ...btnHover('detail', detailDisabled),
          onClick: () => void runDetail(selectedId, hasResult),
        },
        h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
          isRunning && !batchRunning && h('span', { className: 'cli-audit-spinner' }),
          isRunning && !batchRunning ? '检测中…' : hasResult ? '重新检测' : '检测',
        ),
      ),
      // 点击任意空白处收起下拉
      open &&
        h('div', {
          style: { position: 'fixed', inset: 0, zIndex: 40 },
          onClick: () => setOpen(false),
        }),
    );

    let body = null;

    if (!selected) {
      body = null;
    } else if (isRunning && !detail) {
      body = h(
        'div',
        { key: 'detail-loading', className: 'cli-audit-fade', style: style.card },
        h(
          'div',
          { style: { ...style.row, marginBottom: 10 } },
          h('span', { className: 'cli-audit-spinner' }),
          h('span', { style: style.meta }, '正在读取 ' + selected.label + ' 的版本与文件哈希…'),
        ),
        h('div', { className: 'cli-audit-skeleton', style: { width: '42%', marginBottom: 7 } }),
        h('div', { className: 'cli-audit-skeleton', style: { width: '68%', marginBottom: 7 } }),
        h('div', { className: 'cli-audit-skeleton', style: { width: '55%' } }),
      );
    } else if (detail && detail.error) {
      body = h(
        'div',
        { key: 'detail-error', className: 'cli-audit-fade', style: style.card },
        h(
          'div',
          { style: style.row },
          h('span', { style: { ...style.dot, background: VERDICT.diverged.dot } }),
          h('span', null, '检测失败：' + detail.error),
        ),
      );
    } else if (detail && detail.engine) {
      const eng = detail.engine;
      const installs = asArray(eng.installs);
      const v = engineVerdict(eng);

      body = h(
        'div',
        {
          key: 'detail-' + selectedId + '-' + (detail.at ? detail.at.getTime() : 'na'),
          className: 'cli-audit-fade',
          style: style.card,
        },
        h(
          'div',
          { style: style.row },
          h('span', { style: { fontWeight: 600 } }, eng.label),
          h('span', { style: { ...style.dot, background: VERDICT[v.kind].dot } }),
          h('span', null, v.text),
          installs.length > 0 &&
            h('span', { style: { ...style.meta, marginLeft: 'auto' } }, installs.length + ' 个入口'),
        ),

        installs.length === 0 &&
          h(
            'div',
            { style: { ...style.meta, marginTop: 2 } },
            '探测命令：' + asArray(eng.cmds).join(', ') + '（PATH 中没有找到）',
          ),

        installs.map((it, i) =>
          h(
            'div',
            { key: 'i' + i, style: { marginTop: 8 } },
            h(
              'div',
              { style: style.row },
              h(
                'span',
                { style: { fontWeight: 500 } },
                it.kind === 'shim' ? '(未解析的 shim)' : it.version || '(版本未读取)',
              ),
              h('span', { style: style.meta }, fmtSize(it.size)),
              it.processCount > 0 &&
                h(
                  'span',
                  { style: style.meta },
                  '运行中 ×' + it.processCount + (ownerLabel(it) ? ' · ' + ownerLabel(it) : ''),
                ),
              h('span', { style: { ...style.meta, marginLeft: 'auto' } }, shortHash(it.sha256)),
            ),
            h('div', { style: style.path }, it.target),
            it.entry !== it.target &&
              h('div', { style: { ...style.path, color: t.text3 } }, '入口：' + it.entry),
            it.kind === 'shim' &&
              h(
                'div',
                { style: { ...style.meta, color: t.text3 } },
                '无法解析 .cmd/.bat 的真实入口，哈希按 wrapper 文件计算',
              ),
          ),
        ),

        detail.at &&
          h(
            'div',
            { style: { ...style.meta, marginTop: 8 } },
            '检测于 ' + detail.at.toLocaleString(),
          ),
      );
    } else {
      body = h(
        'div',
        { key: 'detail-empty-' + selectedId, className: 'cli-audit-fade', style: style.card },
        h(
          'div',
          { style: style.meta },
          selected.resolved.length > 0
            ? '已找到 ' + selected.resolved.join(', ') + '，点击「检测」读取详情。'
            : '探测命令：' + asArray(selected.cmds).join(', ') + '（PATH 中没有找到）',
        ),
      );
    }

    return h(
      'div',
      { style: style.root },
      head,
      hint,

      h(
        'div',
        { style: style.card },
        h(
          'div',
          { style: style.row },
          h('span', { style: { ...style.dot, background: summaryDot } }),
          h('span', { style: { fontWeight: 600 } }, installedCount + ' / ' + engines.length + ' 个引擎已安装'),
          savedAt &&
            h(
              'span',
              { style: { ...style.meta, marginLeft: 'auto' } },
              '缓存于 ' + new Date(savedAt).toLocaleString(),
            ),
        ),
      ),

      picker,
      body,
      feedback,
    );
  }

  // 宿主注册入口时会返回一个注销函数。收起来统一在卸载时调用，
  // 否则插件被停用/重装后旧组件的注册还挂在宿主上。
  const disposers = [];
  const remember = (d) => {
    if (typeof d === 'function') disposers.push(d);
    return d;
  };

  remember(
    ctx.ui.registerSettingsSection({
      key: 'diagnostics',
      label: () => 'CLI 安装检测',
      component: SettingsPanel,
    }),
  );

  remember(
    ctx.ui.registerCommand({
      key: 'cli-install-audit.open',
      title: () => 'CLI 安装检测',
      keywords: () => ['cli', 'install', 'audit', 'sha256', 'claude', 'codex', 'opencode', '安装', '版本'],
      run: () => {
        ctx.ui.openSettings('diagnostics');
      },
    }),
  );

  return () => {
    for (const d of disposers) {
      try {
        d();
      } catch {
        // 卸载单个入口失败不影响其余清理
      }
    }
  };
}

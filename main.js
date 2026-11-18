// 引擎清单：id 来自 ccgui-next.exe 的 AgentFrameProviderSection 枚举，
// 候选命令名参考宿主的 npm/CLI 搜索目录常量（.codex-cli\bin、.omp\bin、OpenAI\Codex\bin 等）。
// 名字对不上时只会显示「未安装」，不会误报。
const ENGINES = [
  { id: 'claude', label: 'Claude Code', cmds: ['claude'] },
  { id: 'codex', label: 'Codex', cmds: ['codex', 'codex-cli'] },
  { id: 'opencode', label: 'OpenCode', cmds: ['opencode'] },
  { id: 'qoder', label: 'Qoder', cmds: ['qoder'] },
  { id: 'qoder-cn', label: 'Qoder (CN)', cmds: ['qoder-cn', 'qoder'] },
  { id: 'kimi', label: 'Kimi CLI', cmds: ['kimi'] },
  { id: 'grok', label: 'Grok CLI', cmds: ['grok'] },
  { id: 'codebuddy', label: 'CodeBuddy', cmds: ['codebuddy'] },
  { id: 'minimax', label: 'MiniMax', cmds: ['minimax'] },
  { id: 'omp', label: 'OMP', cmds: ['omp'] },
  { id: 'dsh', label: 'DSH', cmds: ['dsh'] },
  { id: 'agy', label: 'AGY', cmds: ['agy'] },
  { id: 'pi', label: 'Pi', cmds: ['pi', 'hermes'] },
];

const PS_TEMPLATE = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$engineDefs = '@@ENGINES@@' | ConvertFrom-Json

$out = [ordered]@{
  processCount = 0
  engines      = @()
}

# 进程快照：同时用于父进程链回溯与运行中分组
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
$out.processCount = $procGroups.Count

function Resolve-Shim([string]$p) {
  $dir = Split-Path -Parent $p
  $raw = Get-Content -LiteralPath $p -Raw -ErrorAction SilentlyContinue
  if (-not $raw) { return $null }
  $t = $raw -replace '(?i)%~dp0\\?', ($dir + '\')
  $t = $t -replace '(?i)%dp0%\\?', ($dir + '\')
  $m = [regex]::Match($t, '"([^"\r\n]+?\.exe)"')
  if (-not $m.Success) { $m = [regex]::Match($t, '([A-Za-z]:\\[^"\r\n]+?\.exe)') }
  if (-not $m.Success) { return $null }
  $cand = $m.Groups[1].Value
  if (Test-Path -LiteralPath $cand) { return $cand }
  return $null
}

# 带超时的版本读取，避免某个 CLI 不支持 --version 时卡住整次检测
function Get-CliVersion([string]$exe) {
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = '--version'
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    if ($proc.WaitForExit(4000)) {
      $so = $proc.StandardOutput.ReadToEnd()
      $se = $proc.StandardError.ReadToEnd()
      $text = ([string]$so + ' ' + [string]$se).Trim()
      if ($text) {
        $line = ($text -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -First 1)
        if ($line) { return [string]$line.Trim() }
      }
    } else {
      try { $proc.Kill() } catch {}
    }
  } catch {}
  return $null
}

$hashCache = @{}
$verCache = @{}

foreach ($def in $engineDefs) {
  $installs = @()
  $seen = @{}
  $resolvedCmds = @()

  foreach ($cmd in @($def.cmds)) {
    $found = @(Get-Command $cmd -All -ErrorAction SilentlyContinue)
    if ($found.Count -gt 0) { $resolvedCmds += [string]$cmd }

    foreach ($c in $found) {
      $src = $null
      if ($c.Source) { $src = [string]$c.Source }
      elseif ($c.Path) { $src = [string]$c.Path }
      if (-not $src) { continue }
      if ($src -notmatch '\.(exe|cmd|bat)$') { continue }
      if (-not (Test-Path -LiteralPath $src)) { continue }

      $target = $src
      if ($src -match '\.(cmd|bat)$') {
        $rs = Resolve-Shim $src
        if ($rs) { $target = $rs }
      }
      $key = $target.ToLowerInvariant()
      if ($seen.ContainsKey($key)) { continue }
      $seen[$key] = $true

      if (-not $verCache.ContainsKey($key)) {
        $verCache[$key] = $(if ($target -match '\.exe$') { Get-CliVersion $target } else { $null })
      }
      if (-not $hashCache.ContainsKey($key)) {
        try { $hashCache[$key] = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower() }
        catch { $hashCache[$key] = $null }
      }

      $size = 0
      try { $size = [long](Get-Item -LiteralPath $target).Length } catch {}

      $pg = $procGroups[$key]
      $ownerList = @()
      $pc = 0
      if ($pg) { $pc = [int]$pg.count; $ownerList = @($pg.owners) }

      $installs += [ordered]@{
        entry        = $src
        target       = $target
        version      = $verCache[$key]
        sha256       = $hashCache[$key]
        size         = $size
        processCount = $pc
        owners       = [object[]]$ownerList
      }
    }
  }

  $out.engines += [ordered]@{
    id       = [string]$def.id
    label    = [string]$def.label
    cmds     = [object[]]@($def.cmds)
    resolved = [object[]]$resolvedCmds
    installs = [object[]]$installs
  }
}

$out | ConvertTo-Json -Depth 8 -Compress
`;

function buildScript() {
  const defs = ENGINES.map((e) => ({ id: e.id, label: e.label, cmds: e.cmds }));
  return PS_TEMPLATE.replace('@@ENGINES@@', JSON.stringify(defs));
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

function fmtSize(n) {
  if (!n) return '-';
  return (n / 1024 / 1024).toFixed(1) + ' MiB';
}

function shortHash(h) {
  if (!h) return '(读取失败)';
  return h.slice(0, 12) + '…';
}

export default function activate(ctx) {
  const { createElement: h, useState, useEffect, useCallback } = ctx.react;

  let autoRan = false;
  let cache = null;

  async function runAudit() {
    const r = await ctx.bridge.invoke('plugin_exec_run', {
      bin: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', toEncodedCommand(buildScript())],
      timeoutMs: 120000,
    });
    if (r && typeof r.code === 'number' && r.code !== 0) {
      throw new Error((r.stderr || '').trim() || 'powershell 退出码 ' + r.code);
    }
    const text = String((r && r.stdout) || '').replace(/^﻿/, '').trim();
    if (!text) throw new Error('没有拿到输出');
    const data = JSON.parse(text);
    data.engines = asArray(data.engines).map((e) => ({
      ...e,
      cmds: asArray(e.cmds),
      resolved: asArray(e.resolved),
      installs: asArray(e.installs),
    }));
    return data;
  }

  function engineVerdict(eng) {
    const installs = asArray(eng.installs);
    if (installs.length === 0) return { kind: 'missing', text: '未安装' };
    const hashes = [...new Set(installs.map((x) => x.sha256).filter(Boolean))];
    const versions = [...new Set(installs.map((x) => x.version).filter(Boolean))];
    if (hashes.length === 0) return { kind: 'unknown', text: '无法读取文件' };
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
    return asArray(it.owners)
      .filter((o) => typeof o === 'string')
      .sort((a, b) => OWNER_ORDER.indexOf(a) - OWNER_ORDER.indexOf(b))
      .map((o) => OWNER[o] || o)
      .join(' + ');
  }

  function SettingsPanel() {
    const [phase, setPhase] = useState(cache ? 'done' : 'idle');
    const [data, setData] = useState(cache ? cache.data : null);
    const [error, setError] = useState(null);
    const [checkedAt, setCheckedAt] = useState(cache ? cache.checkedAt : null);

    const refresh = useCallback(async () => {
      setPhase('running');
      setError(null);
      try {
        const d = await runAudit();
        const at = new Date();
        cache = { data: d, checkedAt: at };
        setData(d);
        setCheckedAt(at);
        setPhase('done');
      } catch (e) {
        setError(String((e && e.message) || e));
        setPhase('error');
      }
    }, []);

    useEffect(() => {
      if (autoRan) return;
      autoRan = true;
      void refresh();
    }, [refresh]);

    const t = {
      border: 'var(--color-separator-border, rgba(127,127,127,0.3))',
      cardBg: 'var(--color-background-secondary-default, rgba(127,127,127,0.06))',
      text: 'var(--color-text-primary, inherit)',
      text2: 'var(--color-text-secondary, inherit)',
      text3: 'var(--color-text-tertiary, inherit)',
      hover: 'var(--color-background-tertiary-hover, rgba(127,127,127,0.15))',
      btnBorder: 'var(--color-border-button-default, rgba(127,127,127,0.4))',
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
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid ' + t.btnBorder,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 12,
      },
    };

    const head = h(
      'div',
      { style: style.head },
      h('span', { style: { fontWeight: 600 } }, 'CLI 安装检测'),
      h(
        'button',
        {
          style: { ...style.btn, marginLeft: 'auto', background: phase === 'running' ? t.hover : 'transparent' },
          disabled: phase === 'running',
          onClick: () => void refresh(),
        },
        phase === 'running' ? '检测中…' : '重新检测',
      ),
    );

    const hint = h(
      'div',
      { style: style.hint },
      '逐个探测 ' + ENGINES.length + ' 个 CC GUI 引擎的命令入口，展开 shim 后比较版本与 SHA256。引擎较多时首次检测可能需要十几秒。',
    );

    if (phase === 'idle') return h('div', { style: style.root }, head, hint);

    if (phase === 'running' && !data) {
      return h('div', { style: style.root }, head, hint, h('div', { style: style.meta }, '正在读取文件哈希…'));
    }

    if (phase === 'error') {
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
            h('span', null, '检测失败：' + error),
          ),
        ),
      );
    }

    const engines = data ? asArray(data.engines) : [];
    const installed = engines.filter((e) => asArray(e.installs).length > 0);
    const problems = installed.filter((e) => {
      const k = engineVerdict(e).kind;
      return k === 'warn' || k === 'diverged';
    });
    const overall = {
      dot: problems.length > 0 ? VERDICT.diverged.dot : installed.length > 0 ? VERDICT.same.dot : VERDICT.missing.dot,
      text:
        installed.length > 0
          ? installed.length + ' / ' + engines.length + ' 个引擎已安装' +
            (problems.length > 0 ? '，' + problems.length + ' 个存在差异' : '，全部一致')
          : '没有探测到任何已安装的 CLI',
    };

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
          h('span', { style: { ...style.dot, background: overall.dot } }),
          h('span', { style: { fontWeight: 600 } }, overall.text),
        ),
      ),

      engines.map((eng) => {
        const installs = asArray(eng.installs);
        const v = engineVerdict(eng);
        return h(
          'div',
          { key: eng.id, style: style.card },
          h(
            'div',
            { style: style.row },
            h('span', { style: { fontWeight: 600, minWidth: 100 } }, eng.label),
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
                h('span', { style: { fontWeight: 500 } }, it.version || '(版本未读取)'),
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
            ),
          ),
        );
      }),

      checkedAt && h('div', { style: { ...style.meta, marginTop: 4 } }, '检测于 ' + checkedAt.toLocaleTimeString()),
    );
  }

  ctx.ui.registerSettingsSection({
    key: 'diagnostics',
    label: () => 'CLI 安装检测',
    component: SettingsPanel,
  });

  ctx.ui.registerCommand({
    key: 'cli-install-audit.open',
    title: () => 'CLI 安装检测',
    keywords: () => ['cli', 'install', 'audit', 'sha256', 'claude', 'codex', 'opencode', '安装', '版本'],
    run: () => {
      ctx.ui.openSettings('diagnostics');
    },
  });
}

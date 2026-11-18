const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

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

$out = [ordered]@{
  candidates = @()
  running    = @()
  processes  = @()
  installs   = @()
}

# 全量进程表（只取轻量字段），用于回溯父进程链判断 claude 归属
$procTable = @{}
foreach ($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name -ErrorAction SilentlyContinue) {
  $procTable[[int]$p.ProcessId] = $p
}

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

foreach ($c in Get-Command claude -All -ErrorAction SilentlyContinue) {
  $src = $null
  if ($c.Source) { $src = [string]$c.Source }
  elseif ($c.Path) { $src = [string]$c.Path }
  $out.candidates += [ordered]@{
    name   = [string]$c.Name
    type   = [string]$c.CommandType
    source = $src
  }
}

# 按可执行文件路径分组：同一路径多个实例合并计数，归属取父进程链
$procGroups = [ordered]@{}
foreach ($p in Get-CimInstance Win32_Process -Filter "Name='claude.exe'") {
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
$out.processes = @($procGroups.Values)
$out.running = @($out.processes | ForEach-Object { $_.path })

$sdkPath = Join-Path $env:USERPROFILE '.codemoss\dependencies\claude-sdk\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe'
$entries = @()
foreach ($c in $out.candidates) {
  if ($c.source -and ($c.source -match '\.(exe|cmd|bat)$') -and (Test-Path -LiteralPath $c.source)) {
    $entries += [ordered]@{ entry = $c.source; kind = 'path' }
  }
}
if (Test-Path -LiteralPath $sdkPath) { $entries += [ordered]@{ entry = $sdkPath; kind = 'sdk' } }
foreach ($r in $out.running) { $entries += [ordered]@{ entry = $r; kind = 'running' } }

$procMap = @{}
foreach ($g in $out.processes) { $procMap[[string]$g.path.ToLowerInvariant()] = $g }

$seen = @{}
foreach ($e in $entries) {
  $entry = [string]$e.entry
  $target = $entry
  if ($entry -match '\.(cmd|bat)$') {
    $resolved = Resolve-Shim $entry
    if ($resolved) { $target = $resolved }
  }
  $key = $target.ToLower()
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = $true

  $ver = $null
  if ($target -match '\.exe$') {
    try {
      $v = & $target --version 2>$null | Select-Object -First 1
      if ($v) { $ver = ([string]$v).Trim() }
    } catch {}
  }
  $hash = $null
  try { $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower() } catch {}
  $size = 0
  try { $size = [long](Get-Item -LiteralPath $target).Length } catch {}

  $pg = $procMap[[string]$target.ToLowerInvariant()]
  $procCount = 0
  $ownerList = @()
  if ($pg) {
    $procCount = [int]$pg.count
    $ownerList = @($pg.owners)
  }
  $out.installs += [ordered]@{
    entry        = $entry
    target       = $target
    kind         = $(if ($pg) { 'running' } elseif ($entry -match '\.codemoss\\') { 'sdk' } else { 'path' })
    version      = $ver
    sha256       = $hash
    size         = $size
    processCount = $procCount
    owners       = [object[]]$ownerList
  }
}

$out | ConvertTo-Json -Depth 6 -Compress
`;

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

  // 同一插件实例内缓存，设置页重新挂载时不必重跑
  let autoRan = false;
  let cache = null;

  async function runAudit() {
    const r = await ctx.bridge.invoke('plugin_exec_run', {
      bin: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', toEncodedCommand(PS_SCRIPT)],
      timeoutMs: 30000,
    });
    if (r && typeof r.code === 'number' && r.code !== 0) {
      throw new Error((r.stderr || '').trim() || 'powershell 退出码 ' + r.code);
    }
    const text = String((r && r.stdout) || '').replace(/^﻿/, '').trim();
    if (!text) throw new Error('没有拿到输出，可能是 PATH 中没有 claude');
    const data = JSON.parse(text);
    data.candidates = asArray(data.candidates);
    data.running = asArray(data.running);
    data.installs = asArray(data.installs);
    return data;
  }

  function verdictOf(installs) {
    const hashes = [...new Set(installs.map((x) => x.sha256).filter(Boolean))];
    const versions = [...new Set(installs.map((x) => x.version).filter(Boolean))];
    if (hashes.length === 0) return { kind: 'unknown', text: '没有可读取的二进制' };
    if (hashes.length === 1) return { kind: 'same', text: '所有入口指向同一个文件（SHA256 相同）' };
    if (versions.length === 1) return { kind: 'warn', text: '版本相同，但文件不同（可能是不同构建）' };
    return { kind: 'diverged', text: '版本已分叉，CC GUI 与终端可能不是同一个 Claude Code' };
  }

  // 只给圆点上色；正文一律用宿主文本 token，深浅主题下对比度都由宿主保证
  const DOT = {
    same: '#22c55e',
    warn: '#eab308',
    diverged: '#ef4444',
    unknown: '#94a3b8',
  };

  const OWNER = { ccgui: 'CC GUI', terminal: '终端', other: '其他' };
  const OWNER_ORDER = ['ccgui', 'terminal', 'other'];

  function ownerLabel(it) {
    return asArray(it.owners)
      .filter((o) => typeof o === 'string')
      .slice()
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

    const verdict = data ? verdictOf(data.installs) : null;
    const ccguiUse = data
      ? data.installs.filter((x) => asArray(x.owners).indexOf('ccgui') >= 0)
      : [];

    const head = h(
      'div',
      { style: style.head },
      h('span', { style: { fontWeight: 600 } }, 'Claude Code 安装检测'),
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
      '对比 PATH 解析顺序、CC GUI 自带 SDK、正在运行的 claude 进程；比较版本与 SHA256。首次检测约 3 秒。',
    );

    if (phase === 'idle') {
      return h('div', { style: style.root }, head, hint);
    }

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
            h('span', { style: { ...style.dot, background: DOT.diverged } }),
            h('span', null, '检测失败：' + error),
          ),
        ),
      );
    }

    return h(
      'div',
      { style: style.root },
      head,
      hint,

      verdict &&
        h(
          'div',
          { style: style.card },
          h(
            'div',
            { style: style.row },
            h('span', { style: { ...style.dot, background: DOT[verdict.kind] } }),
            h('span', { style: { fontWeight: 600 } }, verdict.text),
          ),
        ),

      data &&
        h(
          'div',
          { style: { ...style.card, background: 'transparent' } },
          ccguiUse.length > 0
            ? h(
                'div',
                null,
                h('div', { style: { ...style.meta, marginBottom: 2 } }, 'CC GUI 正在使用：'),
                ccguiUse.map((x, i) =>
                  h('div', { key: 'g' + i, style: style.path }, (x.version || '?') + '   ' + x.target),
                ),
              )
            : h(
                'div',
                { style: style.meta },
                data.running.length > 0
                  ? '有 claude 进程在运行，但不在 CC GUI 的进程树下（多为终端会话）。'
                  : '当前没有运行中的 claude 进程，CC GUI 的实际路径取自自带 SDK。',
              ),
        ),

      data &&
        data.installs.map((it, i) =>
          h(
            'div',
            { key: 'i' + i, style: style.card },
            h(
              'div',
              { style: style.row },
              h('span', { style: { fontWeight: 600 } }, it.version || '(版本读取失败)'),
              h('span', { style: style.meta }, fmtSize(it.size)),
              it.processCount > 0 &&
                h(
                  'span',
                  { style: style.meta },
                  '· 运行中 ×' + it.processCount + (ownerLabel(it) ? ' · ' + ownerLabel(it) : ''),
                ),
              !it.processCount && it.kind === 'sdk' && h('span', { style: style.meta }, '· CC GUI 自带'),
              !it.processCount && it.kind === 'path' && h('span', { style: style.meta }, '· PATH'),
            ),
            h('div', { style: style.path }, it.target),
            it.entry !== it.target &&
              h('div', { style: { ...style.path, color: t.text3 } }, '入口：' + it.entry),
            h('div', { style: { ...style.path, color: t.text3 } }, 'sha256：' + shortHash(it.sha256)),
          ),
        ),

      data &&
        data.candidates.length > 0 &&
        h(
          'div',
          { style: { ...style.card, background: 'transparent' } },
          h('div', { style: { ...style.meta, marginBottom: 4 } }, 'PATH 解析顺序（前者优先）：'),
          data.candidates.map((c, i) =>
            h('div', { key: 'c' + i, style: style.path }, i + 1 + '. ' + c.name + '  —  ' + c.type),
          ),
        ),

      checkedAt && h('div', { style: style.meta }, '检测于 ' + checkedAt.toLocaleTimeString()),
    );
  }

  ctx.ui.registerSettingsSection({
    key: 'diagnostics',
    label: () => '安装检测',
    component: SettingsPanel,
  });

  ctx.ui.registerCommand({
    key: 'claude-install-audit.open',
    title: () => 'Claude 安装检测',
    keywords: () => ['claude', 'install', 'audit', 'sha256', '安装', '版本'],
    run: () => {
      ctx.ui.openSettings('diagnostics');
    },
  });
}

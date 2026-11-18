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

export default function activate(ctx) {
  const { createElement: h, useState, useEffect, useCallback } = ctx.react;

  const CACHE_KEY = 'audit-cache-v1';

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
        transition: 'background 120ms ease',
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
        transition: 'opacity 120ms ease',
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
      h('span', { style: { fontWeight: 600 } }, 'CLI 安装检测'),
      h(
        'button',
        {
          style: {
            ...style.btn,
            marginLeft: 'auto',
            background: discoverPhase === 'running' || batchRunning ? t.hover : 'transparent',
            opacity: batchRunning ? 0.65 : 1,
            cursor: batchRunning ? 'default' : 'pointer',
          },
          disabled: discoverPhase === 'running' || batchRunning,
          onClick: () => void runDiscover(),
        },
        discoverPhase === 'running' ? '扫描中…' : '重新发现',
      ),
    );

    const hint = h(
      'div',
      { style: style.hint },
      '先只检查命令是否存在，选中引擎后才读取版本、SHA256 与运行中进程。',
    );

    if ((discoverPhase === 'running' || discoverPhase === 'idle') && engines.length === 0) {
      return h(
        'div',
        { style: style.root },
        head,
        hint,
        h(
          'div',
          { style: style.meta },
          discoverPhase === 'idle' ? '正在读取上次结果…' : '正在扫描 PATH…',
        ),
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
              opacity: batchRunning ? 0.65 : 1,
              cursor: batchRunning ? 'default' : 'pointer',
            },
            disabled: batchRunning,
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
            opacity: batchRunning || installedCount === 0 ? 0.65 : 1,
            cursor: batchRunning || installedCount === 0 ? 'default' : 'pointer',
          },
          disabled: batchRunning || installedCount === 0 || discoverPhase === 'running',
          onClick: () => void runAll(),
        },
        batchRunning ? '检测中 ' + batch.done + '/' + batch.total : '全部检测',
      ),
      h(
        'button',
        {
          style: {
            ...style.btnPrimary,
            opacity: isRunning || batchRunning ? 0.65 : 1,
            cursor: isRunning || batchRunning ? 'default' : 'pointer',
          },
          disabled: isRunning || batchRunning,
          onClick: () => void runDetail(selectedId, hasResult),
        },
        isRunning ? '检测中…' : hasResult ? '重新检测' : '检测',
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
        { style: style.card },
        h('div', { style: style.meta }, '正在读取 ' + selected.label + ' 的版本与文件哈希…'),
      );
    } else if (detail && detail.error) {
      body = h(
        'div',
        { style: style.card },
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
        { style: style.card },
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
        { style: style.card },
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

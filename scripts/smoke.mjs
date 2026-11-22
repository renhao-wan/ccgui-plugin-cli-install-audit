// 冒烟测试：只覆盖反馈区（其余部分依赖真实 PowerShell，见 README 的手工验证）。
// 用最小 React 替身渲染设置面板，bridge 里的 plugin_http_request 全部走桩。
import assert from 'node:assert/strict';
import fs from 'node:fs';

const PLUGIN = new URL('../main.js', import.meta.url).href;
const MANIFEST = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ React 替身 */

const states = new Map();
let stateIdx = 0;
let refIdx = 0;
// refs 槽位键是字符串，清空必须换新数组；这里没有 useRef，但保持一致。
let refs = [];
let effects = [];
// hook 槽位按组件实例分域：反馈区是嵌套组件，不能和设置面板共用序号。
let domain = 'root';
let domainSeq = new Map();

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => {
    const i = domain + '|' + stateIdx++;
    if (!states.has(i)) states.set(i, typeof init === 'function' ? init() : init);
    return [
      states.get(i),
      (v) => states.set(i, typeof v === 'function' ? v(states.get(i)) : v),
    ];
  },
  useEffect: (fn) => {
    effects.push(fn);
  },
  useRef: (init) => {
    const i = domain + '|' + refIdx++;
    if (!refs[i]) refs[i] = { current: init === undefined ? null : init };
    return refs[i];
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
};

// React 会调用函数组件；替身也要展开，否则拿到的只是 { type: Comp } 外壳。
function expand(node) {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== 'object') return node;
  if (typeof node.type === 'function') {
    const nm = node.type.name || 'anon';
    const inst = domainSeq.get(nm) || 0;
    domainSeq.set(nm, inst + 1);
    const prev = { domain, stateIdx, refIdx };
    domain = nm + '#' + inst;
    stateIdx = 0;
    refIdx = 0;
    const props = Object.assign({}, node.props || {}, { children: node.children || [] });
    const out = node.type(props);
    domain = prev.domain;
    stateIdx = prev.stateIdx;
    refIdx = prev.refIdx;
    return expand(out);
  }
  return Object.assign({}, node, { children: (node.children || []).map(expand) });
}

function renderFreshState(comp, props) {
  states.clear();
  refs = [];
  stateIdx = 0;
  refIdx = 0;
  domain = 'root';
  domainSeq = new Map();
  effects = [];
  return expand(comp(props || {}));
}

function renderFresh(comp, props) {
  return { tree: renderFreshState(comp, props), effects };
}

// 保留组件内部状态的重渲染：用于验证「输入 → 点按钮 → 读结果」这类交互。
function renderKeep(comp, props) {
  let tree = null;
  for (let pass = 0; pass < 5; pass += 1) {
    const before = new Map(states);
    stateIdx = 0;
    refIdx = 0;
    domain = 'root';
    domainSeq = new Map();
    effects = [];
    tree = expand(comp(props || {}));
    let changed = before.size !== states.size;
    for (const [k, v] of states) {
      if (!changed && before.get(k) !== v) changed = true;
    }
    if (!changed) break;
  }
  return tree;
}

function walk(node, fn) {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, fn);
    return;
  }
  if (!node || typeof node !== 'object') return;
  fn(node);
  for (const c of node.children || []) walk(c, fn);
}

function textOf(node) {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!node || typeof node !== 'object') return '';
  return (node.children || []).map(textOf).join('');
}

function byClass(tree, cls) {
  let hit = null;
  walk(tree, (n) => {
    if (hit) return;
    const c = n.props && n.props.className;
    if (typeof c === 'string' && c.split(/\s+/).includes(cls)) hit = n;
  });
  return hit;
}

function findLink(tree, text) {
  let hit = null;
  walk(tree, (n) => {
    if (!hit && n.type === 'a' && textOf(n).includes(text)) hit = n;
  });
  return hit;
}

/* ------------------------------------------------------------ 假宿主 */

const storageData = new Map();
const httpCalls = [];
let httpResponder = null;
// 让 plugin_exec_run 失败，用来验证「扫描失败」分支里反馈入口还在
let execFails = false;
let settingsDef = null;
let commandDef = null;

const ctx = {
  react: fakeReact,
  pluginId: MANIFEST.id,
  version: MANIFEST.version,
  host: { sdkVersion: '0.3.25', appVersion: '1.2.4', locale: 'zh-CN', isWeb: false },
  storage: {
    get: async (k) => (storageData.has(k) ? storageData.get(k) : null),
    set: async (k, v) => {
      storageData.set(k, v);
    },
    delete: async (k) => {
      storageData.delete(k);
    },
  },
  ui: {
    registerSettingsSection: (def) => {
      settingsDef = def;
      return () => {};
    },
    registerCommand: (def) => {
      commandDef = def;
      return () => {};
    },
    openSettings: () => {},
  },
  bridge: {
    invoke: async (name, args) => {
      if (name === 'plugin_http_request') {
        httpCalls.push(args);
        if (httpResponder) return httpResponder(args);
        // 默认拒绝，等同「network: 权限未生效」——各条用例自己设 responder
        throw new Error('network:ccgui-feedback.2653990378.workers.dev not granted');
      }
      if (name !== 'plugin_exec_run') throw new Error('unexpected command ' + name);
      if (execFails) throw new Error('powershell 不可用');
      // PowerShell 在本冒烟里不真跑：返回空发现结果
      return { code: 0, stdout: JSON.stringify({ engines: [] }), stderr: '' };
    },
  },
};

const mod = await import(PLUGIN);
const dispose = mod.default(ctx);
await sleep(50);

/* ------------------------------------------------------------ 断言 */

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ ok: true, name });
  } catch (e) {
    results.push({ ok: false, name, error: e.message });
  }
}

check('注册了设置页与命令入口', () => {
  assert.ok(settingsDef, 'settings section');
  assert.ok(commandDef, 'command');
  assert.equal(settingsDef.label(), 'CLI 安装检测');
});

const okQuota = () => ({ status: 200, body: JSON.stringify({ remaining: 25, dailyLimit: 30 }) });
const okSend = (remaining) => ({ status: 200, body: JSON.stringify({ ok: true, remaining }) });

// 额度查询挂在 effect 里，且设置面板首帧走的是「正在读取上次结果…」骨架
// （discoverPhase==='idle' 且还没有缓存时提前 return），反馈区要到 restore
// 落定后的下一帧才出现。按真实时序多渲染几轮：每轮执行本帧收集到的 effect，
// 等异步状态落定，再看这一帧有没有反馈区。
async function mountFeedback(responder) {
  httpResponder = responder;
  httpCalls.length = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    const { tree, effects: fx } = renderFresh(settingsDef.component);
    const mounted = !!byClass(tree, 'cli-audit-feedback-text');
    for (const fn of fx) fn();
    if (mounted) break;
    await sleep(40);
  }
  await sleep(60);
}

const snap = () => renderKeep(settingsDef.component);

await (async () => {
  await mountFeedback((args) => (args.url.endsWith('/quota') ? okQuota() : okSend(24)));
  const tree = snap();

  check('反馈：两种渠道都在，Issue 链接指向本仓库', () => {
    assert.ok(byClass(tree, 'cli-audit-feedback-text'), '应有反馈输入框');
    assert.equal(byClass(tree, 'cli-audit-feedback-text').props.maxLength, 1000);
    const link = findLink(tree, '通过 GitHub 提 Issue');
    assert.ok(link, '应有 Issue 链接');
    assert.ok(
      link.props.href.indexOf('https://github.com/renhao-wan/ccgui-plugin-cli-install-audit/issues/new?') === 0,
      '链接应指向本仓库：' + link.props.href,
    );
  });

  check('反馈：额度文案用服务端回传的真实值', () => {
    const q = textOf(byClass(tree, 'cli-audit-feedback-quota'));
    assert.ok(q.indexOf('25') >= 0, '应显示 25，实际：' + q);
  });

  byClass(tree, 'cli-audit-feedback-text').props.onChange({
    target: { value: '探测 Claude 一直显示未安装\nError: boom\n    at discover (main.js:12)' },
  });
  const filled = snap();
  check('反馈：正文保留换行与堆栈缩进', () => {
    const v = byClass(filled, 'cli-audit-feedback-text').props.value;
    assert.ok(/\nError: boom\n {4}at discover/.test(v), '实际：' + JSON.stringify(v));
    assert.ok(/^\d+ \/ 1000$/.test(textOf(byClass(filled, 'cli-audit-feedback-count'))), '字数应显示 n / 1000');
  });

  const sendBtn = byClass(filled, 'cli-audit-feedback-send');
  check('反馈：有内容时发送按钮可用', () => {
    assert.ok(sendBtn, '应有发送按钮');
    assert.equal(sendBtn.props.disabled, false);
  });
  sendBtn.props.onClick();
  sendBtn.props.onClick(); // 同一 tick 连点两次
  await sleep(100);

  check('反馈：同一 tick 连点两次只发一条，请求体只有白名单字段', () => {
    const posts = httpCalls.filter((c) => c.url.endsWith('/feedback'));
    assert.equal(posts.length, 1, '应只发 1 条，实际 ' + posts.length);
    const payload = JSON.parse(posts[0].body);
    assert.deepEqual(Object.keys(payload).sort(), ['hostVersion', 'pluginId', 'pluginVersion', 'text', 'ts']);
    assert.equal(payload.pluginId, 'cli-install-audit');
    assert.equal(payload.hostVersion, '1.2.4');
    assert.equal(posts[0].method, 'POST');
  });

  const sent = snap();
  check('反馈：成功后清空正文、按钮显示已发送、额度用回传值', () => {
    assert.equal(byClass(sent, 'cli-audit-feedback-text').props.value, '');
    assert.ok(textOf(byClass(sent, 'cli-audit-feedback-send')).indexOf('已发送') >= 0, '按钮应变成「已发送」');
    assert.ok(textOf(byClass(sent, 'cli-audit-feedback-quota')).indexOf('24') >= 0, '额度应更新为 24');
    assert.ok(textOf(byClass(sent, 'cli-audit-feedback-status')).indexOf('已发送') >= 0);
  });
})();

await (async () => {
  await mountFeedback((args) =>
    args.url.endsWith('/quota') ? okQuota() : { status: 200, body: '<html>请登录校园网</html>' },
  );
  byClass(snap(), 'cli-audit-feedback-text').props.onChange({ target: { value: '被劫持' } });
  byClass(snap(), 'cli-audit-feedback-send').props.onClick();
  await sleep(80);
  const t = snap();
  check('反馈：200 但正文不是我们的 JSON 时不当成功', () => {
    assert.ok(textOf(t).indexOf('已发送') < 0, '劫持页不能判成功');
    assert.ok(textOf(byClass(t, 'cli-audit-feedback-status')).indexOf('GitHub Issue') >= 0);
    assert.notEqual(byClass(t, 'cli-audit-feedback-text').props.value, '', '失败时正文必须留着');
  });
})();

await (async () => {
  await mountFeedback((args) => {
    if (args.url.endsWith('/quota')) return okQuota();
    throw new Error('net::ERR_NAME_NOT_RESOLVED');
  });
  byClass(snap(), 'cli-audit-feedback-text').props.onChange({ target: { value: '断网' } });
  byClass(snap(), 'cli-audit-feedback-send').props.onClick();
  await sleep(80);
  const t = snap();
  check('反馈：网络不通时提示检查网络或代理', () => {
    const s = textOf(byClass(t, 'cli-audit-feedback-status'));
    assert.ok(/网络|代理/.test(s), s);
    assert.ok(s.indexOf('GitHub Issue') >= 0);
  });
})();

await (async () => {
  await mountFeedback((args) =>
    args.url.endsWith('/quota') ? { status: 500, body: 'boom' } : okSend(23),
  );
  const tree = snap();
  check('反馈：额度查不到时说连不上并给重试入口', () => {
    assert.ok(/连不上|暂时/.test(textOf(byClass(tree, 'cli-audit-feedback-quota'))));
    assert.ok(byClass(tree, 'cli-audit-feedback-quota-retry'), '应有重试按钮');
  });

  httpResponder = () => okQuota();
  const before = httpCalls.filter((c) => c.url.endsWith('/quota')).length;
  byClass(snap(), 'cli-audit-feedback-quota-retry').props.onClick();
  await sleep(80);
  check('反馈：重试按钮会重新查额度', () => {
    assert.equal(httpCalls.filter((c) => c.url.endsWith('/quota')).length, before + 1);
    assert.ok(textOf(byClass(snap(), 'cli-audit-feedback-quota')).indexOf('25') >= 0);
  });

  // 发送成功时顺手把「连不上」纠正成服务端回传的额度
  httpResponder = (args) => (args.url.endsWith('/quota') ? { status: 500, body: 'boom' } : okSend(23));
  byClass(snap(), 'cli-audit-feedback-text').props.onChange({ target: { value: '一条反馈' } });
  byClass(snap(), 'cli-audit-feedback-send').props.onClick();
  await sleep(80);
  const after = snap();
  check('反馈：额度查不到但发送成功，额度区不再停留在连不上', () => {
    const q = textOf(byClass(after, 'cli-audit-feedback-quota'));
    assert.ok(q.indexOf('23') >= 0, q);
    assert.ok(q.indexOf('连不上') < 0, q);
  });
})();

await (async () => {
  await mountFeedback((args) =>
    args.url.endsWith('/quota')
      ? okQuota()
      : { status: 429, body: '{"ok":false,"error":"rate_limited","kind":"burst","remaining":25}' },
  );
  byClass(snap(), 'cli-audit-feedback-text').props.onChange({ target: { value: '发太快' } });
  byClass(snap(), 'cli-audit-feedback-send').props.onClick();
  await sleep(80);
  const t = snap();
  check('反馈：突发限流说稍等几分钟，不谎报今天用完', () => {
    const s = textOf(byClass(t, 'cli-audit-feedback-status'));
    assert.ok(/太快|稍候|分钟/.test(s), s);
    assert.ok(s.indexOf('明天') < 0, '突发不该说成今天用完');
  });
})();

await (async () => {
  // 回归：中转返回 ok:true 但没带 remaining（旧版中转）。旧写法
  // Number.isFinite(Number(null)) === true 会把它读成 0，界面谎报「今天用完」。
  await mountFeedback((args) =>
    args.url.endsWith('/quota') ? okQuota() : { status: 200, body: '{"ok":true}' },
  );
  byClass(snap(), 'cli-audit-feedback-text').props.onChange({ target: { value: '没有 remaining' } });
  byClass(snap(), 'cli-audit-feedback-send').props.onClick();
  await sleep(80);
  const t = snap();
  check('反馈：中转没回传额度时按旧值自减，不说「今天用完」', () => {
    const q = textOf(byClass(t, 'cli-audit-feedback-quota'));
    assert.ok(q.indexOf('24') >= 0, '应自减为 24，实际：' + q);
    assert.ok(q.indexOf('用完') < 0, '不能谎报额度耗尽：' + q);
    assert.ok(textOf(byClass(t, 'cli-audit-feedback-send')).indexOf('已发送') >= 0);
  });
})();

httpResponder = null;
let disposeOk = true;
try {
  dispose();
} catch {
  disposeOk = false;
}
check('卸载函数可安全执行', () => assert.ok(disposeOk));

// 扫描失败分支是提前 return 的，回归用例：反馈入口不能被提前 return 吞掉。
await (async () => {
  const dispose3 = mod.default(ctx);
  execFails = true;
  await mountFeedback(okQuota);
  const tree = snap();
  check('反馈：扫描失败时设置页仍保留反馈入口', () => {
    assert.ok(textOf(tree).indexOf('扫描失败') >= 0, '应走扫描失败分支');
    assert.ok(byClass(tree, 'cli-audit-feedback-text'), '反馈输入框应还在');
    assert.ok(findLink(tree, '通过 GitHub 提 Issue'), 'Issue 链接应还在');
  });
  execFails = false;
  dispose3();
})();

/* ------------------------------------------------------------ 汇总 */

for (const r of results) {
  console.log((r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.ok ? '' : ' —— ' + r.error));
}
const failed = results.filter((r) => !r.ok).length;
console.log('\nRESULT=' + (failed === 0 ? 'SMOKE_OK' : 'SMOKE_FAIL') + ' checks=' + results.length + ' failed=' + failed);
process.exit(failed === 0 ? 0 : 1);

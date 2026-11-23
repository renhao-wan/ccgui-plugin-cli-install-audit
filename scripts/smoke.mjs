// 冒烟测试：只覆盖反馈区（其余部分依赖真实 PowerShell，见 README 的手工验证）。
// 用最小 React 替身渲染设置面板，bridge 里的 plugin_http_request 全部走桩。
import assert from 'node:assert/strict';
import fs from 'node:fs';

const PLUGIN = new URL('../main.js', import.meta.url).href;
const MANIFEST = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ React 替身 */

// 替身本体在 ccgui-plugin-shared/fake-react（四插件共用一份源码）。
// 这里保留 `renderFresh` 返回 { tree, effects } 的旧形状，调用点不用改。
import { createFakeReact, walk, textOf, byClass, findAll } from 'ccgui-plugin-shared/fake-react';

const find = (tree, pred) => findAll(tree, pred)[0] || null;

const fake = createFakeReact({ componentName: 'anon' });
const fakeReact = fake.api;

// 反馈区的额度查询在 effect 里，由用例手动跑。
let collectedEffects = [];
const baseUseEffect = fakeReact.useEffect;
fakeReact.useEffect = (fn, deps) => {
  collectedEffects.push({ fn, deps });
  baseUseEffect(fn, deps);
};

function renderFresh(comp, props) {
  collectedEffects = [];
  const tree = fake.renderFresh(comp, props);
  return { tree, effects: collectedEffects.map((e) => e.fn) };
}

function renderKeep(comp, props) {
  return fake.renderKeep(comp, props);
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

const okQuota = () => ({ status: 200, body: JSON.stringify({ remaining: 1, dailyLimit: 1, fallbackRemaining: 3 }) });
// 发送成功后本插件即进入 48h 冷却（remaining:0），兜底池少一条。
const okSend = () => ({ status: 200, body: JSON.stringify({ ok: true, remaining: 0, dailyLimit: 1, fallbackRemaining: 2 }) });

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
  await mountFeedback((args) => (args.url.includes('/quota') ? okQuota() : okSend()));
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
    assert.ok(/两天|48/.test(q), '应显示「每两天可提交 1 条」，实际：' + q);
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
    // 发送成功后本插件进入 48 小时冷却，额度区应切到「共享兜底」文案。
    const q = textOf(byClass(sent, 'cli-audit-feedback-quota'));
    assert.ok(/共享|48|两天/.test(q), '额度区应反映冷却状态，实际：' + q);
    assert.ok(textOf(byClass(sent, 'cli-audit-feedback-status')).indexOf('已发送') >= 0);
  });
})();

await (async () => {
  await mountFeedback((args) =>
    args.url.includes('/quota') ? okQuota() : { status: 200, body: '<html>请登录校园网</html>' },
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
    if (args.url.includes('/quota')) return okQuota();
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
    args.url.includes('/quota') ? { status: 500, body: 'boom' } : okSend(),
  );
  const tree = snap();
  check('反馈：额度查不到时说连不上并给重试入口', () => {
    assert.ok(/连不上|暂时/.test(textOf(byClass(tree, 'cli-audit-feedback-quota'))));
    assert.ok(byClass(tree, 'cli-audit-feedback-quota-retry'), '应有重试按钮');
  });

  httpResponder = () => okQuota();
  const before = httpCalls.filter((c) => c.url.includes('/quota')).length;
  byClass(snap(), 'cli-audit-feedback-quota-retry').props.onClick();
  await sleep(80);
  check('反馈：重试按钮会重新查额度', () => {
    assert.equal(httpCalls.filter((c) => c.url.includes('/quota')).length, before + 1);
    assert.ok(/两天|48/.test(textOf(byClass(snap(), 'cli-audit-feedback-quota'))));
  });

  // 发送成功时顺手把「连不上」纠正成服务端回传的额度
  httpResponder = (args) => (args.url.includes('/quota') ? { status: 500, body: 'boom' } : okSend());
  byClass(snap(), 'cli-audit-feedback-text').props.onChange({ target: { value: '一条反馈' } });
  byClass(snap(), 'cli-audit-feedback-send').props.onClick();
  await sleep(80);
  const after = snap();
  check('反馈：额度查不到但发送成功，额度区不再停留在连不上', () => {
    const q = textOf(byClass(after, 'cli-audit-feedback-quota'));
    assert.ok(/共享|48|两天/.test(q), q);
    assert.ok(q.indexOf('连不上') < 0, q);
  });
})();

await (async () => {
  await mountFeedback((args) =>
    args.url.includes('/quota')
      ? okQuota()
      : { status: 429, body: '{"ok":false,"error":"rate_limited","kind":"burst","remaining":25}' },
  );
  byClass(snap(), 'cli-audit-feedback-text').props.onChange({ target: { value: '发太快' } });
  byClass(snap(), 'cli-audit-feedback-send').props.onClick();
  await sleep(80);
  const t = snap();
  check('反馈：突发限流说稍等几分钟，不谎报额度耗尽', () => {
    const s = textOf(byClass(t, 'cli-audit-feedback-status'));
    assert.ok(/太快|稍候|分钟/.test(s), s);
    assert.ok(s.indexOf('48') < 0, '突发不该说成 48 小时冷却');
  });
})();

await (async () => {
  // 回归：中转返回 ok:true 但没带 remaining（旧版中转）。旧写法
  // Number.isFinite(Number(null)) === true 会把它读成 0，界面谎报额度耗尽。
  await mountFeedback((args) =>
    args.url.includes('/quota') ? okQuota() : { status: 200, body: '{"ok":true}' },
  );
  byClass(snap(), 'cli-audit-feedback-text').props.onChange({ target: { value: '没有 remaining' } });
  byClass(snap(), 'cli-audit-feedback-send').props.onClick();
  await sleep(80);
  const t = snap();
  check('反馈：中转没回传额度时自减，不谎报额度耗尽', () => {
    const q = textOf(byClass(t, 'cli-audit-feedback-quota'));
    // 旧额度 remaining:1，自减后为 0，进入「共享兜底」文案；关键是别把 null 读成「额度耗尽」以外的意外。
    assert.ok(/共享|48|两天/.test(q), '应自减并显示冷却文案，实际：' + q);
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

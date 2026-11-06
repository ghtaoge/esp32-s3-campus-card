const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const compiler = process.env.WXML_COMPILER || '';
let render;
if (compiler && fs.existsSync(compiler)) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-wxml-'));
  const compiled = path.join(folder, 'template.js');
  try {
    const result = spawnSync(compiler, ['-o', compiled, 'pages/index/index.wxml'], { cwd:path.resolve(__dirname, '..'), encoding:'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const context = { window:{}, console }; vm.createContext(context);
    vm.runInContext(fs.readFileSync(compiled, 'utf8'), context);
    const registry = {}; context.$gwx(undefined, registry);
    context.renderTemplate = context.$gwx(Object.keys(registry.entrys)[0], registry);
    render = data => { context.input = JSON.stringify(data); return vm.runInContext('renderTemplate(JSON.parse(input))', context); };
  } finally { fs.rmSync(folder, { recursive:true, force:true }); }
}
let page;
global.Page = definition => { page = definition; };
require('../pages/index/index');
const base = page.data;
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return undefined;
  if (predicate(tree)) return tree;
  for (const node of tree.children || []) { const found = find(node, predicate); if (found) return found; }
}
const action = (tree, name) => find(tree, node => node.attr && node.attr.bindtap === name);
const options = { skip:render ? false : 'Set WXML_COMPILER to the WeChat developer tools wcc.exe for compiled template verification' };
test('compiled first screen permits search and blocks trading before connection', options, () => {
  const tree = render(base);
  assert.equal(action(tree, 'search').attr.disabled, false);
  assert.equal(action(tree, 'submitTrade').attr.disabled, true);
  assert.equal(action(render({ ...base, scanning:true }), 'search').attr.disabled, true);
});
test('compiled waiting state permits cancel but uncertain state has no cancel action', options, () => {
  const waiting = { ...base, connected:true, hasOutstanding:true, canTrade:false, canCancel:true, pending:{ phase:'waiting' } };
  assert.ok(action(render(waiting), 'cancel'));
  assert.equal(action(render(waiting), 'submitTrade').attr.disabled, true);
  const uncertain = { ...waiting, canCancel:false, pending:{ phase:'uncertain' } };
  assert.equal(action(render(uncertain), 'cancel'), undefined);
  assert.ok(action(render(uncertain), 'queryOriginal'));
});
test('compiled settings require a connected idle device and privacy uses native consent event', options, () => {
  assert.equal(action(render({ ...base, tab:'screen' }), 'saveSettings').attr.disabled, true);
  assert.equal(action(render({ ...base, tab:'screen', connected:true }), 'saveSettings').attr.disabled, false);
  assert.equal(action(render({ ...base, tab:'screen', connected:true, busy:true }), 'saveSettings').attr.disabled, true);
  const privacy = find(render({ ...base, showPrivacy:true }), node => node.attr && node.attr.id === 'agree-privacy');
  assert.equal(privacy.attr.openType, 'agreePrivacyAuthorization');
  assert.equal(privacy.attr.bindagreeprivacyauthorization, 'agreePrivacy');
});
test('compiled same-id resumption is shown only for a resumable local order', options, () => {
  const data = { ...base, connected:true, hasOutstanding:true, canResume:true, outstanding:{ id:'1234567890abcdef' } };
  assert.ok(action(render(data), 'resumeOriginal'));
  assert.equal(action(render({ ...data, canResume:false }), 'resumeOriginal'), undefined);
});

test('compiled power and diagnostics controls are gated by confirmed device capability', options, () => {
  const legacy = render({ ...base, tab: 'screen', connected: true, busy: false, powerSupported: false });
  assert.equal(action(legacy, 'savePower').attr.disabled, true); assert.equal(action(legacy, 'wakeScreen').attr.disabled, true);
  const supported = render({ ...base, tab: 'screen', connected: true, busy: false, powerSupported: true, diagnosticsSupported: true });
  assert.equal(!!action(supported, 'savePower').attr.disabled, false); assert.equal(!!action(supported, 'wakeScreen').attr.disabled, false);
  assert.ok(action(supported, 'showDiagnostics'));
});

test('compiled catalog and ledger views expose editing and only export non-empty filtered records', options, () => {
  const product = { id: 'lunch', name: '午餐', amount: '12.50', scene: '食堂' };
  const editor = render({ ...base, tab: 'catalog', products: [product], productEditor: true });
  for (const name of ['newProduct', 'editProduct', 'deleteProduct', 'saveProduct', 'saveTopups']) assert.ok(action(editor, name), name);
  const empty = render({ ...base, tab: 'logs', filteredLogs: [] }); assert.equal(action(empty, 'exportLogs').attr.disabled, true);
  const populated = render({ ...base, tab: 'logs', filteredLogs: [{ id: '1', scene: '食堂', amountText: '12.50' }] });
  assert.equal(!!action(populated, 'exportLogs').attr.disabled, false);
});

test('compiled receipt identifies its own card independently of the last-read card', options, () => {
  const data = { ...base, tab: 'trade', card: { cardNo: 10000001, name: '测试甲', balanceText: '50.00' },
    lastResult: { cardNo: 10000002, kindText: '消费', status: 'success', amountText: '12.50', balanceText: '37.50' } };
  const number = tree => find(tree, node => node.attr && node.attr.id === 'receipt-card-number');
  const receipt = JSON.stringify(number(render(data)));
  assert.match(receipt, /10000002/); assert.doesNotMatch(receipt, /10000001/);
  const unread = JSON.stringify(number(render({ ...data, lastResult: { ...data.lastResult, cardNo: 0, status: 'cancelled' } })));
  assert.match(unread, /未读取/);
});

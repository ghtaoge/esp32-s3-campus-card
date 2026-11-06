const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { OPERATION_KEY } = require('../utils/business');
function loadPage(initial = {}) {
  let definition;
  const stored = JSON.parse(JSON.stringify(initial));
  global.wx = {
    getStorageSync:key => stored[key], setStorageSync:(key,value) => { stored[key] = JSON.parse(JSON.stringify(value)); },
    onBluetoothDeviceFound() {}, onBLECharacteristicValueChange() {}, onBLEConnectionStateChange() {}
  };
  global.Page = value => { definition = value; };
  const file = path.resolve(__dirname, '../pages/index/index.js'); delete require.cache[file]; require(file);
  const page = Object.assign({}, definition, { data:JSON.parse(JSON.stringify(definition.data)), setData(patch) { Object.assign(this.data, patch); } });
  page.onLoad(); page.deviceId = 'board'; page.setData({ connected:true, readerReady:true, oledReady:true, deviceStorageReady:true }); page.refreshLock();
  return { page, stored };
}
test('arm acknowledgment means waiting, not payment success, and repeat taps cannot create another id', async () => {
  const { page, stored } = loadPage(); const requests = [];
  page.client.request = async request => { requests.push(request); return { ok:true, op:'arm', pending:{ id:request.id, kind:'topup', amountCents:5000, phase:'waiting' } }; };
  await page.submitTrade();
  assert.equal(requests.length, 1); assert.equal(page.data.lastResult, null); assert.match(page.data.notice, /任务已提交/);
  assert.equal(page.data.canTrade, false); assert.equal(page.data.canCancel, true);
  assert.equal(stored[OPERATION_KEY].board.id, requests[0].id);
  await page.submitTrade(); assert.equal(requests.length, 1);
});
test('uncertain write prevents cancellation and new transactions, terminal result clears only original order', async () => {
  const { page } = loadPage();
  const entry = page.book.begin('board', { op:'arm', kind:'spend', amountCents:1250 });
  page.applyState({ pending:{ id:entry.id, kind:'spend', phase:'uncertain' }, lastResult:{ id:entry.id, status:'uncertain' } });
  assert.equal(page.data.canTrade, false); assert.equal(page.data.canCancel, false); assert.ok(page.book.get('board'));
  page.applyState({ pending:null, lastResult:{ id:entry.id, kind:'spend', status:'success', cardNo:10000001, amountCents:1250, balanceCents:3750, message:'消费成功', timestamp:0 } });
  assert.equal(page.book.get('board'), null); assert.equal(page.data.canTrade, true); assert.equal(page.data.lastResult.balanceText, '37.50');
});
test('arm transport failure retains business id for original-result queries', async () => {
  const { page } = loadPage();
  page.client.request = async () => { throw new Error('disconnect'); };
  await page.submitTrade(); const original = page.book.get('board'); assert.ok(original); assert.equal(page.data.canTrade, false);
  const requests = [];
  page.client.request = async request => { requests.push(request); return request.op === 'result' ? { ok:true, result:null } : { ok:true, pending:null }; };
  await page.queryOriginal();
  assert.deepEqual(requests.map(request => request.op), ['result', 'state']); assert.equal(requests[0].id, original.id);
  assert.equal(page.book.get('board').id, original.id); assert.equal(page.data.canTrade, false);
});
test('complete rejection releases unsent/rejected business id while preserving device waiting task', async () => {
  const { page } = loadPage();
  page.client.request = async () => {
    const error = new Error('BUSY'); error.response = { ok:false, code:'BUSY', pending:{ id:'other', kind:'spend', phase:'waiting' } };
    page.applyState(error.response); throw error;
  };
  await page.submitTrade(); assert.equal(page.book.get('board'), null); assert.equal(page.data.canTrade, false); assert.equal(page.data.pending.id, 'other');
});
test('unsupported/blank card events explain the error and device storage failure blocks new trades', () => {
  const { page } = loadPage();
  page.applyState({ ok:false, event:'card', code:'CARD_UNSUPPORTED', message:'仅支持测试卡', card:null });
  assert.match(page.data.errorText, /CARD_UNSUPPORTED/); assert.equal(page.data.card, null);
  page.applyState({ ok:true, event:'card', card:{ balanceCents:100, name:'小明', studentNo:'1' } });
  assert.equal(page.data.errorText, '');
  page.applyState({ device:{ oledReady:true, readerReady:true, storageReady:false } });
  assert.equal(page.data.canTrade, false); assert.equal(page.data.storageReady, true); assert.equal(page.data.deviceStorageReady, false);
});

test('paginated history is committed to the UI once after the last page', async () => {
  const { page } = loadPage();
  const old = [{ id: 'old', amountText: '1.00' }]; page.setData({ logs: old, logsLoaded: true });
  const records = Array.from({ length: 7 }, (_, index) => ({ id: (index + 1).toString(16).padStart(16, '0'), kind: 'topup', status: 'success', amountCents: 100, balanceCents: 100 }));
  let second, logWrites = 0;
  const setData = page.setData.bind(page); page.setData = patch => { if (Object.prototype.hasOwnProperty.call(patch, 'logs')) logWrites++; setData(patch); };
  page.client.request = async command => {
    if (!command.offset) return { op: 'logs', logs: records.slice(0, 5), total: 7, revision: '1234abcd', nextOffset: 5 };
    return new Promise(resolve => { second = resolve; });
  };
  const loading = page.loadLogs(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(page.data.logs, old); assert.equal(logWrites, 0);
  second({ op: 'logs', logs: records.slice(5), total: 7, revision: '1234abcd', nextOffset: null }); await loading;
  assert.equal(page.data.logs.length, 7); assert.equal(logWrites, 1); assert.equal(page.data.busy, false);
});

test('a failed later page keeps the complete old history instead of displaying partial rows', async () => {
  const { page } = loadPage();
  const old = [{ id: 'old', amountText: '1.00' }]; page.setData({ logs: old, logsLoaded: true });
  page.client.request = async command => {
    if (command.offset) throw new Error('connection lost');
    return { op: 'logs', logs: Array.from({ length: 5 }, (_, index) => ({ id: (index + 1).toString(16).padStart(16, '0') })), total: 7, revision: '1234abcd', nextOffset: 5 };
  };
  await page.loadLogs(); assert.deepEqual(page.data.logs, old); assert.equal(page.data.logsLoaded, true); assert.match(page.data.errorText, /connection lost/);
});

test('state and locks use one view update; RSSI-only advertisements do not redraw the picker', () => {
  const { page } = loadPage(); let writes = 0;
  const setData = page.setData.bind(page); page.setData = patch => { writes++; setData(patch); };
  page.applyState({ pending: { id: '1234567890abcdef', kind: 'topup', phase: 'waiting', amountCents: 100 } });
  assert.equal(writes, 1); assert.equal(page.data.canTrade, false); assert.equal(page.data.canCancel, true);
  writes = 0;
  page.client.acceptDevices(Array.from({ length: 100 }, (_, index) => ({ deviceId: 'A', name: 'S3-CAMPUS-0001', RSSI: -index })));
  assert.equal(writes, 1); assert.equal(page.data.devices.length, 1);
});

test('edited products and custom recharge levels survive reopening and failed saves keep the old catalog', () => {
  const { page, stored } = loadPage();
  page.newProduct(); page.setData({ productName: '冰淇淋', productAmount: '7.25', productScene: '超市' }); page.saveProduct();
  const item = page.data.products.find(value => value.name === '冰淇淋'); assert.ok(item); assert.equal(item.amountCents, 725);
  page.setData({ topupDraft: '10, 25, 80.50' }); page.saveTopups(); assert.deepEqual(page.data.quickAmounts, ['10.00', '25.00', '80.50']);
  const reopened = loadPage(stored).page; assert.ok(reopened.data.products.find(value => value.id === item.id));
  assert.deepEqual(reopened.data.quickAmounts, ['10.00', '25.00', '80.50']);
  global.wx.setStorageSync = () => { throw new Error('storage full'); };
  reopened.setData({ topupDraft: '20, 40' }); reopened.saveTopups();
  assert.deepEqual(reopened.data.quickAmounts, ['10.00', '25.00', '80.50']); assert.match(reopened.data.catalogError, /storage full/);
});

test('phone filters, successful-value statistics and CSV clipboard fallback use the same visible rows', async () => {
  const { page } = loadPage();
  page.applyState({ logs: [
    { id: '0000000000000001', cardNo: 10000001, kind: 'topup', status: 'success', amountCents: 5000, balanceCents: 5000, scene: '食堂' },
    { id: '0000000000000002', cardNo: 10000001, kind: 'spend', status: 'declined', amountCents: 9000, balanceCents: 5000, scene: '食堂' },
    { id: '0000000000000003', cardNo: 10000002, kind: 'spend', status: 'success', amountCents: 1000, balanceCents: 1000, scene: '超市' }
  ] });
  page.filterLogs({ currentTarget: { dataset: { field: 'cardNoFilter' } }, detail: { value: '000001' } });
  assert.equal(page.data.filteredLogs.length, 2); assert.equal(page.data.logSummary.spendText, '0.00');
  page.filterLogs({ currentTarget: { dataset: { field: 'statusIndex' } }, detail: { value: 1 } });
  assert.equal(page.data.filteredLogs.length, 1); assert.equal(page.data.logSummary.topupText, '50.00');
  let text; global.wx.setClipboardData = args => { text = args.data; args.success({}); };
  await page.exportLogs(); assert.ok(text.includes('0000000000000001')); assert.ok(!text.includes('0000000000000002')); assert.match(page.data.notice, /已复制/);
});

test('old firmware cannot receive power or diagnostics operations and new power is shown only after ACK', async () => {
  const { page } = loadPage(); const requests = [];
  page.client.request = async command => { requests.push(command); return {}; };
  await page.savePower(); await page.wakeScreen(); await page.showDiagnostics(); assert.equal(requests.length, 0);
  const power = { batteryMode: false, brightness: 180, idleSeconds: 60, screenAwake: true, batteryMeasurement: false, batteryVoltage: null };
  page.applyState({ device: { readerReady: true, storageReady: true, oledReady: true, capabilities: { power: true, diagnostics: true } }, power });
  page.powerInput({ currentTarget: { dataset: { field: 'brightness' } }, detail: { value: 80 } });
  let confirm; page.client.request = command => { requests.push(command); return new Promise(resolve => { confirm = resolve; }); };
  const saving = page.savePower(); assert.equal(page.data.power.brightness, 180); assert.equal(page.data.powerDirty, true);
  confirm({ ok: true, op: 'power', power: { ...power, brightness: 80 } }); await saving;
  assert.equal(page.data.power.brightness, 80); assert.equal(page.data.powerDirty, false); assert.equal(page.data.batteryText, '未配置电量采样');
  page.setData({ idleSeconds: '5' }); await page.savePower(); assert.equal(requests.length, 1); assert.match(page.data.errorText, /10–3600/);
});

test('phone CSV uses the native file sharing path when available', async () => {
  const { page } = loadPage();
  page.applyState({ logs: [{ id: '0000000000000001', kind: 'spend', status: 'success', amountCents: 1250, balanceCents: 3750, scene: '食堂' }] });
  global.wx.env = { USER_DATA_PATH: 'wxfile://user' };
  let write, shared;
  global.wx.getFileSystemManager = () => ({ writeFile: args => { write = args; args.success({}); } });
  global.wx.shareFileMessage = args => { shared = args; args.success({}); };
  await page.exportLogs(); assert.equal(write.filePath, 'wxfile://user/campus-ledger-export.csv');
  assert.equal(shared.filePath, write.filePath); assert.ok(write.data.includes('12.50')); assert.match(page.data.notice, /已导出/);
});
test('a command failing before its first frame can resume only the exact saved business id and fields', async () => {
  const { page } = loadPage();
  page.client.request = async () => { throw new Error('write failed before first frame'); };
  await page.submitTrade();
  const original = page.book.get('board'); assert.ok(original); assert.equal(page.data.canResume, true);
  // Editing the visible form must not change the saved operation being resumed.
  page.setData({ amount:'99', scene:'超市', tradeKind:'spend' });
  let dialogs = 0; global.wx.showModal = args => { dialogs++; args.success({ confirm:true }); };
  const requests = [];
  page.client.request = async request => {
    requests.push(request);
    if (request.op === 'result') return { ok:true, op:'result', result:null, pending:null };
    if (request.op === 'state') return { ok:true, op:'state', pending:null };
    return { ok:true, op:'arm', pending:{ id:request.id, kind:request.kind, amountCents:request.amountCents, phase:'waiting' } };
  };
  await page.resumeOriginal();
  assert.equal(dialogs, 1); assert.deepEqual(requests.map(request => request.op), ['result', 'state', 'result', 'state', 'arm']);
  assert.deepEqual(requests[4], { op:'arm', id:original.id, kind:'topup', amountCents:5000, scene:'充值' });
  assert.equal(page.book.get('board').id, original.id); assert.equal(page.data.canTrade, false); assert.equal(page.data.canResume, false);
});
test('an uncertain device transaction cannot be resumed or cancelled', async () => {
  const { page } = loadPage(); const entry = page.book.begin('board', { op:'arm', kind:'spend', amountCents:1250, scene:'食堂' });
  page.applyState({ pending:{ id:entry.id, kind:'spend', phase:'uncertain' } });
  let calls = 0; page.client.request = async () => { calls++; }; global.wx.showModal = () => { calls++; };
  await page.resumeOriginal();
  assert.equal(calls, 0); assert.equal(page.data.canResume, false); assert.equal(page.data.canCancel, false);
});
test('a terminal original result found during preflight never sends arm again', async () => {
  const { page } = loadPage(); const entry = page.book.begin('board', { op:'arm', kind:'spend', amountCents:1250, scene:'食堂' }); page.refreshLock();
  const requests = []; let dialogs = 0; global.wx.showModal = () => { dialogs++; };
  page.client.request = async request => {
    requests.push(request);
    return request.op === 'result'
      ? { ok:true, op:'result', pending:null, result:{ id:entry.id, kind:'spend', status:'success', balanceCents:3750 } }
      : { ok:true, op:'state', pending:null };
  };
  await page.resumeOriginal();
  assert.deepEqual(requests.map(request => request.op), ['result', 'state']); assert.equal(dialogs, 0);
  assert.equal(page.book.get('board'), null); assert.equal(page.data.canTrade, true);
});
test('a task becoming uncertain while confirming resumption prevents the resend', async () => {
  const { page } = loadPage(); const entry = page.book.begin('board', { op:'arm', kind:'topup', amountCents:5000, scene:'充值' }); page.refreshLock();
  let confirming = false; global.wx.showModal = args => { confirming = true; args.success({ confirm:true }); };
  const requests = [];
  page.client.request = async request => {
    requests.push(request);
    return { ok:true, op:request.op, result:null, pending:confirming ? { id:entry.id, phase:'uncertain', kind:'topup' } : null };
  };
  await page.resumeOriginal();
  assert.equal(requests.filter(request => request.op === 'arm').length, 0); assert.ok(page.book.get('board')); assert.equal(page.data.canResume, false);
});
test('RESULT_EXPIRED clears only the original order and never resends with another id', async () => {
  const { page } = loadPage(); const entry = page.book.begin('board', { op:'arm', kind:'topup', amountCents:5000, scene:'充值' }); page.refreshLock();
  const requests = []; let dialogs = 0; global.wx.showModal = () => { dialogs++; };
  page.client.request = async request => {
    requests.push(request); const response = { ok:false, op:'result', code:'RESULT_EXPIRED', pending:null, message:'明细过期' };
    page.applyState(response);
    const error = new Error(response.message); error.response = response; throw error;
  };
  await page.resumeOriginal();
  assert.deepEqual(requests, [{ op:'result', id:entry.id }]); assert.equal(dialogs, 0);
  assert.equal(page.book.get('board'), null); assert.equal(page.data.canTrade, true); assert.equal(page.data.canResume, false);
  assert.match(page.data.notice, /原订单已处理、明细过期/); assert.equal(page.data.errorText, '');
});
test('cancellation, expiry and decline events release the matching local order even with ok=false', () => {
  for (const status of ['cancelled', 'expired', 'declined']) {
    const { page } = loadPage(); const entry = page.book.begin('board', { op:'arm', kind:'spend', amountCents:1250, scene:'食堂' });
    page.applyState({ ok:false, event:'transaction', pending:null, lastResult:{ id:entry.id, kind:'spend', status, message:status } });
    assert.equal(page.book.get('board'), null, status); assert.equal(page.data.canTrade, true, status); assert.equal(page.data.canResume, false, status);
  }
});

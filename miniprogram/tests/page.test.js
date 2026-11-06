const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { OPERATION_KEY } = require('../utils/business');
function loadPage() {
  let definition;
  const stored = {};
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
  page.applyState({ pending:null, lastResult:{ id:entry.id, kind:'spend', status:'success', amountCents:1250, balanceCents:3750, message:'消费成功', timestamp:0 } });
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

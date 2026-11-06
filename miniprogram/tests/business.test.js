const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMoney, money, makeOperation, originalCommand, OperationBook, decorateResult } = require('../utils/business');
function storage() { const values = {}; return { getStorageSync:key => values[key], setStorageSync:(key, value) => { values[key] = JSON.parse(JSON.stringify(value)); } }; }

test('amounts use exact integer cents and enforce positive bounds', () => {
  assert.equal(parseMoney('12.50'), 1250); assert.equal(parseMoney('0.01'), 1);
  assert.equal(parseMoney('1000000.00'), 100000000); assert.equal(parseMoney('0.29'), 29);
  assert.equal(money(3750), '37.50'); assert.equal(money(1), '0.01');
  for (const amount of ['0', '-1', '1.234', '1e2', 'NaN', '1,000', '1000000.01', '0001', '']) assert.throws(() => parseMoney(amount), amount);
});
test('profile limits use UTF-8 bytes and reject control characters', () => {
  assert.equal(makeOperation('issue', { name:'张三', studentNo:'20260001' }).name, '张三');
  assert.throws(() => makeOperation('issue', { name:'一'.repeat(9), studentNo:'1' }), /过长/);
  assert.throws(() => makeOperation('issue', { name:'', studentNo:'1' }), /姓名/);
  assert.throws(() => makeOperation('spend', { amount:'1', scene:'食堂\n超市' }), /控制字符/);
});
test('business id survives process restart and uncertain responses, and blocks duplicate creation', () => {
  const saved = storage(); const first = new OperationBook(saved, () => 1790000000000, () => 0);
  const entry = first.begin('board-A', { op:'arm', kind:'topup', amountCents:5000 });
  assert.match(entry.id, /^[0-9a-f]{16}$/); assert.throws(() => first.begin('board-A', { kind:'topup' }), /核对/);
  const restored = new OperationBook(saved); assert.deepEqual(restored.get('board-A'), entry);
  restored.reconcile('board-A', { pending:null, result:null }); assert.equal(restored.get('board-A').id, entry.id);
  restored.reconcile('board-A', { result:{ id:entry.id, status:'uncertain' } }); assert.equal(restored.get('board-A').id, entry.id);
  restored.reconcile('board-B', { result:{ id:entry.id, status:'success' } }); assert.equal(restored.get('board-A').id, entry.id);
  restored.reconcile('board-A', { result:{ id:entry.id, status:'success' } }); assert.equal(restored.get('board-A'), null);
});
test('terminal cancellation/expiry releases only the matching id; clock rollback does not reuse ids', () => {
  const saved = storage(); const book = new OperationBook(saved, () => 1790000000000, () => 0);
  const first = book.begin('A', { kind:'spend' });
  book.reconcile('A', { lastResult:{ id:'ffffffffffffffff', status:'expired' } }); assert.ok(book.get('A'));
  book.reconcile('A', { lastResult:{ id:first.id, status:'expired' } });
  const second = new OperationBook(saved, () => 100, () => 0).begin('A', { kind:'spend' });
  assert.notEqual(first.id, second.id);
});
test('a storage failure prevents a new command from being returned', () => {
  const book = new OperationBook({ getStorageSync:() => null, setStorageSync:() => { throw new Error('disk full'); } });
  assert.throws(() => book.begin('A', { kind:'topup' }), /disk full/); assert.equal(book.get('A'), null);
});
test('unclocked logs are labeled rather than inventing transaction times', () => {
  assert.equal(decorateResult({ kind:'spend', status:'success', amountCents:1250, balanceCents:3750, timestamp:0 }).timeText, '设备未校时');
});
test('resuming an original command strips only local metadata and preserves business fields', () => {
  const original = { op:'arm', id:'1234567890abcdef', kind:'issue', name:'小明', studentNo:'20260001' };
  assert.deepEqual(originalCommand({ ...original, savedAt:Date.now() }), original);
  assert.throws(() => originalCommand({ op:'arm', id:'bad', kind:'topup', amountCents:5000, scene:'充值' }));
  assert.throws(() => originalCommand({ op:'arm', id:original.id, kind:'spend', amountCents:0, scene:'食堂' }));
});

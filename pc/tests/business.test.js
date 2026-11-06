const { test } = require('node:test');
const assert = require('node:assert/strict');
const business = require('../../miniprogram/utils/business');
const catalog = require('../../miniprogram/utils/catalog');
const logs = require('../../miniprogram/utils/logs');
const { DemoClient } = require('../js/demo');
const model = require('../js/model');
function storage() { const values = new Map(); return { getStorageSync: key => values.get(key), setStorageSync: (key, value) => values.set(key, JSON.parse(JSON.stringify(value))) }; }
const command = (id, kind, amountCents) => ({ op: 'arm', id, kind, amountCents, scene: kind === 'topup' ? '充值' : '食堂' });
test('demo separates arm from scan, debits once, isolates cards, and returns all paginated logs', async t => {
  const client = new DemoClient(storage()); await client.connect(); t.after(() => client.disconnect());
  const id = '0000000000000011';
  await client.request(command(id, 'spend', 1250)); assert.equal(client.data.cards.A.balanceCents, 5000);
  assert.equal(client.data.pending.phase, 'waiting'); client.scan(); assert.equal(client.data.cards.A.balanceCents, 3750);
  await client.request(command(id, 'spend', 1250)); client.scan(); assert.equal(client.data.cards.A.balanceCents, 3750); assert.equal(client.data.logs.length, 1);
  client.selectCard('B'); await client.request({ op: 'arm', id: '0000000000000012', kind: 'issue', name: '小雨', studentNo: '20260002' }); client.scan();
  assert.equal(client.data.cards.B.balanceCents, 0); assert.equal(client.data.cards.A.balanceCents, 3750);
  client.selectCard('A');
  for (let index = 20; index < 35; index++) { await client.request(command(index.toString(16).padStart(16, '0'), 'topup', 100)); client.scan(); }
  const result = await logs.loadAllLogs(body => client.request(body)); assert.equal(result.length, 17); assert.equal(new Set(result.map(item => item.id)).size, 17);
});
test('demo interrupted card writing recovers the original card without adding a second debit', async t => {
  const client = new DemoClient(storage()); await client.connect(); t.after(() => client.disconnect());
  client.interruptNext = true; await client.request(command('0000000000000011', 'spend', 1000)); client.scan();
  assert.equal(client.data.cards.A.balanceCents, 4000); assert.equal(client.data.pending.phase, 'uncertain');
  await assert.rejects(client.request({ op: 'cancel' }), error => error.response.code === 'BUSY');
  client.selectCard('B'); client.scan(); assert.equal(client.data.pending.phase, 'uncertain');
  client.selectCard('A'); client.scan(); assert.equal(client.data.pending, null); assert.equal(client.data.cards.A.balanceCents, 4000); assert.equal(client.data.logs.length, 1);
});
test('demo rejects changed fields under the same pending or completed business id', async t => {
  const client = new DemoClient(storage()); await client.connect(); t.after(() => client.disconnect());
  const id = '000000000000002a'; await client.request(command(id, 'topup', 1000));
  await assert.rejects(client.request(command(id, 'topup', 2000)), error => error.response.code === 'ID_CONFLICT');
  client.scan(); assert.equal(client.data.cards.A.balanceCents, 6000);
  await assert.rejects(client.request(command(id, 'topup', 2000)), error => error.response.code === 'ID_CONFLICT');
  await client.request(command(id.toUpperCase(), 'topup', 1000)); assert.equal(client.data.cards.A.balanceCents, 6000);
});
test('a saved PC original id survives closing before transmission and can resume only the same command', async t => {
  const values = storage(), book = new business.OperationBook(values, () => 1800000000000, () => 0.5);
  const entry = book.begin('DEMO-LOCAL', business.makeOperation('topup', { amount: '20', scene: '充值' }));
  const reopened = new business.OperationBook(values); assert.equal(reopened.get('DEMO-LOCAL').id, entry.id);
  const client = new DemoClient(values); await client.connect(); t.after(() => client.disconnect());
  const original = business.originalCommand(entry); await client.request(original); client.scan();
  const state = await client.request({ op: 'result', id: entry.id }); reopened.reconcile('DEMO-LOCAL', state);
  assert.equal(reopened.get('DEMO-LOCAL'), null); assert.equal(client.data.cards.A.balanceCents, 7000);
  await client.request(original); client.scan(); assert.equal(client.data.cards.A.balanceCents, 7000);
});
test('PC trade lock respects another client waiting, uncertainty, device storage and busy state', () => {
  const ready = { device: { readerReady: true, storageReady: true } };
  assert.equal(model.canTrade(ready, null, false, true), true);
  for (const pending of [{ phase: 'waiting' }, { phase: 'uncertain' }]) assert.equal(model.canTrade({ ...ready, pending }, null, false, true), false);
  assert.equal(model.canTrade(ready, { id: 'original' }, false, true), false); assert.equal(model.canTrade(ready, null, true, true), false);
  assert.equal(model.canTrade({ device: { readerReady: true, storageReady: false } }, null, false, true), false);
});
test('browser storage, filtered statistics and CSV preserve cents and neutralize formula cells', () => {
  const memory = new Map(), adapter = model.browserStorage({ getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) });
  const configured = catalog.defaultCatalog(); catalog.saveCatalog(adapter, configured); assert.deepEqual(catalog.loadCatalog(adapter), configured);
  const values = [{ id: '0000000000000001', kind: 'topup', status: 'success', cardNo: 1, scene: '=HYPERLINK("evil")', amountCents: 1000, balanceCents: 1000, timestamp: 0 }, { id: '0000000000000002', kind: 'spend', status: 'declined', cardNo: 1, scene: '食堂', amountCents: 5000, balanceCents: 1000, timestamp: 0 }];
  assert.equal(catalog.summarizeLogs(values).netCents, 1000); assert.equal(catalog.summarizeLogs(values).spendCents, 0);
  assert.equal(catalog.filterLogs(values, { status: 'success', kind: 'all', cardNo: '1' }).length, 1);
  const csv = catalog.logsToCsv(values); assert.equal(csv.charCodeAt(0), 0xFEFF); assert.match(csv, /'=HYPERLINK/); assert.match(csv, /10\.00/); assert.match(csv, /设备未校时/);
  const layout = model.previewLayout({ balanceCents: 100000000, name: '小明', cardNo: 1 }, { fontSize: 32 }); assert.equal(layout.fontSize, 16); assert.equal(layout.amount, '1000000.00');
});

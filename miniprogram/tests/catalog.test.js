const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const catalog = require('../utils/catalog');
const rows = [
  { id: '0000000000000001', cardNo: 10000001, kind: 'topup', status: 'success', amountCents: 5000, balanceCents: 5000, scene: '食堂', timestamp: 0 },
  { id: '0000000000000002', cardNo: 10000001, kind: 'spend', status: 'declined', amountCents: 9000, balanceCents: 5000, scene: '食堂', timestamp: 0 },
  { id: '0000000000000003', cardNo: 10000001, kind: 'spend', status: 'success', amountCents: 1250, balanceCents: 3750, scene: '超市', timestamp: 0 },
  { id: '0000000000000004', cardNo: 10000002, kind: 'spend', status: 'success', amountCents: 2000, balanceCents: 8000, scene: '食堂', timestamp: 0 }
];

test('catalog directories persist as local copies and validate integer cents and UTF-8 limits', () => {
  const store = {}; const storage = { getStorageSync: key => store[key], setStorageSync: (key, value) => { store[key] = JSON.parse(JSON.stringify(value)); } };
  const defaults = catalog.loadCatalog(storage); defaults.products[0].name = '包子'; defaults.products[0].amountCents = 250;
  catalog.saveCatalog(storage, defaults);
  assert.equal(catalog.loadCatalog(storage).products[0].name, '包子');
  assert.equal(catalog.defaultCatalog().products[0].name, '早餐');
  assert.throws(() => catalog.validateCatalog({ products: [{ id: 'a', name: '中文'.repeat(5), amountCents: 100, scene: '食堂' }], topups: [100] }), /过长/);
  assert.throws(() => catalog.validateCatalog({ products: [], topups: [100, 100] }), /重复/);
  assert.throws(() => catalog.validateCatalog({ products: [], topups: [1.5] }), /有效金额/);
  assert.throws(() => catalog.validateCatalog({ products: [], topups: [] }), /充值档位/);
  assert.throws(() => catalog.saveCatalog({ setStorageSync() { throw new Error('full'); } }, defaults), /full/);
});
test('history filters compose and only successful stored-value changes enter monetary totals', () => {
  const filtered = catalog.filterLogs(rows, { cardNo: '000001', scene: '食', status: 'all' });
  assert.deepEqual(filtered.map(item => item.id), [rows[0].id, rows[1].id]);
  assert.deepEqual(catalog.summarizeLogs(filtered), { count: 2, successCount: 1, topupCents: 5000, spendCents: 0, netCents: 5000 });
  assert.deepEqual(catalog.summarizeLogs(rows), { count: 4, successCount: 3, topupCents: 5000, spendCents: 3250, netCents: 1750 });
  assert.equal(catalog.filterLogs(rows, { kind: 'spend', status: 'success' }).length, 2);
});
test('CSV preserves commas, quotes and line breaks while neutralizing spreadsheet formulas', () => {
  const csv = catalog.logsToCsv([{ ...rows[0], scene: ' =SUM(1,2)\n"quoted"', message: '@malicious' }]);
  assert.equal(csv[0], '\uFEFF'); assert.ok(csv.endsWith('\r\n'));
  assert.ok(csv.includes('"\' =SUM(1,2)\n""quoted"""'));
  assert.ok(csv.includes('"\'@malicious"')); assert.ok(csv.includes('"50.00"')); assert.ok(csv.includes('设备未校时'));
});
test('unread or uncertain balances are not exported as a confirmed zero or old value', () => {
  const csv = catalog.logsToCsv([
    { ...rows[0], status: 'expired', cardNo: 0, balanceCents: 0 },
    { ...rows[0], status: 'uncertain', balanceCents: 5000 }
  ]);
  assert.ok(csv.includes('未读取')); assert.ok(csv.includes('待核对'));
  const { decorateResult } = require('../utils/business');
  assert.equal(decorateResult({ ...rows[0], cardNo: 0, status: 'cancelled' }).balanceText, '未读取');
  assert.equal(decorateResult({ ...rows[0], status: 'uncertain' }).amountPrefix, '');
  assert.equal(decorateResult({ ...rows[0], balanceCents: 0 }).balanceText, '0.00');
});
test('the same pure modules execute in browser globals and CommonJS without bundling', async () => {
  const context = vm.createContext({});
  for (const file of ['protocol', 'business', 'logs', 'catalog']) vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../utils', file + '.js'), 'utf8'), context);
  assert.equal(context.CampusBusiness.parseMoney('12.50'), 1250);
  assert.equal(context.CampusProtocol.packets({ op: 'state' }, 1)[0][0], 0xC7);
  assert.equal(context.CampusCatalog.defaultCatalog().topups[0], 1000);
  assert.equal(typeof context.CampusLogs.loadAllLogs, 'function');
  const result = await context.CampusLogs.loadAllLogs(async () => ({ logs: rows })); assert.equal(result.length, 4);
});

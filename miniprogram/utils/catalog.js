(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./business'));
  else root.CampusCatalog = factory(root.CampusBusiness);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (business) {
const { textField, money, decorateResult } = business;
const CATALOG_KEY = 'campus.catalog.v1';
const MAX_AMOUNT = 100000000;
function defaultCatalog() {
  return {
    products: [
      { id: 'breakfast', name: '早餐', amountCents: 500, scene: '食堂' },
      { id: 'lunch', name: '午餐', amountCents: 1250, scene: '食堂' },
      { id: 'drink', name: '饮料', amountCents: 300, scene: '超市' },
      { id: 'bus', name: '公交', amountCents: 100, scene: '公交' }
    ],
    topups: [1000, 2000, 5000, 10000]
  };
}
function validAmount(value) { return Number.isInteger(value) && value > 0 && value <= MAX_AMOUNT; }
function validateCatalog(value) {
  if (!value || !Array.isArray(value.products) || value.products.length > 12 || !Array.isArray(value.topups) || !value.topups.length || value.topups.length > 8) throw new Error('最多配置 12 个商品和 1–8 个充值档位');
  const ids = new Set();
  const products = value.products.map(item => {
    if (!item || !/^[a-z0-9_-]{1,32}$/i.test(item.id || '') || ids.has(item.id)) throw new Error('商品编号无效或重复');
    ids.add(item.id);
    if (!validAmount(item.amountCents)) throw new Error('商品金额须大于 0 且不超过 1,000,000.00 元');
    return { id: item.id, name: textField(item.name, '商品名称', 24), amountCents: item.amountCents, scene: textField(item.scene, '消费场景', 24) };
  });
  const unique = new Set();
  const topups = value.topups.map(amount => {
    if (!validAmount(amount) || unique.has(amount)) throw new Error('充值档位须为不重复的有效金额');
    unique.add(amount); return amount;
  });
  return { products, topups };
}
function loadCatalog(storage) {
  const value = storage.getStorageSync(CATALOG_KEY);
  return value === undefined || value === null || value === '' ? defaultCatalog() : validateCatalog(value);
}
function saveCatalog(storage, value) {
  const valid = validateCatalog(value);
  storage.setStorageSync(CATALOG_KEY, valid);
  return valid;
}
function filterLogs(logs, filters = {}) {
  const cardNo = String(filters.cardNo || '').trim().toLowerCase();
  const scene = String(filters.scene || '').trim().toLowerCase();
  return logs.filter(item => item && (!cardNo || String(item.cardNo || '').toLowerCase().includes(cardNo)) &&
    (!scene || String(item.scene || '').toLowerCase().includes(scene)) &&
    (!filters.status || filters.status === 'all' || item.status === filters.status) &&
    (!filters.kind || filters.kind === 'all' || item.kind === filters.kind));
}
function summarizeLogs(logs) {
  const summary = { count: logs.length, successCount: 0, topupCents: 0, spendCents: 0, netCents: 0 };
  for (const item of logs) {
    if (!item || item.status !== 'success') continue;
    summary.successCount++;
    if (!Number.isSafeInteger(item.amountCents) || item.amountCents < 0) continue;
    if (item.kind === 'topup') summary.topupCents += item.amountCents;
    else if (item.kind === 'spend') summary.spendCents += item.amountCents;
  }
  summary.netCents = summary.topupCents - summary.spendCents;
  return summary;
}
function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // Quoting alone does not prevent spreadsheet formula execution.
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
function logsToCsv(logs) {
  const rows = [['订单编号', '业务类型', '状态', '卡号', 'UID', '场景', '金额（元）', '余额（元）', '设备时间', '结果说明']];
  for (const item of logs) {
    const row = decorateResult(item);
    rows.push([item.id, row.kindText, row.statusText, item.cardNo, item.uid, item.scene,
      money(item.amountCents), row.balanceText, row.timeText, item.message]);
  }
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
return { CATALOG_KEY, defaultCatalog, validateCatalog, loadCatalog, saveCatalog, filterLogs, summarizeLogs, logsToCsv };
});

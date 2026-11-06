(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CampusLogs = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const PAGE_SIZE = 5;
const MAX_LOGS = 20;
const invalid = () => new Error('交易流水分页不完整，请重新刷新');

async function readSnapshot(request) {
  let offset = 0, revision, total;
  const logs = [], ids = new Set();
  for (let count = 0; count <= MAX_LOGS; count++) {
    const command = { op: 'logs', offset, limit: PAGE_SIZE };
    if (revision !== undefined) command.revision = revision;
    const page = await request(command);
    if (!page || !Array.isArray(page.logs) || page.logs.length > MAX_LOGS) throw invalid();
    const paged = has(page, 'nextOffset');
    if (!paged && offset !== 0) throw invalid();
    if (paged) {
      if (!/^[0-9a-f]{8}$/i.test(page.revision || '') || !Number.isInteger(page.total) || page.total < 0 || page.total > MAX_LOGS || page.logs.length > PAGE_SIZE) throw invalid();
      if (revision === undefined) { revision = page.revision; total = page.total; }
      if (page.revision !== revision || page.total !== total || page.logs.length !== Math.min(PAGE_SIZE, total - offset)) throw invalid();
    }
    for (const item of page.logs) {
      if (!item || typeof item !== 'object' || !/^[0-9a-f]{16}$/i.test(item.id || '') || ids.has(item.id)) throw invalid();
      ids.add(item.id); logs.push(item);
    }
    if (!paged) return logs; // Compatibility with the original single-page firmware.
    const expected = offset + page.logs.length;
    if (page.nextOffset === null) {
      if (expected !== total) throw invalid();
      return logs;
    }
    if (!Number.isInteger(page.nextOffset) || page.nextOffset !== expected || page.nextOffset <= offset || page.nextOffset >= total) throw invalid();
    offset = page.nextOffset;
  }
  throw invalid();
}

async function loadAllLogs(request) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await readSnapshot(request); }
    catch (error) {
      if (attempt === 0 && error.response && error.response.code === 'LOG_SNAPSHOT_EXPIRED') continue;
      throw error;
    }
  }
}
return { loadAllLogs };
});

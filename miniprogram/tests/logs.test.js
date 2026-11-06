const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadAllLogs } = require('../utils/logs');
const rows = (count, start = 1) => Array.from({ length: count }, (_, index) => ({ id: (start + index).toString(16).padStart(16, '0'), kind: 'topup', status: 'success', amountCents: 100, balanceCents: 100 }));
const page = (records, offset, revision = '1234abcd') => ({ ok: true, op: 'logs', logs: records.slice(offset, offset + 5), total: records.length, revision, nextOffset: offset + 5 < records.length ? offset + 5 : null });

test('all 20 records are read through one stable snapshot in consecutive five-record pages', async () => {
  const records = rows(20), commands = [];
  const result = await loadAllLogs(async command => { commands.push(command); return page(records, command.offset); });
  assert.deepEqual(result, records);
  assert.deepEqual(commands, [
    { op: 'logs', offset: 0, limit: 5 },
    { op: 'logs', offset: 5, limit: 5, revision: '1234abcd' },
    { op: 'logs', offset: 10, limit: 5, revision: '1234abcd' },
    { op: 'logs', offset: 15, limit: 5, revision: '1234abcd' }
  ]);
});
test('an expired snapshot restarts once and discards every record from the old snapshot', async () => {
  const old = rows(8), current = rows(7, 20), offsets = []; let round = 0;
  const result = await loadAllLogs(async command => {
    offsets.push(command.offset);
    if (command.offset === 0) round++;
    if (round === 1 && command.offset === 5) { const error = new Error('expired'); error.response = { code: 'LOG_SNAPSHOT_EXPIRED' }; throw error; }
    return page(round === 1 ? old : current, command.offset, round === 1 ? '11111111' : '22222222');
  });
  assert.deepEqual(result, current); assert.deepEqual(offsets, [0, 5, 0, 5]);
});
test('snapshot expiration retries are bounded and ordinary transport failures are never retried', async () => {
  let calls = 0;
  await assert.rejects(loadAllLogs(async () => { calls++; const error = new Error('expired'); error.response = { code: 'LOG_SNAPSHOT_EXPIRED' }; throw error; }), /expired/);
  assert.equal(calls, 2); calls = 0;
  await assert.rejects(loadAllLogs(async () => { calls++; throw new Error('disconnected'); }), /disconnected/);
  assert.equal(calls, 1);
});
test('legacy single-page firmware and empty paginated history are both supported', async () => {
  const records = rows(10);
  assert.deepEqual(await loadAllLogs(async () => ({ ok: true, op: 'logs', logs: records })), records);
  assert.deepEqual(await loadAllLogs(async () => page([], 0)), []);
});
test('changed revisions, duplicate records, missing rows and non-advancing offsets are rejected', async () => {
  const records = rows(8);
  const variants = [
    (body, offset) => offset ? { ...body, revision: 'deadbeef' } : body,
    (body, offset) => offset ? { ...body, logs: [{ ...body.logs[0], id: records[0].id }, ...body.logs.slice(1)] } : body,
    body => ({ ...body, logs: body.logs.slice(1) }),
    (body, offset) => offset ? body : { ...body, nextOffset: 0 },
    (body, offset) => offset ? body : { ...body, nextOffset: 8 },
    (body, offset) => offset ? { ...body, total: 9 } : body
  ];
  for (const change of variants) {
    await assert.rejects(loadAllLogs(async command => change(page(records, command.offset), command.offset)), /分页不完整/);
  }
});

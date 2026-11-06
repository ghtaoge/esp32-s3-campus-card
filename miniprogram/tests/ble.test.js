const { test } = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../utils/protocol');
const { CampusClient } = require('../utils/ble');

function mockWx(onWrite) {
  const handlers = {};
  const wx = {
    onBluetoothDeviceFound:fn => { handlers.found = fn; }, onBLECharacteristicValueChange:fn => { handlers.value = fn; }, onBLEConnectionStateChange:fn => { handlers.connection = fn; },
    offBluetoothDeviceFound() {}, offBLECharacteristicValueChange() {}, offBLEConnectionStateChange() {},
    stopBluetoothDevicesDiscovery:args => args.success({}), closeBLEConnection:args => args.success({}), closeBluetoothAdapter:args => args.success({}),
    writeBLECharacteristicValue:args => onWrite(args)
  };
  return { wx, handlers };
}
function readyClient(mock, events = {}, options = {}) {
  global.wx = mock.wx;
  const client = new CampusClient(events, Object.assign({ writeDelay:0, timeout:500 }, options));
  client.device = { deviceId:'board' }; client.serviceId = protocol.SERVICE_UUID; client.writeId = protocol.WRITE_UUID; client.notifyId = protocol.NOTIFY_UUID; client.ready = true;
  return client;
}
function notify(mock, body, id) {
  for (const frame of protocol.packets(body, id, 0xC8)) mock.handlers.value({ deviceId:'board', serviceId:protocol.SERVICE_UUID, characteristicId:protocol.NOTIFY_UUID, value:frame.buffer });
}

test('requests serialize writes, ignore unrelated responses and receive unsolicited events', async () => {
  const writes = []; let busy = false; const events = [];
  const mock = mockWx(args => {
    assert.equal(busy, false, 'writes must not overlap'); busy = true;
    const frame = new Uint8Array(args.value); writes.push(frame);
    setImmediate(() => {
      busy = false; args.success({});
      const offset = frame[4] | frame[5] << 8, total = frame[6] | frame[7] << 8;
      if (offset + frame.length - 8 === total) {
        const id = frame[2] | frame[3] << 8;
        notify(mock, { ok:true, op:'state', pending:null }, id + 20);
        notify(mock, { event:'card', card:{ balanceCents:3750 } }, 0);
        notify(mock, { ok:true, op:'state', pending:null }, id);
      }
    });
  });
  const client = readyClient(mock, { onState:state => events.push(state) });
  const result = await client.request({ op:'state', name:'中文跨片段' });
  assert.equal(result.ok, true); assert.ok(writes.every(frame => frame.length <= 20));
  assert.equal(events.length, 2); assert.equal(events[0].event, 'card');
  await client.destroy();
});
test('transport timeout rejects without resending a command or creating another business id', async () => {
  let writes = 0;
  const mock = mockWx(args => { writes++; args.success({}); });
  const client = readyClient(mock, {}, { timeout:200 });
  const command = { op:'arm', id:'1234567890abcdef', kind:'topup', amountCents:5000 };
  await assert.rejects(client.request(command), /原订单/);
  assert.equal(writes, protocol.packets(command, 1).length);
  assert.equal(client.pending, null); await client.destroy();
});
test('disconnect rejects the outstanding response and drops fragments from the old session', async () => {
  const mock = mockWx(args => { args.success({}); setImmediate(() => mock.handlers.connection({ deviceId:'board', connected:false })); });
  let disconnected = false; const client = readyClient(mock, { onConnection:value => { disconnected = !value; } });
  await assert.rejects(client.request({ op:'arm', id:'1234567890abcdef', kind:'spend', amountCents:100 }), /断开/);
  assert.equal(client.ready, false); assert.equal(disconnected, true); await client.destroy();
});
test('a stalled native write closes the connection before a later request can overlap it', async () => {
  let firstCallback, firstFrame, count = 0;
  const mock = mockWx(args => {
    count++;
    const frame = new Uint8Array(args.value);
    if (count === 1) { firstCallback = args.success; firstFrame = frame; return; }
    args.success({});
    const offset = frame[4] | frame[5] << 8, total = frame[6] | frame[7] << 8;
    if (offset + frame.length - 8 === total) notify(mock, { ok:true, op:'state' }, frame[2] | frame[3] << 8);
  });
  const client = readyClient(mock, {}, { timeout:100 });
  await assert.rejects(client.request({ op:'arm', kind:'topup', id:'0123456789abcdef', amountCents:5000 }), /原订单/);
  assert.equal(client.ready, false); assert.equal(client.device, null);
  await assert.rejects(client.request({ op:'state' }), /先连接/);
  assert.equal(count, 1);
  // Simulate a newly established connection. A late callback from the closed
  // connection still cannot resume its remaining old fragments.
  client.device = { deviceId: 'board' }; client.ready = true;
  const next = client.request({ op:'state' });
  firstCallback({});
  assert.equal((await next).ok, true);
  assert.equal(firstFrame[4], 0);
  assert.equal(count, 1 + protocol.packets({ op:'state' }, 2).length);
  await client.destroy();
});

test('hiding or destroying during adapter initialization cannot restart discovery later', async () => {
  for (const destroy of [false, true]) {
    let opened, starts = 0;
    const mock = mockWx(args => args.success({}));
    mock.wx.openBluetoothAdapter = args => { opened = args.success; };
    mock.wx.startBluetoothDevicesDiscovery = args => { starts++; args.success({}); };
    mock.wx.getBluetoothDevices = args => args.success({ devices: [] });
    const client = readyClient(mock);
    const scanning = client.scan();
    if (destroy) await client.destroy(); else await client.stopScan(true);
    opened({}); await scanning;
    assert.equal(starts, 0); assert.equal(client.scanTimer, undefined);
    if (!destroy) await client.destroy();
  }
});

test('destroying a pending connection stops service discovery and later protocol writes', async () => {
  let created, discovered = 0;
  const mock = mockWx(args => args.success({}));
  mock.wx.createBLEConnection = args => { created = args.success; };
  mock.wx.getBLEDeviceServices = args => { discovered++; args.success({ services: [] }); };
  const client = readyClient(mock, {}, { connectDelay: 0 });
  const connecting = client.connect({ deviceId: 'next-board' });
  await new Promise(resolve => setImmediate(resolve));
  await client.destroy(); created({});
  await assert.rejects(connecting, /连接已取消/);
  assert.equal(discovered, 0); assert.equal(client.ready, false);
});

test('reconnection waits until a timed-out native write connection has been closed', async () => {
  let oldWrite, closeOld, creates = 0, closes = 0;
  const mock = mockWx(args => { oldWrite = args.success; });
  mock.wx.closeBLEConnection = args => { if (++closes === 1) closeOld = args.success; else args.success({}); };
  mock.wx.createBLEConnection = args => { creates++; args.fail({ errMsg: 'test stops after reconnect starts' }); };
  const client = readyClient(mock, {}, { timeout: 80, connectDelay: 0 });
  await assert.rejects(client.request({ op: 'state' }), /原订单/);
  const connecting = client.connect({ deviceId: 'board' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(creates, 0);
  closeOld({}); await assert.rejects(connecting, error => /test stops/.test(error.errMsg)); assert.equal(creates, 1);
  oldWrite({}); await client.destroy();
});
test('scan merges name-less updates and filters by campus service or name', async () => {
  const devices = []; const mock = mockWx(args => args.success({}));
  const client = readyClient(mock, { onDevice:device => devices.push(device) });
  client.acceptDevices([{ deviceId:'A', localName:'S3-CAMPUS-0001' }, { deviceId:'A', RSSI:-42 }, { deviceId:'B', name:'other' }, { deviceId:'C', advertisServiceUUIDs:[protocol.SERVICE_UUID.toUpperCase()] }]);
  assert.equal(devices.length, 3); assert.equal(devices[1].name, 'S3-CAMPUS-0001'); assert.equal(devices[1].RSSI, -42);
  await client.destroy();
});

test('a late broken response from a timed-out id cannot corrupt a newer response', async () => {
  const errors = [];
  const mock = mockWx(args => {
    const frame = new Uint8Array(args.value); args.success({});
    if ((frame[2] | frame[3] << 8) !== 2 || (frame[4] | frame[5] << 8) + frame.length - 8 !== (frame[6] | frame[7] << 8)) return;
    const current = protocol.packets({ ok: true, op: 'state', pending: null }, 2, 0xC8);
    const stale = protocol.packets({ ok: true, op: 'arm', pending: null }, 1, 0xC8);
    const emit = value => mock.handlers.value({ deviceId: 'board', characteristicId: protocol.NOTIFY_UUID, value: value.buffer });
    emit(current[0]); emit(stale[1]); current.slice(1).forEach(emit);
  });
  const client = readyClient(mock, { onError: error => errors.push(error) }, { timeout: 80 });
  await assert.rejects(client.request({ op: 'state' }), /原订单/);
  assert.equal((await client.request({ op: 'state' })).ok, true);
  assert.equal(errors.length, 0); await client.destroy();
});

test('malformed unsolicited data reports its error without rejecting an unrelated RPC', async () => {
  const errors = [];
  const mock = mockWx(args => {
    const frame = new Uint8Array(args.value); args.success({});
    if ((frame[4] | frame[5] << 8) + frame.length - 8 !== (frame[6] | frame[7] << 8)) return;
    const current = protocol.packets({ ok: true, op: 'state', pending: null }, frame[2] | frame[3] << 8, 0xC8);
    mock.handlers.value({ deviceId: 'board', characteristicId: protocol.NOTIFY_UUID, value: current[0].buffer });
    const bad = protocol.packets({ event: 'card', card: null }, 0, 0xC8)[1];
    mock.handlers.value({ deviceId: 'board', characteristicId: protocol.NOTIFY_UUID, value: bad.buffer });
    current.slice(1).forEach(part => mock.handlers.value({ deviceId: 'board', characteristicId: protocol.NOTIFY_UUID, value: part.buffer }));
  });
  const client = readyClient(mock, { onError: error => errors.push(error) });
  assert.equal((await client.request({ op: 'state' })).ok, true);
  assert.equal(errors.length, 1); await client.destroy();
});

test('pages can apply each RPC once while still receiving unsolicited events', async () => {
  const states = [];
  const mock = mockWx(args => {
    const frame = new Uint8Array(args.value); args.success({});
    if ((frame[4] | frame[5] << 8) + frame.length - 8 !== (frame[6] | frame[7] << 8)) return;
    notify(mock, { event: 'card', card: null }, 0);
    notify(mock, { ok: true, op: 'state' }, frame[2] | frame[3] << 8);
  });
  const client = readyClient(mock, { onState: body => states.push(body) }, { emitResponses: false });
  assert.equal((await client.request({ op: 'state' })).ok, true);
  assert.deepEqual(states.map(body => body.event), ['card']); await client.destroy();
});

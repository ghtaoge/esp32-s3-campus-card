const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LineDecoder, RequestClient, SerialClient, BleClient } = require('../js/transport');
const protocol = require('../../miniprogram/utils/protocol');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function serialPort(write) {
  let input; const info = { closes: 0 };
  const port = { readable: new ReadableStream({ start(controller) { input = controller; } }), writable: new WritableStream({ write(bytes) { return write(bytes, packet => input.enqueue(new TextEncoder().encode(JSON.stringify(packet) + '\n'))); } }),
    async open() {}, async close() { info.closes++; } };
  return { port, info };
}
function bleDevice(writeAction) {
  const handlers = new Map(), info = { disconnects: 0 };
  const emit = frame => handlers.get('characteristicvaluechanged')?.({ target: { value: new DataView(frame.buffer, frame.byteOffset, frame.byteLength) } });
  const notify = { addEventListener(name, handler) { handlers.set(name, handler); }, removeEventListener(name) { handlers.delete(name); }, async startNotifications() {}, async stopNotifications() {} };
  const write = { writeValueWithResponse(frame) { return writeAction(frame, emit); } };
  const device = { name: 'S3-CAMPUS-TEST', addEventListener() {}, removeEventListener() {}, gatt: { connected: true, async connect() { this.connected = true; return { async getPrimaryService() { return { async getCharacteristic(uuid) { return uuid === protocol.WRITE_UUID ? write : notify; } }; } }; }, disconnect() { this.connected = false; info.disconnects++; } } };
  return { device, info };
}
function replyOnLastBleFrame(frame, emit, response = { ok: true }) {
  if ((frame[4] | frame[5] << 8) + frame.length - 8 === (frame[6] | frame[7] << 8)) for (const bytes of protocol.packets(response, frame[2] | frame[3] << 8, 0xC8)) emit(bytes);
}

test('USB line decoder preserves split UTF-8, CRLF and a partial following line', () => {
  const parser = new LineDecoder(), bytes = new TextEncoder().encode('boot\r\n{"id":1,"body":{"姓名":"小明🌱"}}\nlast');
  const lines = [];
  for (const byte of bytes) lines.push(...parser.push(new Uint8Array([byte])));
  assert.deepEqual(lines, ['boot', '{"id":1,"body":{"姓名":"小明🌱"}}']);
  assert.deepEqual(parser.push(new TextEncoder().encode(' line\n')), ['last line']);
});
test('an oversized serial line is bounded and decoding resumes after its newline', () => {
  const parser = new LineDecoder(5), encode = value => new TextEncoder().encode(value);
  assert.throws(() => parser.push(encode('123456')), /上限/);
  assert.deepEqual(parser.push(encode('ignored\nok\n')), ['ok']);
});
test('requests queue until complete matching replies and ignore stale response ids', async () => {
  const sent = [], states = [];
  class Client extends RequestClient { async sendRaw(packet) { sent.push(packet); } }
  const client = new Client({ onState: state => states.push(state) }, { timeout: 200 }); client.connected('test');
  const first = client.request({ op: 'state' }), second = client.request({ op: 'logs' }); await pause(0);
  assert.equal(sent.length, 1); client.receive({ id: 0, body: { event: 'card' } }); assert.equal(sent.length, 1);
  client.receive({ id: sent[0].id, body: { ok: true, op: 'state' } }); await first; await pause(0); assert.equal(sent.length, 2);
  client.receive({ id: sent[0].id, body: { ok: true, stale: true } });
  client.receive({ id: sent[1].id, body: { ok: true, op: 'logs', logs: [] } }); assert.equal((await second).op, 'logs');
  assert.equal(states.length, 3); assert.equal(states.some(state => state.stale), false); client.lost();
});
test('timeout and disconnect retain original bodies without retrying or admitting stale replies', async () => {
  const sent = [];
  class Client extends RequestClient { async sendRaw(packet) { sent.push(packet); } }
  const client = new Client({}, { timeout: 20 }); client.connected('test');
  const original = { op: 'arm', id: '0000000000000011', kind: 'topup', amountCents: 1000 };
  await assert.rejects(client.request(original), /超时/); assert.equal(sent.length, 1); assert.deepEqual(sent[0].body, original);
  const next = client.request({ op: 'state' }); await pause(0); const rejection = assert.rejects(next, /断开/);
  client.lost(); await rejection;
  client.receive({ id: sent[1].id, body: { ok: true } }); assert.equal(client.ready, false);
});
test('Web Serial opens at 115200, exchanges complete envelopes, and releases locks on disconnect', async () => {
  let controller, opened, closed = 0, cancelled = false;
  const encoder = new TextEncoder(), writes = [];
  const port = {
    readable: new ReadableStream({ start(value) { controller = value; }, cancel() { cancelled = true; } }),
    writable: new WritableStream({ write(bytes) {
      const packet = JSON.parse(new TextDecoder().decode(bytes)); writes.push(packet);
      const response = encoder.encode('ESP32 ready\n' + JSON.stringify({ id: packet.id, body: { ok: true, card: { name: '小明', balanceCents: 3750 } } }) + '\r\n');
      controller.enqueue(response.slice(0, 31)); controller.enqueue(response.slice(31));
    } }),
    async open(options) { opened = options; }, async close() { closed++; }
  };
  const diagnostics = [], client = new SerialClient({ onDiagnostic: text => diagnostics.push(text) }, { serial: { async requestPort() { return port; } }, timeout: 200 });
  await client.connect(); assert.deepEqual(opened, { baudRate: 115200 });
  const response = await client.request({ op: 'state' }); assert.equal(response.card.name, '小明'); assert.equal(writes[0].id, 1);
  assert.deepEqual(diagnostics, ['ESP32 ready']); await client.disconnect();
  assert.equal(cancelled, true); assert.equal(closed, 1); assert.equal(port.readable.locked, false); assert.equal(port.writable.locked, false);
});
test('Web Bluetooth uses shared framing and handles DataViews with a nonzero offset', async () => {
  const handlers = new Map(); let total = [], sent = 0, disconnected = false;
  const notify = { addEventListener(name, handler) { handlers.set(name, handler); }, removeEventListener(name) { handlers.delete(name); }, async startNotifications() {}, async stopNotifications() {} };
  const write = { async writeValueWithResponse(frame) {
    sent++; const offset = frame[4] | frame[5] << 8, length = frame[6] | frame[7] << 8;
    if (!offset) total = []; total.push(...frame.slice(8));
    if (total.length === length) {
      assert.equal(JSON.parse(new TextDecoder().decode(new Uint8Array(total))).op, 'state');
      const id = frame[2] | frame[3] << 8;
      for (const response of protocol.packets({ ok: true, message: '蓝牙就绪' }, id, 0xC8)) {
        const buffer = new Uint8Array(response.length + 6); buffer.set(response, 3);
        handlers.get('characteristicvaluechanged')({ target: { value: new DataView(buffer.buffer, 3, response.length) } });
      }
    }
  } };
  const service = { async getCharacteristic(uuid) { return uuid === protocol.WRITE_UUID ? write : notify; } };
  const device = { name: 'S3-CAMPUS-DEMO', addEventListener() {}, removeEventListener() {}, gatt: { connected: true, async connect() { return { async getPrimaryService() { return service; } }; }, disconnect() { disconnected = true; } } };
  const client = new BleClient({}, { bluetooth: { async requestDevice() { return device; } }, writeDelay: 0, timeout: 200 });
  await client.connect(); assert.equal((await client.request({ op: 'state' })).message, '蓝牙就绪'); assert.ok(sent > 1);
  await client.disconnect(); assert.equal(disconnected, true); assert.equal(handlers.size, 0);
});
test('an in-flight serial write timeout invalidates the session and reconnect waits for closure', async () => {
  let completeOld, choices = 0;
  const old = serialPort(() => new Promise(resolve => { completeOld = resolve; }));
  const fresh = serialPort((bytes, emit) => { const packet = JSON.parse(new TextDecoder().decode(bytes)); emit({ id: packet.id, body: { ok: true } }); });
  const client = new SerialClient({}, { serial: { async requestPort() { return ++choices === 1 ? old.port : fresh.port; } }, timeout: 20, closeTimeout: 500 });
  await client.connect(); await assert.rejects(client.request({ op: 'arm', id: '0000000000000001' }), /超时/);
  assert.equal(client.ready, false); assert.ok(client.closing);
  const reconnect = client.connect(); await pause(5); assert.equal(choices, 1); assert.equal(old.info.closes, 0);
  completeOld(); await reconnect; assert.equal(choices, 2); assert.equal(old.info.closes, 1);
  assert.equal((await client.request({ op: 'state' })).ok, true); await client.disconnect();
});
test('a serial native promise that never settles has bounded cleanup and cannot reuse the old port', async () => {
  let choices = 0; const diagnostics = [];
  const old = serialPort(() => new Promise(() => {}));
  const fresh = serialPort((bytes, emit) => { const packet = JSON.parse(new TextDecoder().decode(bytes)); emit({ id: packet.id, body: { ok: true } }); });
  const client = new SerialClient({ onDiagnostic: text => diagnostics.push(text) }, { serial: { async requestPort() { choices++; return choices <= 2 ? old.port : fresh.port; } }, timeout: 15, closeTimeout: 25 });
  await client.connect(); await assert.rejects(client.request({ op: 'state' }), /超时/); await pause(40);
  assert.equal(client.ready, false); assert.equal(client.closing, null); assert.ok(diagnostics.some(text => /关闭连接超时/.test(text)));
  await assert.rejects(client.request({ op: 'state' }), /先连接/); await assert.rejects(client.connect(), /仍在关闭/);
  await client.connect(); assert.equal((await client.request({ op: 'state' })).ok, true); await client.disconnect();
});
test('a GATT native write timeout disconnects immediately and a new chooser waits for old cleanup', async () => {
  let completeOld, choices = 0;
  const old = bleDevice(() => new Promise(resolve => { completeOld = resolve; }));
  const fresh = bleDevice(async (frame, emit) => replyOnLastBleFrame(frame, emit));
  const client = new BleClient({}, { bluetooth: { async requestDevice() { return ++choices === 1 ? old.device : fresh.device; } }, timeout: 20, closeTimeout: 500, writeDelay: 0 });
  await client.connect(); await assert.rejects(client.request({ op: 'state' }), /超时/); await pause(0);
  assert.equal(client.ready, false); assert.equal(old.info.disconnects, 1);
  const reconnect = client.connect(); await pause(5); assert.equal(choices, 1);
  completeOld(); await reconnect; assert.equal(choices, 2); assert.equal((await client.request({ op: 'state' })).ok, true); await client.disconnect();
});
test('a forever-pending GATT write cannot hold the UI closing state forever or affect a new connection', async () => {
  let choices = 0; const messages = [];
  const old = bleDevice(() => new Promise(() => {})), fresh = bleDevice(async (frame, emit) => replyOnLastBleFrame(frame, emit));
  const client = new BleClient({ onDiagnostic: text => messages.push(text) }, { bluetooth: { async requestDevice() { return ++choices === 1 ? old.device : fresh.device; } }, timeout: 15, closeTimeout: 25, writeDelay: 0 });
  await client.connect(); await assert.rejects(client.request({ op: 'state' }), /超时/); await pause(40);
  assert.equal(client.ready, false); assert.equal(client.closing, null); assert.ok(messages.some(text => /关闭连接超时/.test(text)));
  await client.connect(); assert.equal((await client.request({ op: 'state' })).ok, true); await client.disconnect();
});
test('stale or malformed BLE events do not reset an active response assembly', async () => {
  const received = [], messages = [];
  const sample = bleDevice(async (frame, emit) => {
    if ((frame[4] | frame[5] << 8) + frame.length - 8 !== (frame[6] | frame[7] << 8)) return;
    const id = frame[2] | frame[3] << 8, response = protocol.packets({ ok: true, message: '完整设备回应' }, id, 0xC8);
    emit(response[0]);
    emit(new Uint8Array([0xC8, 1, id + 1, 0, 0, 0, 255, 255, 7]));
    emit(new Uint8Array([0xC8, 1, 0, 0, 0, 0, 1, 0]));
    for (const bytes of protocol.packets({ ok: true, event: 'card' }, 0, 0xC8)) emit(bytes);
    response.slice(1).forEach(emit);
  });
  const client = new BleClient({ onState: state => received.push(state), onDiagnostic: text => messages.push(text) }, { bluetooth: { async requestDevice() { return sample.device; } }, timeout: 200, writeDelay: 0 });
  await client.connect(); assert.equal((await client.request({ op: 'state' })).message, '完整设备回应');
  assert.ok(received.some(state => state.event === 'card')); assert.ok(messages.length); await client.disconnect();
});
test('a completed BLE reply does not close a session during the final inter-frame delay', async () => {
  const sample = bleDevice(async (frame, emit) => replyOnLastBleFrame(frame, emit));
  const client = new BleClient({}, { bluetooth: { async requestDevice() { return sample.device; } }, timeout: 15, writeDelay: 40 });
  await client.connect(); assert.equal((await client.request({ op: 'x' })).ok, true); assert.equal(client.ready, true); assert.equal(sample.info.disconnects, 0); await client.disconnect();
});

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../../miniprogram/utils/protocol'));
  else root.CampusTransport = factory(root.CampusProtocol);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (protocol) {
  'use strict';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const retiredSerialPorts = new WeakSet(), retiredBleWriters = new WeakSet();
  class LineDecoder {
    constructor(maximum = 32768) { this.maximum = maximum; this.reset(); }
    reset() { this.decoder = new TextDecoder('utf-8'); this.buffer = ''; this.discard = false; }
    push(bytes) {
      let text = this.decoder.decode(bytes, { stream: true });
      if (this.discard) {
        const end = text.indexOf('\n');
        if (end < 0) return [];
        text = text.slice(end + 1); this.discard = false;
      }
      this.buffer += text;
      const lines = [];
      for (let end; (end = this.buffer.indexOf('\n')) >= 0;) {
        const line = this.buffer.slice(0, end).replace(/\r$/, ''); this.buffer = this.buffer.slice(end + 1);
        if (line.length > this.maximum) throw new Error('串口返回的单行过长，请重连后核对原订单');
        if (line.trim()) lines.push(line);
      }
      if (this.buffer.length > this.maximum) { this.buffer = ''; this.discard = true; throw new Error('串口行超过接收上限'); }
      return lines;
    }
  }
  class RequestClient {
    constructor(events = {}, options = {}) {
      this.events = events; this.options = options; this.ready = false; this.sequence = 0; this.chain = Promise.resolve(); this.session = null; this.pending = null;
      this.nativeWrites = new Map(); this.closing = null;
    }
    emit(name, ...values) { if (typeof this.events[name] === 'function') this.events[name](...values); }
    request(body) {
      const session = this.session;
      const operation = this.chain.catch(() => {}).then(async () => {
        if (!this.ready || !session || session !== this.session) throw new Error('请先连接终端');
        this.sequence = this.sequence % 65535 + 1;
        const id = this.sequence, token = { active: true, session };
        const response = new Promise((resolve, reject) => {
          this.pending = { id, token, resolve, reject, timer: setTimeout(() => {
            const error = new Error('终端响应超时，请核对原订单，不要重复创建交易');
            const stuckWrite = token.nativeInFlight;
            this.rejectPending(error, token);
            if (stuckWrite) {
              // A rejected JS request cannot cancel a write already queued in
              // the browser. Close this session before admitting another one.
              Promise.resolve(this.disconnect()).catch(closeError => this.emit('onDiagnostic', closeError.message || '浏览器尚未关闭连接，请断开设备后重试'));
            }
          }, this.options.timeout || 15000) };
        });
        const written = Promise.resolve().then(() => this.sendRaw({ id, body }, token)).catch(error => { this.rejectPending(error, token); throw error; });
        return (await Promise.all([response, written]))[0];
      });
      this.chain = operation; return operation;
    }
    rejectPending(error, token) {
      const pending = this.pending;
      if (!pending || (token && pending.token !== token)) return;
      this.pending = null; pending.token.active = false; clearTimeout(pending.timer); pending.reject(error);
    }
    async nativeWrite(token, action) {
      if (!token.active || token.session !== this.session) throw new Error('原发送会话已关闭');
      token.nativeInFlight = true;
      const operation = Promise.resolve().then(() => {
        if (!token.active || token.session !== this.session) throw new Error('原发送会话已关闭');
        return action();
      });
      this.nativeWrites.set(operation, token.session);
      try { return await operation; }
      finally { token.nativeInFlight = false; this.nativeWrites.delete(operation); }
    }
    closingOperation(action) {
      if (this.closing) return this.closing;
      this.lost();
      let timer;
      const work = Promise.resolve().then(action);
      const operation = Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('浏览器关闭连接超时。请重新插拔 USB 或重新选择蓝牙，再核对原订单。')), this.options.closeTimeout || 2000);
      })]);
      this.closing = operation;
      const release = () => { clearTimeout(timer); if (this.closing === operation) this.closing = null; };
      operation.then(release, release); return operation;
    }
    receive(packet) {
      if (!packet || !Number.isInteger(packet.id) || packet.id < 0 || packet.id > 65535 || !packet.body || typeof packet.body !== 'object' || Array.isArray(packet.body)) return;
      if (packet.id !== 0 && (!this.pending || packet.id !== this.pending.id)) return;
      this.emit('onState', packet.body);
      if (packet.id === 0) return;
      const pending = this.pending; this.pending = null; pending.token.active = false; clearTimeout(pending.timer);
      if (packet.body.ok === false) { const error = new Error(packet.body.message || packet.body.code || '终端拒绝了操作'); error.response = packet.body; pending.reject(error); }
      else pending.resolve(packet.body);
    }
    connected(label) { this.session = {}; this.ready = true; this.label = label; this.emit('onConnection', true, label); }
    lost(error = new Error('连接已断开，请重连后核对原订单')) {
      const wasReady = this.ready; this.ready = false; this.session = null; this.rejectPending(error);
      if (wasReady) this.emit('onConnection', false, this.label);
    }
  }
  class SerialClient extends RequestClient {
    constructor(events, options = {}) { super(events, options); this.api = options.serial || (typeof navigator !== 'undefined' && navigator.serial); this.decoder = new LineDecoder(); }
    async connect() {
      if (this.closing) await this.closing;
      if (!this.api) throw new Error('当前浏览器不支持 USB 串口，请使用桌面 Chrome 或 Edge 并从 localhost 打开');
      const port = await this.api.requestPort();
      if (retiredSerialPorts.has(port)) throw new Error('浏览器仍在关闭原串口，请重新插拔 USB 后选择设备，或重新打开此页面');
      this.port = port;
      try {
        await this.port.open({ baudRate: 115200 });
        this.writer = this.port.writable.getWriter(); this.reader = this.port.readable.getReader(); this.decoder.reset();
        this.connected('USB 串口'); const session = this.session; this.readTask = this.readLoop(session);
      } catch (error) { await this.disconnect().catch(() => {}); throw error; }
    }
    async sendRaw(packet, token) {
      if (!token.active || token.session !== this.session || !this.writer) throw new Error('串口会话已关闭');
      const bytes = new TextEncoder().encode(JSON.stringify(packet) + '\n');
      if (bytes.length > 768) throw new Error('串口请求过长，请缩短资料');
      const writer = this.writer;
      await this.nativeWrite(token, () => writer.write(bytes));
    }
    async readLoop(session) {
      const reader = this.reader;
      try {
        while (this.ready && this.session === session) {
          const result = await reader.read(); if (result.done) break;
          let lines;
          try { lines = this.decoder.push(result.value); }
          catch (error) { this.rejectPending(error); this.emit('onDiagnostic', error.message); continue; }
          for (const line of lines) {
            if (!line.trimStart().startsWith('{')) { this.emit('onDiagnostic', line); continue; }
            try { this.receive(JSON.parse(line)); }
            catch (_) { this.emit('onDiagnostic', '已忽略一行不完整的串口诊断内容'); }
          }
        }
      } catch (error) { if (session === this.session) this.emit('onDiagnostic', error.message || '串口已断开'); }
      finally {
        reader.releaseLock(); if (this.reader === reader) this.reader = null;
        if (session === this.session) { this.readTask = null; this.disconnect().catch(error => this.emit('onDiagnostic', error.message)); }
      }
    }
    async disconnect() {
      if (this.closing) return this.closing;
      const session = this.session, reader = this.reader, readTask = this.readTask, writer = this.writer, port = this.port;
      const native = Array.from(this.nativeWrites).filter(([, owner]) => owner === session).map(([operation]) => operation);
      this.reader = this.readTask = this.writer = this.port = null;
      if (port) retiredSerialPorts.add(port);
      return this.closingOperation(async () => {
        if (reader) await reader.cancel().catch(() => {});
        if (readTask) await readTask.catch(() => {});
        if (writer) { await writer.abort().catch(() => {}); writer.releaseLock(); }
        await Promise.allSettled(native);
        if (port) { await port.close(); retiredSerialPorts.delete(port); }
      });
    }
  }
  class BleClient extends RequestClient {
    constructor(events, options = {}) { super(events, options); this.api = options.bluetooth || (typeof navigator !== 'undefined' && navigator.bluetooth); this.receiver = new protocol.Receiver(); this.eventReceiver = new protocol.Receiver(); }
    async connect() {
      if (this.closing) await this.closing;
      if (!this.api) throw new Error('当前浏览器不支持蓝牙，请使用桌面 Chrome 或 Edge，或通过 USB 连接');
      this.device = await this.api.requestDevice({ filters: [{ services: [protocol.SERVICE_UUID] }, { namePrefix: 'S3-CAMPUS-' }], optionalServices: [protocol.SERVICE_UUID] });
      this.disconnected = () => { this.disconnect().catch(error => this.emit('onDiagnostic', error.message)); };
      this.device.addEventListener('gattserverdisconnected', this.disconnected);
      try {
        const server = await this.device.gatt.connect(); const service = await server.getPrimaryService(protocol.SERVICE_UUID);
        const write = await service.getCharacteristic(protocol.WRITE_UUID);
        if (retiredBleWriters.has(write)) throw new Error('原蓝牙写入尚未结束，请重新选择设备或重新打开此页面');
        this.write = write; this.notify = await service.getCharacteristic(protocol.NOTIFY_UUID);
        this.value = event => {
          const view = event.target.value;
          const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
          if (bytes.length < 4 || bytes[0] !== 0xC8 || bytes[1] !== 1) { this.emit('onDiagnostic', '已忽略无效蓝牙帧'); return; }
          const id = bytes[2] | bytes[3] << 8;
          if (id && (!this.pending || this.pending.id !== id)) return;
          try { const packet = (id ? this.receiver : this.eventReceiver).accept(bytes); if (packet) this.receive(packet); }
          catch (error) { if (id) this.rejectPending(error); this.emit('onDiagnostic', error.message); }
        };
        this.receiver.reset(); this.eventReceiver.reset(); this.notify.addEventListener('characteristicvaluechanged', this.value); await this.notify.startNotifications();
        await wait(100); this.connected('蓝牙 · ' + (this.device.name || '校园卡终端'));
      } catch (error) { await this.disconnect().catch(() => {}); throw error; }
    }
    async sendRaw(packet, token) {
      for (const frame of protocol.packets(packet.body, packet.id)) {
        if (!token.active || token.session !== this.session || !this.ready) throw new Error('蓝牙发送已停止，请核对原订单');
        const write = this.write;
        await this.nativeWrite(token, () => write.writeValueWithResponse ? write.writeValueWithResponse(frame) : write.writeValue(frame));
        await wait(this.options.writeDelay === undefined ? 20 : this.options.writeDelay);
      }
    }
    async disconnect() {
      if (this.closing) return this.closing;
      const session = this.session, notify = this.notify, value = this.value, device = this.device, disconnected = this.disconnected, write = this.write;
      const native = Array.from(this.nativeWrites).filter(([, owner]) => owner === session).map(([operation]) => operation);
      this.write = this.notify = this.device = null;
      if (write) retiredBleWriters.add(write);
      return this.closingOperation(async () => {
        this.receiver.reset(); this.eventReceiver.reset();
        if (notify && value) notify.removeEventListener('characteristicvaluechanged', value);
        if (device && disconnected) device.removeEventListener('gattserverdisconnected', disconnected);
        // Disconnect first: stopNotifications itself can queue behind a stuck
        // native GATT operation. No new GATT session starts until old writes end.
        if (device && device.gatt.connected) device.gatt.disconnect();
        await Promise.allSettled(native);
        if (write) retiredBleWriters.delete(write);
      });
    }
  }
  return { LineDecoder, RequestClient, SerialClient, BleClient };
});

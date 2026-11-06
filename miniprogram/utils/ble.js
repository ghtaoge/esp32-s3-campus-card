const protocol = require('./protocol');
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function call(api, args = {}) {
  return new Promise((resolve, reject) => {
    const fail = error => reject(Object.assign({ api }, error));
    if (typeof wx[api] !== 'function') return fail({ errMsg: `当前客户端不支持 ${api}，请升级微信后重试` });
    try { wx[api](Object.assign({}, args, { success: resolve, fail })); }
    catch (error) { fail({ message: error.message }); }
  });
}
function message(error) {
  const raw = error && (error.message || error.errMsg) || '操作失败，请重试';
  const code = error && error.errCode;
  let summary = raw;
  if (/api scope.*not declared|not declared.*privacy/i.test(raw)) summary = '请在当前 AppID 的用户隐私保护指引中声明蓝牙用途，生效后重新预览';
  else if (/privacy|隐私/i.test(raw)) summary = '请完成小程序隐私授权，并检查 AppID 后台隐私配置';
  else if (code === 10001) summary = '请打开手机蓝牙';
  else if (code === 10006) summary = '连接已断开，请重连后核对原订单';
  else if (code === 10003) summary = '连接失败，请确认开发板未被其他手机占用';
  else if (code === 10008 || code === 10012) summary = '蓝牙连接超时，请靠近开发板后重试';
  else if (/auth|permission|location/i.test(raw)) summary = '请检查微信的蓝牙、附近设备权限；部分安卓还需定位权限和定位服务';
  return summary + (error && error.api ? `（${error.api}${code !== undefined ? ` / ${code}` : ''}）\n${raw}` : '');
}
class CampusClient {
  constructor(events = {}, options = {}) {
    this.events = events; this.options = options; this.receiver = new protocol.Receiver();
    this.eventReceiver = new protocol.Receiver();
    this.device = null; this.ready = false; this.sequence = 0; this.chain = Promise.resolve(); this.nearby = new Map();
    this.scanEpoch = 0; this.closing = null;
    this.found = result => this.acceptDevices(result.devices || []);
    this.value = event => this.onValue(event);
    this.connection = event => {
      if (this.device && event.deviceId === this.device.deviceId && !event.connected) {
        this.ready = false; this.device = null; this.resetReceivers();
        this.rejectPending(new Error('蓝牙已断开，交易结果需重连后核对'));
        this.emit('onConnection', false);
      }
    };
    wx.onBluetoothDeviceFound(this.found); wx.onBLECharacteristicValueChange(this.value); wx.onBLEConnectionStateChange(this.connection);
  }
  emit(name, ...args) { if (!this.disposed && typeof this.events[name] === 'function') this.events[name](...args); }
  acceptDevices(devices) {
    for (const item of devices) {
      if (!item.deviceId) continue;
      const previous = this.nearby.get(item.deviceId) || {};
      const device = Object.assign({}, previous, item, {
        name: item.localName || item.name || previous.name || '',
        advertisServiceUUIDs: item.advertisServiceUUIDs && item.advertisServiceUUIDs.length ? item.advertisServiceUUIDs : previous.advertisServiceUUIDs
      });
      this.nearby.set(device.deviceId, device);
      if (device.name.startsWith('S3-CAMPUS-') || (device.advertisServiceUUIDs || []).some(uuid => same(uuid, protocol.SERVICE_UUID))) {
        if (!device.name) device.name = '校园卡终端';
        this.emit('onDevice', device);
      }
    }
  }
  async scan() {
    const epoch = ++this.scanEpoch;
    const active = () => !this.disposed && epoch === this.scanEpoch;
    this.emit('onScanProgress', '正在开启蓝牙，请留意微信或系统授权提示');
    await call('openBluetoothAdapter', { mode: 'central' });
    if (!active()) return;
    await this.stopScan(true, false);
    if (!active()) return;
    this.nearby.clear();
    await call('startBluetoothDevicesDiscovery', { allowDuplicatesKey: true });
    if (!active()) { await call('stopBluetoothDevicesDiscovery').catch(() => {}); return; }
    this.emit('onScanProgress', '正在搜索 S3-CAMPUS 终端…');
    this.scanTimer = setTimeout(() => { if (active()) this.stopScan(); }, 12000);
    try { const cached = await call('getBluetoothDevices'); if (active()) this.acceptDevices(cached.devices || []); } catch (_) {}
  }
  async stopScan(silent = false, invalidate = true) {
    if (invalidate) this.scanEpoch++;
    clearTimeout(this.scanTimer);
    await call('stopBluetoothDevicesDiscovery').catch(() => {});
    if (!silent) this.emit('onScanEnd');
  }
  async connect(device) {
    await this.stopScan(); await this.disconnect();
    if (this.disposed) throw new Error('页面已关闭，连接已取消');
    this.device = device;
    const ensureSession = () => { if (this.disposed || this.device !== device) throw new Error('连接已取消，请重新连接'); };
    try {
      await call('createBLEConnection', { deviceId: device.deviceId, timeout: 10000 });
      ensureSession();
      await sleep(this.options.connectDelay === undefined ? 250 : this.options.connectDelay);
      ensureSession();
      const services = await call('getBLEDeviceServices', { deviceId: device.deviceId });
      ensureSession();
      const service = (services.services || []).find(item => same(item.uuid, protocol.SERVICE_UUID));
      if (!service) throw new Error('固件不兼容，请烧录校园卡项目固件');
      this.serviceId = service.uuid;
      const found = await call('getBLEDeviceCharacteristics', { deviceId: device.deviceId, serviceId: this.serviceId });
      ensureSession();
      const write = (found.characteristics || []).find(item => same(item.uuid, protocol.WRITE_UUID) && item.properties.write);
      const notify = (found.characteristics || []).find(item => same(item.uuid, protocol.NOTIFY_UUID) && item.properties.notify);
      if (!write || !notify) throw new Error('校园卡服务不完整');
      this.writeId = write.uuid; this.notifyId = notify.uuid;
      await call('notifyBLECharacteristicValueChange', Object.assign(this.ids(this.notifyId), { state: true }));
      ensureSession();
      // Some Android phones reject an immediate write after enabling notifications.
      await sleep(this.options.connectDelay === undefined ? 120 : this.options.connectDelay);
      ensureSession();
      this.resetReceivers(); this.ready = true;
      const state = await this.request({ op: 'state', unixTime: Math.floor(Date.now() / 1000) });
      ensureSession();
      this.emit('onConnection', true, device);
      return state;
    } catch (error) { if (this.device === device) await this.disconnect(); throw error; }
  }
  ids(characteristicId) { return { deviceId: this.device.deviceId, serviceId: this.serviceId, characteristicId }; }
  resetReceivers() { this.receiver.reset(); this.eventReceiver.reset(); }
  request(body) {
    const session = this.device;
    const operation = this.chain.catch(() => {}).then(async () => {
      if (!this.ready || !session || this.device !== session) throw new Error('请先连接校园卡终端');
      this.sequence = this.sequence % 65535 + 1;
      const id = this.sequence;
      const frames = protocol.packets(body, id);
      const token = { active: true };
      const response = new Promise((resolve, reject) => {
        this.pending = { id, token, resolve, reject, timer: setTimeout(() => this.timeoutRequest(token), this.options.timeout || 15000) };
      });
      const writes = (async () => {
        try {
          for (const frame of frames) {
            if (!token.active || !this.ready || this.device !== session) throw new Error('本次发送已停止，请核对原订单');
            token.writing = true;
            try { await call('writeBLECharacteristicValue', Object.assign(this.ids(this.writeId), { value: frame.buffer, writeType: 'write' })); }
            finally { token.writing = false; }
            await sleep(this.options.writeDelay === undefined ? 20 : this.options.writeDelay);
          }
        } catch (error) { this.rejectPending(error, token); throw error; }
      })();
      const results = await Promise.all([response, writes]);
      return results[0];
    });
    this.chain = operation;
    return operation;
  }
  rejectPending(error, token) {
    if (!this.pending || (token && this.pending.token !== token)) return;
    const pending = this.pending; this.pending = null; pending.token.active = false; clearTimeout(pending.timer); pending.reject(error);
  }
  timeoutRequest(token) {
    if (!this.pending || this.pending.token !== token) return;
    const nativeWritePending = !!token.writing;
    this.rejectPending(new Error('终端未返回完整结果，请查询原订单；不要重复创建交易'), token);
    if (nativeWritePending) {
      // The API has no cancellation for an individual ATT write. End this
      // connection before allowing a new request to overlap that native call.
      const closing = this.disconnect();
      this.emit('onConnection', false);
      closing.catch(error => this.emit('onError', error));
    }
  }
  onValue(event) {
    if (!this.device || event.deviceId !== this.device.deviceId || !same(event.characteristicId, this.notifyId) || (event.serviceId && !same(event.serviceId, this.serviceId))) return;
    const bytes = new Uint8Array(event.value);
    const identified = bytes.length >= 4 && bytes[0] === 0xC8 && bytes[1] === 1;
    const frameId = identified ? bytes[2] | bytes[3] << 8 : null;
    if (!identified) { this.emit('onError', new Error('设备响应格式不正确')); return; }
    // Old responses can finish after their RPC timed out. Ignore their frames
    // before touching the assembler used by the current request/event.
    if (frameId !== null && frameId !== 0 && (!this.pending || this.pending.id !== frameId)) return;
    let assembled;
    try { assembled = (frameId === 0 ? this.eventReceiver : this.receiver).accept(bytes); }
    catch (error) {
      if (frameId !== null && frameId !== 0) this.rejectPending(error);
      this.emit('onError', error); return;
    }
    if (!assembled) return;
    const { id, body } = assembled;
    // Ignore delayed responses for a timed-out request; events always use id=0.
    if (id !== 0 && (!this.pending || this.pending.id !== id)) return;
    // Pages can apply RPC responses themselves once, while retaining automatic
    // delivery of unsolicited card/transaction events.
    if (id === 0 || this.options.emitResponses !== false) this.emit('onState', body);
    if (id !== 0) {
      const pending = this.pending; this.pending = null; pending.token.active = false; clearTimeout(pending.timer);
      if (body.ok === false) { const error = new Error(body.message || body.code || '终端拒绝了操作'); error.response = body; pending.reject(error); }
      else pending.resolve(body);
    }
  }
  async disconnect() {
    this.ready = false; this.resetReceivers(); this.rejectPending(new Error('连接已关闭，未完成交易将在重连后核对'));
    const previous = this.device; this.device = null;
    if (previous) {
      const closing = call('closeBLEConnection', { deviceId: previous.deviceId }).catch(() => {});
      this.closing = closing;
      await closing;
      if (this.closing === closing) this.closing = null;
    } else if (this.closing) await this.closing;
  }
  async destroy() {
    this.disposed = true; await this.stopScan(true); await this.disconnect();
    if (wx.offBluetoothDeviceFound) wx.offBluetoothDeviceFound(this.found);
    if (wx.offBLECharacteristicValueChange) wx.offBLECharacteristicValueChange(this.value);
    if (wx.offBLEConnectionStateChange) wx.offBLEConnectionStateChange(this.connection);
    await call('closeBluetoothAdapter').catch(() => {});
  }
}
module.exports = { CampusClient, message };

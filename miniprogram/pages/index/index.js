const { CampusClient, message } = require('../../utils/ble');
const { OperationBook, makeOperation, originalCommand, money, decorateResult, terminal } = require('../../utils/business');
const DEVICE_KEY = 'campus.lastDevice.v1';
const effects = ['static', 'slide', 'type'];
const fontSizes = [12, 16, 24, 32];
const holdTimes = [1500, 3000, 5000, 10000];

Page({
  data: {
    connected: false, scanning: false, connecting: false, busy: false, storageReady: true,
    deviceName: '', savedDeviceName: '', scanHint: '', devices: [], deviceOptions: ['请选择发现的终端'], deviceIndex: 0,
    readerReady: false, oledReady: false, deviceStorageReady: false, card: null, lastResult: null, pending: null,
    outstanding: null, hasOutstanding: false, canTrade: false, canCancel: false, canResume: false,
    operationHint: '连接终端后，直接刷卡即可查询余额', notice: '', errorText: '',
    tab: 'trade', tradeKind: 'topup', amount: '50', scene: '充值',
    issueName: '', studentNo: '', issueOpen: false,
    quickAmounts: ['10', '20', '50', '100'],
    products: [
      { name: '早餐', amount: '5.00', scene: '食堂' }, { name: '午餐', amount: '12.50', scene: '食堂' },
      { name: '饮料', amount: '3.00', scene: '超市' }, { name: '公交', amount: '1.00', scene: '公交' }
    ],
    logs: [], logsLoaded: false,
    fontNames: ['12 像素', '16 像素', '24 像素', '32 像素'], fontIndex: 1,
    effectNames: ['静态显示', '上滑切换', '逐字出现'], effectIndex: 1,
    holdNames: ['1.5 秒', '3 秒', '5 秒', '10 秒'], holdIndex: 1, settingsDirty: false,
    showPrivacy: false, privacyAgreePending: false, privacyName: '《用户隐私保护指引》'
  },
  onLoad() {
    this.privacyResolvers = new Set(); this.operationBusy = false;
    try {
      this.book = new OperationBook(wx);
      const saved = wx.getStorageSync(DEVICE_KEY);
      if (saved && typeof saved.deviceId === 'string' && typeof saved.name === 'string') {
        this.savedDevice = saved;
        this.setData({ savedDeviceName: saved.name });
      }
    } catch (_) {
      this.setData({ storageReady: false, errorText: '本地存储不可用，暂时禁止创建交易。请检查微信存储空间后重新打开。' });
    }
    this.client = new CampusClient({
      onDevice: device => {
        if (this.unloaded) return;
        const devices = this.data.devices.slice();
        const index = devices.findIndex(item => item.deviceId === device.deviceId);
        if (index < 0) devices.push(device); else devices[index] = device;
        this.setData({ devices, deviceOptions: ['请选择发现的终端'].concat(devices.map(item => `${item.name} · ${item.deviceId.slice(-6)}`)) });
      },
      onScanProgress: scanHint => { if (!this.unloaded) this.setData({ scanHint }); },
      onScanEnd: () => {
        if (!this.unloaded) this.setData({ scanning: false, scanHint: this.data.devices.length ? '选择终端进行连接' : '未发现校园卡终端，请检查供电、固件及手机蓝牙权限' });
      },
      onConnection: (connected, device) => {
        if (this.unloaded) return;
        if (connected) {
          this.deviceId = device.deviceId; this.savedDevice = { deviceId: device.deviceId, name: device.name };
          try { wx.setStorageSync(DEVICE_KEY, this.savedDevice); } catch (_) {}
        }
        this.setData({ connected, connecting: false, deviceName: device ? device.name : '',
          savedDeviceName: this.savedDevice ? this.savedDevice.name : '',
          notice: connected ? '已连接，待机刷卡查询余额' : '蓝牙已断开，重连后先核对原订单' });
        this.refreshLock();
      },
      onState: state => this.applyState(state),
      onError: error => { if (!this.unloaded) this.setData({ errorText: message(error) }); }
    });
    if (wx.onNeedPrivacyAuthorization) {
      this.privacyHandler = resolve => {
        if (this.unloaded || typeof resolve !== 'function') return;
        this.privacyResolvers.add(resolve); this.setData({ showPrivacy: true });
        if (wx.getPrivacySetting) wx.getPrivacySetting({ success: result => {
          if (!this.unloaded) this.setData({ privacyName: result.privacyContractName || this.data.privacyName });
        } });
      };
      wx.onNeedPrivacyAuthorization(this.privacyHandler);
    }
  },
  onShow() {
    if (this.client && this.client.ready && !this.operationBusy) this.refresh();
  },
  onHide() { if (this.client) this.client.stopScan(true); this.setData({ scanning: false }); },
  onUnload() {
    this.unloaded = true; this.settlePrivacy('disagree');
    if (wx.offNeedPrivacyAuthorization && this.privacyHandler) wx.offNeedPrivacyAuthorization(this.privacyHandler);
    if (this.client) this.client.destroy();
  },
  refreshLock() {
    if (this.unloaded) return;
    const outstanding = this.book && this.deviceId ? this.book.get(this.deviceId) : null;
    const pending = this.data.pending;
    const hasOutstanding = !!(outstanding || pending);
    let operationHint = this.data.connected ? '待机刷卡仅查询余额，不会扣款' : '连接终端后，直接刷卡即可查询余额';
    if (pending) {
      const type = { issue: '开卡', topup: '充值', spend: '消费' }[pending.kind] || '交易';
      operationHint = pending.phase === 'uncertain'
        ? '写卡结果待核对：请重新刷原卡，期间不要创建新交易'
        : `等待刷卡${type}${pending.kind === 'issue' ? '' : ` ${money(pending.amountCents)} 元`}，任务约 30 秒后超时`;
    } else if (outstanding) operationHint = '上一笔订单结果待核对，请点击“核对原订单”；请勿重复充值或消费';
    this.setData({ outstanding, hasOutstanding, operationHint,
      canTrade: !!(this.data.connected && !this.data.busy && this.data.readerReady && this.data.deviceStorageReady && !hasOutstanding && this.data.storageReady),
      canResume: !!(this.data.connected && !this.data.busy && this.data.readerReady && this.data.deviceStorageReady && outstanding && !pending && this.data.storageReady),
      canCancel: !!(this.data.connected && !this.data.busy && pending && pending.phase === 'waiting') });
  },
  applyState(state) {
    if (this.unloaded || !state || typeof state !== 'object') return;
    const patch = {};
    if (state.device) {
      patch.oledReady = !!state.device.oledReady; patch.readerReady = !!state.device.readerReady;
      patch.deviceStorageReady = !!state.device.storageReady;
    }
    if (state.ok === false) patch.errorText = (state.message || '终端未能完成本次操作') + (state.code ? `（${state.code}）` : '');
    else if (state.event === 'card') patch.errorText = '';
    if (Object.prototype.hasOwnProperty.call(state, 'card')) {
      patch.card = state.card ? Object.assign({}, state.card, { balanceText: money(state.card.balanceCents) }) : null;
    }
    if (Object.prototype.hasOwnProperty.call(state, 'pending')) patch.pending = state.pending;
    if (state.lastResult) patch.lastResult = decorateResult(state.lastResult);
    if (state.result) patch.lastResult = decorateResult(state.result);
    if (Array.isArray(state.logs)) { patch.logs = state.logs.map(decorateResult); patch.logsLoaded = true; }
    if (state.settings && (!this.data.settingsDirty || state.op === 'settings')) {
      patch.fontIndex = Math.max(0, fontSizes.indexOf(state.settings.fontSize));
      patch.effectIndex = Math.max(0, effects.indexOf(state.settings.effect));
      patch.holdIndex = Math.max(0, holdTimes.indexOf(state.settings.holdMs));
      patch.settingsDirty = false;
    }
    try { if (this.book && this.deviceId) this.book.reconcile(this.deviceId, state); }
    catch (_) { patch.errorText = '结果已收到，但本地订单标记未能清除，请重启后重新核对'; }
    this.setData(patch); this.refreshLock();
    if (state.event === 'transaction' && state.lastResult && terminal(state.lastResult.status)) {
      this.setData({ notice: state.lastResult.message || '交易结果已更新' });
      // Do not present a new time as an old transaction's exact timestamp.
      if (this.data.tab === 'logs' && !this.operationBusy) this.loadLogs();
    }
  },
  async search() {
    if (this.data.scanning || this.data.connecting || this.data.connected) return;
    this.setData({ scanning: true, devices: [], deviceOptions: ['请选择发现的终端'], deviceIndex: 0, errorText: '', scanHint: '准备搜索…' });
    try { await this.client.scan(); }
    catch (error) { if (!this.unloaded) this.setData({ scanning: false, errorText: message(error) }); }
  },
  selectDevice(event) {
    const index = Number(event.detail.value); const device = this.data.devices[index - 1];
    if (!device || this.data.connecting || this.data.connected) return;
    this.setData({ deviceIndex: index }); return this.connectDevice(device);
  },
  async connectDevice(device) {
    if (this.data.connecting || this.data.connected) return;
    this.deviceId = device.deviceId;
    this.setData({ connecting: true, errorText: '', pending: null, card: null, lastResult: null, logs: [], logsLoaded: false }); this.refreshLock();
    try {
      const state = await this.client.connect(device);
      if (this.unloaded) return;
      this.applyState(state);
      await this.reconcileOriginal();
    } catch (error) {
      if (!this.unloaded) this.setData({ connecting: false, connected: false, errorText: message(error) });
    }
    this.refreshLock();
  },
  async reconnect() {
    if (!this.savedDevice || this.data.connecting || this.data.connected) return;
    try { await new Promise((resolve, reject) => wx.openBluetoothAdapter({ mode: 'central', success: resolve, fail: reject })); await this.connectDevice(this.savedDevice); }
    catch (error) { this.setData({ errorText: message(error) }); }
  },
  async disconnect() {
    if (this.data.busy) return;
    await this.client.disconnect();
    if (!this.unloaded) { this.setData({ connected: false, deviceName: '', notice: '已断开。卡内余额保留，未确认订单将在重连后核对' }); this.refreshLock(); }
  },
  async withBusy(action) {
    if (this.operationBusy) return;
    this.operationBusy = true; this.setData({ busy: true, errorText: '', notice: '' }); this.refreshLock();
    try { return await action(); }
    catch (error) { if (!this.unloaded) this.setData({ errorText: message(error) }); }
    finally { this.operationBusy = false; if (!this.unloaded) { this.setData({ busy: false }); this.refreshLock(); } }
  },
  async reconcileOriginal() {
    const original = this.book && this.deviceId ? this.book.get(this.deviceId) : null;
    if (!original) return;
    let response;
    try { response = await this.client.request({ op: 'result', id: original.id }); }
    catch (error) {
      if (this.consumeExpired(error.response, original.id)) return;
      throw error;
    }
    if (this.consumeExpired(response, original.id)) return;
    this.applyState(response);
    const state = await this.client.request({ op: 'state', unixTime: Math.floor(Date.now() / 1000) }); this.applyState(state);
    if (this.book.get(this.deviceId) && !state.pending) {
      this.setData({ errorText: '终端暂未查到原订单结果，已保留原编号。若刚才发送中断，可手动“重发原订单”；久未处理的订单请先核对卡内余额和流水。' });
    }
  },
  consumeExpired(response, id) {
    if (!response || response.code !== 'RESULT_EXPIRED') return false;
    // This helper is called only with the exact id used for a result/arm RPC.
    // Never release an unrelated local order based on an unsolicited error.
    if (this.book && this.deviceId) this.book.clear(this.deviceId, id);
    this.applyState(response);
    this.setData({ errorText:'', notice:'原订单已处理、明细过期，请刷卡查余额。该订单不会再次充值或扣款。' });
    this.refreshLock(); return true;
  },
  refresh() { return this.withBusy(async () => {
    const state = await this.client.request({ op: 'state', unixTime: Math.floor(Date.now() / 1000) }); this.applyState(state); await this.reconcileOriginal();
  }); },
  queryOriginal() { return this.withBusy(() => this.reconcileOriginal()); },
  resumeOriginal() {
    if (!this.data.canResume || this.operationBusy) return;
    return this.withBusy(async () => {
      const deviceId = this.deviceId;
      const entry = this.book.get(deviceId);
      if (!entry) return;
      const request = originalCommand(entry);
      await this.reconcileOriginal();
      if (!this.book.get(deviceId) || this.data.pending) return;
      const description = request.kind === 'issue'
        ? `开卡：${request.name}，学号 ${request.studentNo}`
        : `${request.kind === 'topup' ? '充值' : '消费'} ${money(request.amountCents)} 元，场景：${request.scene}`;
      const confirmation = await new Promise((resolve, reject) => wx.showModal({
        title:'重发原订单',
        content:`${description}。\n保留原编号与全部资料，仅继续刚才中断的订单。久未处理或已完成的订单，请取消并先核对余额及流水。`,
        confirmText:'继续原订单', cancelText:'先不重发', success:resolve, fail:reject
      }));
      if (!confirmation.confirm || this.unloaded) return;
      if (!this.data.connected || this.deviceId !== deviceId) throw new Error('请连接原订单对应的终端后重试');
      // Recheck after the user confirmation: a card scan or another phone may
      // have completed/armed an operation while the dialog was open.
      await this.reconcileOriginal();
      const current = this.book.get(deviceId);
      if (!current || current.id !== entry.id || this.data.pending) return;
      if (!this.data.connected || this.deviceId !== deviceId || !this.data.deviceStorageReady) throw new Error('终端状态已变化，请重新连接并核对原订单');
      try {
        const response = await this.client.request(request);
        if (this.consumeExpired(response, entry.id)) return;
        this.applyState(response);
        if (this.book.get(deviceId)) this.setData({ errorText:'', notice:'已使用原编号续办，请在 30 秒内刷卡；不要再创建同金额的新订单' });
      } catch (error) {
        if (!this.consumeExpired(error.response, entry.id)) throw error;
      }
    });
  },
  tabChange(event) {
    const tab = event.currentTarget.dataset.tab;
    if (!['trade', 'logs', 'screen'].includes(tab)) return;
    this.setData({ tab });
    if (tab === 'logs' && this.data.connected && !this.data.busy) this.loadLogs();
  },
  kindChange(event) {
    const tradeKind = event.currentTarget.dataset.kind;
    if (!['topup', 'spend'].includes(tradeKind) || this.data.busy) return;
    this.setData({ tradeKind, amount: tradeKind === 'topup' ? '50' : '12.50', scene: tradeKind === 'topup' ? '充值' : '食堂', notice: '' });
  },
  inputAmount(event) { this.setData({ amount: event.detail.value }); },
  inputScene(event) { this.setData({ scene: event.detail.value }); },
  inputName(event) { this.setData({ issueName: event.detail.value }); },
  inputStudentNo(event) { this.setData({ studentNo: event.detail.value }); },
  chooseAmount(event) { this.setData({ amount: event.currentTarget.dataset.amount }); },
  chooseProduct(event) {
    const item = this.data.products[Number(event.currentTarget.dataset.index)];
    if (item) this.setData({ amount: item.amount, scene: item.scene });
  },
  toggleIssue() { if (!this.data.busy) this.setData({ issueOpen: !this.data.issueOpen }); },
  submitTrade() { return this.arm(this.data.tradeKind, { amount: this.data.amount, scene: this.data.scene }); },
  submitIssue() { return this.arm('issue', { name: this.data.issueName, studentNo: this.data.studentNo }); },
  arm(kind, form) {
    if (!this.data.canTrade || this.operationBusy) return;
    return this.withBusy(async () => {
      const command = makeOperation(kind, form);
      const entry = this.book.begin(this.deviceId, command); this.refreshLock();
      const request = Object.assign({}, command, { id: entry.id });
      try {
        const response = await this.client.request(request); this.applyState(response);
        if (response.lastResult && response.lastResult.id === entry.id && terminal(response.lastResult.status)) return;
        this.setData({ notice: '任务已提交，请在 30 秒内将卡片放到读卡器上；完成前请勿移开' });
      } catch (error) {
        if (this.consumeExpired(error.response, entry.id)) return;
        // A complete negative application response confirms that this request
        // was rejected. Transport failures leave the original business id intact.
        if (error.response && error.response.ok === false && error.response.code !== 'UNCERTAIN') {
          const pending = error.response.pending;
          if (!pending || pending.id !== entry.id) this.book.clear(this.deviceId, entry.id);
        }
        throw error;
      }
    });
  },
  cancel() {
    if (!this.data.canCancel) return;
    return this.withBusy(async () => { this.applyState(await this.client.request({ op: 'cancel' })); await this.reconcileOriginal(); });
  },
  loadLogs() { return this.withBusy(async () => { this.applyState(await this.client.request({ op: 'logs' })); }); },
  chooseFont(event) { this.setData({ fontIndex: Number(event.detail.value), settingsDirty: true }); },
  chooseEffect(event) { this.setData({ effectIndex: Number(event.detail.value), settingsDirty: true }); },
  chooseHold(event) { this.setData({ holdIndex: Number(event.detail.value), settingsDirty: true }); },
  saveSettings() {
    if (!this.data.connected) return;
    return this.withBusy(async () => {
      const response = await this.client.request({ op: 'settings', fontSize: fontSizes[this.data.fontIndex], effect: effects[this.data.effectIndex], holdMs: holdTimes[this.data.holdIndex] });
      this.applyState(response); this.setData({ notice: '屏幕设置已由设备确认并保存', settingsDirty: false });
    });
  },
  openSettings() { wx.openSetting({}); },
  openPrivacy() {
    if (wx.openPrivacyContract) wx.openPrivacyContract({ fail: () => wx.showToast({ title: '请在小程序后台配置隐私指引', icon: 'none' }) });
  },
  preparePrivacyAgree() {
    if (!this.data.showPrivacy || this.data.privacyAgreePending) return;
    this.setData({ privacyAgreePending: true });
    this.privacyTimer = setTimeout(() => this.settlePrivacy('disagree', '微信未完成隐私授权，请重新搜索并使用真机预览'), 4000);
  },
  settlePrivacy(event, reason = '') {
    clearTimeout(this.privacyTimer);
    const resolvers = Array.from(this.privacyResolvers || []);
    if (this.privacyResolvers) this.privacyResolvers.clear();
    for (const resolve of resolvers) { try { resolve(event === 'agree' ? { event, buttonId: 'agree-privacy' } : { event }); } catch (_) {} }
    if (!this.unloaded) this.setData({ showPrivacy: false, privacyAgreePending: false,
      ...(event === 'agree' ? {} : { scanning: false, errorText: reason || '已取消授权，可重新搜索' }) });
  },
  agreePrivacy() { this.settlePrivacy('agree'); },
  rejectPrivacy() { this.settlePrivacy('disagree'); },
  ignorePrivacyTap() {}
});

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./transport'), require('../../miniprogram/utils/business'));
  else root.CampusDemo = factory(root.CampusTransport, root.CampusBusiness);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (transport, business) {
  'use strict';
  const KEY = 'campus.pc.demo.v1', copy = value => JSON.parse(JSON.stringify(value));
  const fingerprint = value => JSON.stringify([value.kind, value.kind === 'issue' ? 0 : value.amountCents,
    value.kind === 'issue' ? value.name : '', value.kind === 'issue' ? value.studentNo || '' : '',
    value.scene || (value.kind === 'issue' ? '开卡' : value.kind === 'topup' ? '充值' : '食堂')]);
  function initial(now) {
    const uid = 'A1B2C3D4';
    const card = { uid, cardNo: 10000001, name: '演示同学', studentNo: 'DEMO-A', balanceCents: 5000, sequence: 1 };
    return { version: 1, selected: 'A', nextCardNo: 10000002, cards: { A: card, B: null }, lastCard: card,
      settings: { fontSize: 16, effect: 'slide', holdMs: 3000 }, power: { batteryMode: false, brightness: 180, idleSeconds: 60, screenAwake: true, batteryMeasurement: false, batteryVoltage: null },
      pending: null, recovery: null, logs: [], seen: [], armedAt: 0, lastResult: null, createdAt: now };
  }
  class DemoClient extends transport.RequestClient {
    constructor(storage, events = {}, options = {}) {
      super(events, options); this.storage = storage; this.now = options.now || (() => Date.now()); this.selected = 'A'; this.interruptNext = false;
      const saved = storage.getStorageSync(KEY);
      this.data = saved && saved.version === 1 && saved.cards && Array.isArray(saved.logs) && Array.isArray(saved.seen) ? saved : initial(this.now());
      this.selected = this.data.selected || 'A'; this.revision = 0; this.snapshot = null;
    }
    save() { this.storage.setStorageSync(KEY, this.data); }
    async connect() { this.connected('演示设备 · 本机独立数据'); this.expire(); }
    async disconnect() { clearTimeout(this.expiryTimer); this.lost(); }
    state(extra = {}) {
      return Object.assign({ ok: true,
        device: { id: 'DEMO-LOCAL', name: '演示校园卡终端', oledReady: true, readerReady: true, storageReady: true, usbReady: false, capabilities: { power: true, logPagination: true } },
        settings: copy(this.data.settings), power: copy(this.data.power), card: copy(this.data.lastCard), pending: copy(this.data.pending), lastResult: copy(this.data.lastResult)
      }, extra);
    }
    announce(event, extra = {}) { if (this.ready) this.receive({ id: 0, body: this.state(Object.assign({ event }, extra)) }); }
    async sendRaw(packet, token) {
      await Promise.resolve();
      if (!token.active || token.session !== this.session) throw new Error('演示会话已关闭');
      this.receive({ id: packet.id, body: this.handle(packet.body) });
    }
    reject(op, code, message) { return this.state({ ok: false, op, code, message }); }
    expire() {
      if (this.data.pending && this.data.pending.phase === 'waiting' && this.now() - this.data.armedAt >= 30000) {
        this.finish(this.result('expired', 'EXPIRED', '刷卡等待已超时', null)); this.announce('transaction');
      }
    }
    result(status, code, message, card = this.data.cards[this.selected]) {
      const pending = this.data.pending;
      return { id: pending.id, kind: pending.kind, status, code, message, uid: card ? card.uid : this.uid(), cardNo: card ? card.cardNo : 0,
        amountCents: pending.amountCents || 0, balanceCents: card ? card.balanceCents : 0, sequence: card ? card.sequence : 0,
        scene: pending.scene || (pending.kind === 'issue' ? '开卡' : pending.kind === 'topup' ? '充值' : '食堂'), timestamp: Math.floor(this.now() / 1000), uptimeMs: 0 };
    }
    finish(result) {
      this.data.lastResult = result; this.data.logs.unshift(result); this.data.logs = this.data.logs.slice(0, 20);
      this.data.seen.unshift({ request: this.data.pending, result }); this.data.seen = this.data.seen.slice(0, 96);
      this.data.pending = this.data.recovery = null; clearTimeout(this.expiryTimer); this.save();
    }
    handle(body) {
      this.expire(); const op = body.op;
      if (op === 'state') return this.state({ op });
      if (op === 'result') { const found = this.data.seen.find(item => item.result.id === body.id); const result = found ? found.result : this.data.lastResult && this.data.lastResult.id === body.id ? this.data.lastResult : null; return this.state({ op, result: copy(result) }); }
      if (op === 'logs') {
        const offset = body.offset || 0, limit = Math.min(5, body.limit || 5);
        if (!offset) { this.snapshot = copy(this.data.logs); this.revision = (this.revision + 1) >>> 0; }
        const revision = this.revision.toString(16).padStart(8, '0');
        if (!this.snapshot || (offset && body.revision !== revision)) return this.reject(op, 'LOG_SNAPSHOT_EXPIRED', '流水快照已变化，请重新刷新');
        return { ok: true, op, logs: copy(this.snapshot.slice(offset, offset + limit)), total: this.snapshot.length, revision, nextOffset: offset + limit < this.snapshot.length ? offset + limit : null };
      }
      if (op === 'settings') {
        if (![12, 16, 24, 32].includes(body.fontSize) || !['static', 'slide', 'type'].includes(body.effect) || !Number.isInteger(body.holdMs) || body.holdMs < 1500 || body.holdMs > 10000) return this.reject(op, 'BAD_SETTINGS', '显示设置无效');
        this.data.settings = { fontSize: body.fontSize, effect: body.effect, holdMs: body.holdMs }; this.data.power.screenAwake = true; this.save(); return this.state({ op });
      }
      if (op === 'power') {
        if (typeof body.batteryMode !== 'boolean' || !Number.isInteger(body.brightness) || body.brightness < 1 || body.brightness > 255 || !Number.isInteger(body.idleSeconds) || (body.idleSeconds !== 0 && (body.idleSeconds < 10 || body.idleSeconds > 3600))) return this.reject(op, 'BAD_POWER', '电源设置无效');
        Object.assign(this.data.power, { batteryMode: body.batteryMode, brightness: body.brightness, idleSeconds: body.idleSeconds, screenAwake: true }); this.save(); return this.state({ op });
      }
      if (op === 'wake') { this.data.power.screenAwake = true; this.save(); return this.state({ op }); }
      if (op === 'cancel') {
        if (this.data.pending && this.data.pending.phase === 'uncertain') return this.reject(op, 'BUSY', '交易结果待核对，请重新刷原卡');
        if (this.data.pending) this.finish(this.result('cancelled', 'CANCELLED', '等待任务已取消', null));
        return this.state({ op });
      }
      if (op === 'arm') {
        if (!/^[0-9a-f]{16}$/i.test(body.id || '') || !['issue', 'topup', 'spend'].includes(body.kind)) return this.reject(op, 'INVALID', '交易资料无效');
        body = Object.assign({}, body, { id: body.id.toLowerCase() });
        try {
          if (body.kind === 'issue') {
            body.name = business.textField(body.name, '姓名', 24);
            body.studentNo = business.textField(body.studentNo, '学号', 16, false);
          }
          body.scene = business.textField(body.scene || (body.kind === 'issue' ? '开卡' : body.kind === 'topup' ? '充值' : '食堂'), '场景', 24);
        } catch (error) { return this.reject(op, 'INVALID', error.message); }
        const found = this.data.seen.find(item => item.result.id === body.id);
        if (found) {
          if (fingerprint(found.request) !== fingerprint(body)) return this.reject(op, 'ID_CONFLICT', '原订单资料不一致');
          this.data.lastResult = found.result; return this.state({ op });
        }
        if (this.data.pending) {
          if (this.data.pending.id === body.id) return fingerprint(this.data.pending) === fingerprint(body) ? this.state({ op }) : this.reject(op, 'ID_CONFLICT', '原订单资料不一致');
          return this.reject(op, 'BUSY', '请先完成当前交易');
        }
        if (body.kind !== 'issue' && (!Number.isInteger(body.amountCents) || body.amountCents <= 0 || body.amountCents > 100000000)) return this.reject(op, 'INVALID', '交易金额无效');
        this.data.pending = Object.assign({}, body, { phase: 'waiting' }); this.data.armedAt = this.now(); this.data.power.screenAwake = true; this.save();
        this.expiryTimer = setTimeout(() => this.expire(), 30020); return this.state({ op });
      }
      return this.reject(op, 'UNKNOWN_OPERATION', '演示设备不支持此操作');
    }
    uid() { return this.selected === 'A' ? 'A1B2C3D4' : 'B1C2D3E4'; }
    selectCard(value) { if (!['A', 'B'].includes(value)) return; this.selected = this.data.selected = value; this.save(); }
    scan() {
      if (!this.ready) throw new Error('请先连接演示设备');
      this.expire(); const pending = this.data.pending; let card = this.data.cards[this.selected]; this.data.power.screenAwake = true;
      if (pending && pending.phase === 'uncertain') {
        if (this.data.recovery.uid !== this.uid()) { this.announce('card', { ok: false, code: 'WRONG_CARD', message: '请刷待核对交易的原卡' }); return; }
        const completed = Object.assign({}, this.data.recovery, { status: 'success', code: 'OK', message: '原交易已核对完成' }); this.data.lastCard = card;
        this.finish(completed); this.announce('transaction'); return;
      }
      if (!pending) {
        this.data.lastCard = card; this.save(); this.announce('card', card ? {} : { ok: false, code: 'CARD_NOT_ISSUED', message: '这张演示卡尚未开卡' }); return;
      }
      let code, message;
      if (pending.kind === 'issue' && card) { code = 'ALREADY_ISSUED'; message = '这张演示卡已经开卡'; }
      else if (pending.kind !== 'issue' && !card) { code = 'CARD_NOT_ISSUED'; message = '请先为这张演示卡开卡'; }
      else if (pending.kind === 'spend' && card.balanceCents < pending.amountCents) { code = 'INSUFFICIENT'; message = '余额不足'; }
      else if (pending.kind === 'topup' && card.balanceCents + pending.amountCents > 100000000) { code = 'LIMIT'; message = '余额达到上限'; }
      if (code) { this.data.lastCard = card; this.finish(this.result('declined', code, message, card)); this.announce('transaction'); return; }
      if (pending.kind === 'issue') card = this.data.cards[this.selected] = { uid: this.uid(), cardNo: this.data.nextCardNo++, name: pending.name, studentNo: pending.studentNo || '', balanceCents: 0, sequence: 0 };
      else { card.balanceCents += pending.kind === 'topup' ? pending.amountCents : -pending.amountCents; card.sequence++; }
      this.data.lastCard = card; const completed = this.result('success', 'OK', { issue: '开卡成功', topup: '充值成功', spend: '消费成功' }[pending.kind], card);
      if (this.interruptNext) {
        this.interruptNext = false; this.data.recovery = completed; this.data.pending.phase = 'uncertain';
        this.data.lastResult = Object.assign({}, completed, { status: 'uncertain', code: 'UNCERTAIN', message: '模拟写卡中断，请再次刷原卡核对' }); this.save();
      } else this.finish(completed);
      this.announce('transaction');
    }
    reset() { clearTimeout(this.expiryTimer); this.data = initial(this.now()); this.selected = 'A'; this.interruptNext = false; this.save(); this.announce('status'); }
  }
  return { DemoClient, initial, KEY };
});

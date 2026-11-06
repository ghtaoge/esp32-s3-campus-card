const { utf8 } = require('./protocol');
const OPERATION_KEY = 'campus.outstanding.v1';
const CLOCK_KEY = 'campus.idclock.v1';
const terminal = status => ['success', 'declined', 'cancelled', 'expired'].includes(status);

function parseMoney(value) {
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(text)) throw new Error('请输入正确金额，最多两位小数');
  const parts = text.split('.');
  const cents = Number(parts[0]) * 100 + Number((parts[1] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 100000000) throw new Error('金额须大于 0，且不超过 1,000,000.00');
  return cents;
}
function money(cents) {
  if (!Number.isSafeInteger(cents)) return '--';
  const sign = cents < 0 ? '-' : '';
  const amount = Math.abs(cents);
  return `${sign}${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
}
function textField(value, title, maximum, required = true) {
  const text = String(value || '').trim();
  if (required && !text) throw new Error(`请填写${title}`);
  if (/[\u0000-\u001F\u007F-\u009F]/.test(text)) throw new Error(`${title}不能含换行或控制字符`);
  if (utf8(text).length > maximum) throw new Error(`${title}过长，最多 ${maximum} 个 UTF-8 字节`);
  return text;
}
function makeOperation(kind, form) {
  if (kind === 'issue') return { op: 'arm', kind, name: textField(form.name, '姓名', 24), studentNo: textField(form.studentNo, '学号', 16) };
  if (!['topup', 'spend'].includes(kind)) throw new Error('交易类型不正确');
  return { op: 'arm', kind, amountCents: parseMoney(form.amount), scene: textField(form.scene || (kind === 'topup' ? '充值' : '食堂'), '场景', 24) };
}
function originalCommand(entry) {
  if (!entry || entry.op !== 'arm' || !/^[0-9a-f]{16}$/i.test(entry.id) || !['issue', 'topup', 'spend'].includes(entry.kind)) throw new Error('原订单资料不完整，请先核对卡内余额及设备流水');
  const command = { op:'arm', id:entry.id, kind:entry.kind };
  if (entry.kind === 'issue') {
    textField(entry.name, '原订单姓名', 24); textField(entry.studentNo, '原订单学号', 16);
    command.name = entry.name; command.studentNo = entry.studentNo;
  } else {
    if (!Number.isInteger(entry.amountCents) || entry.amountCents <= 0 || entry.amountCents > 100000000) throw new Error('原订单金额不正确，请先核对卡内余额及设备流水');
    textField(entry.scene, '原订单场景', 24);
    command.amountCents = entry.amountCents; command.scene = entry.scene;
  }
  // Preserve every business field actually sent, without copying local metadata.
  for (const key of ['amountCents', 'name', 'studentNo', 'scene']) {
    if (Object.prototype.hasOwnProperty.call(entry, key)) command[key] = entry[key];
  }
  return command;
}

// The original business id is persisted before any BLE write. Disconnecting or
// reopening the mini program cannot turn an uncertain operation into a new one.
class OperationBook {
  constructor(storage, now = () => Date.now(), random = () => Math.random()) {
    this.storage = storage; this.now = now; this.random = random;
    this.entries = storage.getStorageSync(OPERATION_KEY) || {};
    if (!this.entries || typeof this.entries !== 'object' || Array.isArray(this.entries)) this.entries = {};
  }
  get(deviceId) { return this.entries[deviceId] || null; }
  begin(deviceId, operation) {
    if (!deviceId) throw new Error('请先连接校园卡终端');
    if (this.get(deviceId)) throw new Error('请先核对上一笔交易结果');
    const previous = Number(this.storage.getStorageSync(CLOCK_KEY)) || 0;
    const now = Math.max(this.now(), previous + 1);
    if (!Number.isSafeInteger(now) || now >= 0x1000000000000) throw new Error('设备时间不正确');
    const tail = Math.floor(this.random() * 65536) & 0xFFFF;
    const id = now.toString(16).padStart(12, '0') + tail.toString(16).padStart(4, '0');
    this.storage.setStorageSync(CLOCK_KEY, now);
    const entry = Object.assign({}, operation, { id, savedAt: this.now() });
    const entries = Object.assign({}, this.entries, { [deviceId]: entry });
    this.storage.setStorageSync(OPERATION_KEY, entries);
    this.entries = entries;
    return entry;
  }
  clear(deviceId, id) {
    const entry = this.get(deviceId);
    if (!entry || entry.id !== id) return false;
    const entries = Object.assign({}, this.entries); delete entries[deviceId];
    this.storage.setStorageSync(OPERATION_KEY, entries); this.entries = entries; return true;
  }
  reconcile(deviceId, state) {
    const entry = this.get(deviceId);
    if (!entry) return null;
    const result = [state.result, state.lastResult].find(item => item && item.id === entry.id && terminal(item.status));
    if (result) this.clear(deviceId, entry.id);
    return result || null;
  }
}
function decorateResult(result) {
  if (!result) return null;
  const kinds = { issue: '开卡', topup: '充值', spend: '消费' };
  const statuses = { success: '已完成', declined: '未通过', uncertain: '待核对', cancelled: '已取消', expired: '已超时' };
  let timeText = '设备未校时';
  if (Number.isInteger(result.timestamp) && result.timestamp >= 1704067200 && result.timestamp < 4102444800) {
    const date = new Date(result.timestamp * 1000);
    const pad = number => String(number).padStart(2, '0');
    timeText = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
  return Object.assign({}, result, {
    kindText: kinds[result.kind] || '交易', statusText: statuses[result.status] || result.status || '未知',
    amountText: money(result.amountCents || 0), balanceText: money(result.balanceCents), timeText,
    amountPrefix: result.kind === 'topup' ? '+' : result.kind === 'spend' ? '−' : ''
  });
}
module.exports = { parseMoney, money, textField, makeOperation, originalCommand, OperationBook, terminal, decorateResult, OPERATION_KEY };

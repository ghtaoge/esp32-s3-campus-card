const SERVICE_UUID = 'c4a10001-6d6a-4b2e-ae8b-3d80b18a5100';
const WRITE_UUID = 'c4a10002-6d6a-4b2e-ae8b-3d80b18a5100';
const NOTIFY_UUID = 'c4a10003-6d6a-4b2e-ae8b-3d80b18a5100';
const MAX_REQUEST = 512;
const MAX_RESPONSE = 4096;

// WeChat does not guarantee TextEncoder/TextDecoder globals.
function utf8(text) {
  const bytes = [];
  for (const char of String(text)) {
    const cp = char.codePointAt(0);
    if (cp >= 0xD800 && cp <= 0xDFFF) throw new Error('文字包含无效字符');
    if (cp < 128) bytes.push(cp);
    else if (cp < 2048) bytes.push(0xC0 | cp >> 6, 0x80 | cp & 63);
    else if (cp < 65536) bytes.push(0xE0 | cp >> 12, 0x80 | cp >> 6 & 63, 0x80 | cp & 63);
    else bytes.push(0xF0 | cp >> 18, 0x80 | cp >> 12 & 63, 0x80 | cp >> 6 & 63, 0x80 | cp & 63);
  }
  return new Uint8Array(bytes);
}
function decodeUtf8(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++];
    let cp, count, minimum;
    if (first < 128) { cp = first; count = 0; minimum = 0; }
    else if (first >= 0xC2 && first <= 0xDF) { cp = first & 31; count = 1; minimum = 0x80; }
    else if (first >= 0xE0 && first <= 0xEF) { cp = first & 15; count = 2; minimum = 0x800; }
    else if (first >= 0xF0 && first <= 0xF4) { cp = first & 7; count = 3; minimum = 0x10000; }
    else throw new Error('设备返回的文字编码不正确');
    while (count--) {
      if (i >= bytes.length || (bytes[i] & 0xC0) !== 0x80) throw new Error('设备返回的文字编码不完整');
      cp = (cp << 6) | (bytes[i++] & 63);
    }
    if (cp < minimum || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) throw new Error('设备返回的文字编码不正确');
    text += String.fromCodePoint(cp);
  }
  return text;
}
function packets(value, messageId, magic = 0xC7) {
  if (!Number.isInteger(messageId) || messageId < 0 || messageId > 65535 || (magic === 0xC7 && !messageId)) throw new Error('消息编号不正确');
  const bytes = utf8(JSON.stringify(value));
  const limit = magic === 0xC7 ? MAX_REQUEST : MAX_RESPONSE;
  if (!bytes.length || bytes.length > limit) throw new Error('消息太长，请缩短内容');
  const frames = [];
  for (let offset = 0; offset < bytes.length; offset += 12) {
    frames.push(new Uint8Array([magic, 1, messageId & 255, messageId >> 8,
      offset & 255, offset >> 8, bytes.length & 255, bytes.length >> 8,
      ...bytes.slice(offset, offset + 12)]));
  }
  return frames;
}
class Receiver {
  constructor() { this.reset(); }
  reset() { this.current = null; }
  accept(value) {
    const b = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (b.length < 9 || b.length > 20 || b[0] !== 0xC8 || b[1] !== 1) { this.reset(); throw new Error('设备响应格式不正确'); }
    const id = b[2] | b[3] << 8, offset = b[4] | b[5] << 8, total = b[6] | b[7] << 8;
    if (!total || total > MAX_RESPONSE || offset + b.length - 8 > total) { this.reset(); throw new Error('设备响应长度不正确'); }
    if (offset === 0) this.current = { id, total, received: 0, bytes: new Uint8Array(total) };
    const current = this.current;
    if (!current || current.id !== id || current.total !== total || current.received !== offset) { this.reset(); throw new Error('设备响应中断，请重新查询'); }
    current.bytes.set(b.slice(8), offset);
    current.received += b.length - 8;
    if (current.received !== total) return null;
    this.reset();
    const body = JSON.parse(decodeUtf8(current.bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('设备响应内容不正确');
    return { id, body };
  }
}
module.exports = { SERVICE_UUID, WRITE_UUID, NOTIFY_UUID, MAX_REQUEST, MAX_RESPONSE, utf8, decodeUtf8, packets, Receiver };

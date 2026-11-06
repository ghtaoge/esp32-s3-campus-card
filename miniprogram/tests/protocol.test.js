const { test } = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../utils/protocol');

test('Chinese JSON crosses 12-byte payload boundaries and round-trips without TextEncoder', () => {
  const body = { ok: true, card: { name: '小明同学', balanceCents: 3750 }, event: 'transaction' };
  const frames = protocol.packets(body, 65535, 0xC8), receiver = new protocol.Receiver();
  let result;
  frames.forEach((frame, index) => {
    assert.ok(frame.length <= 20); assert.equal(frame[4] | frame[5] << 8, index * 12);
    result = receiver.accept(frame.buffer);
    if (index < frames.length - 1) assert.equal(result, null);
  });
  assert.deepEqual(result, { id: 65535, body });
});
test('unsolicited event id=0 is accepted but requests cannot use it', () => {
  const frames = protocol.packets({ event: 'card' }, 0, 0xC8);
  const receiver = new protocol.Receiver(); let result;
  frames.forEach(frame => { result = receiver.accept(frame); });
  assert.equal(result.id, 0);
  assert.throws(() => protocol.packets({ op: 'state' }, 0));
});
test('missing fragment, inconsistent total and oversized response are rejected', () => {
  const frames = protocol.packets({ message: '足够长的中文测试消息，覆盖多个片段' }, 7, 0xC8);
  const receiver = new protocol.Receiver();
  receiver.accept(frames[0]); assert.throws(() => receiver.accept(frames[2]), /中断/);
  receiver.accept(frames[0]); const changed = frames[1].slice(); changed[6] += 1;
  assert.throws(() => receiver.accept(changed), /中断/);
  const tooLarge = frames[0].slice(); tooLarge[6] = 1; tooLarge[7] = 16;
  assert.throws(() => receiver.accept(tooLarge), /长度/);
});
test('strict UTF-8 rejects overlong, surrogate and truncated sequences', () => {
  for (const bytes of [[0xC0, 0x80], [0xED, 0xA0, 0x80], [0xF0, 0x9F]]) assert.throws(() => protocol.decodeUtf8(new Uint8Array(bytes)));
  assert.equal(protocol.decodeUtf8(protocol.utf8('校园卡🌙')), '校园卡🌙');
  assert.throws(() => protocol.utf8('\uD800'));
  assert.throws(() => protocol.packets({ text: '长'.repeat(200) }, 1), /太长/);
});

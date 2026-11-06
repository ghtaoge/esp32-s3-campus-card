#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>

namespace campusble {
constexpr uint8_t RequestMagic = 0xC7, ResponseMagic = 0xC8;
constexpr size_t MaxRequest = 512, MaxResponse = 4096, Header = 8, Payload = 12;
enum class Accepted { Invalid, Partial, Complete };
struct Receiver {
  char body[MaxRequest + 1] = {};
  uint16_t id = 0, received = 0, total = 0;
  uint32_t at = 0;
  void reset() { id = received = total = 0; }
  Accepted accept(const uint8_t* data, size_t size, uint32_t now) {
    if (size <= Header || size > 20 || data[0] != RequestMagic || data[1] != 1) return Accepted::Invalid;
    const uint16_t incomingId = data[2] | (data[3] << 8);
    const uint16_t offset = data[4] | (data[5] << 8), length = data[6] | (data[7] << 8);
    if (!incomingId || !length || length > MaxRequest || offset + size - Header > length) return Accepted::Invalid;
    if (!offset) { reset(); id = incomingId; total = length; }
    if (id != incomingId || length != total || offset != received || (received && now - at > 5000)) {
      reset(); return Accepted::Invalid;
    }
    memcpy(body + received, data + Header, size - Header);
    received += size - Header; at = now;
    if (received != total) return Accepted::Partial;
    body[total] = 0;
    return Accepted::Complete;
  }
};
inline size_t makeFrame(uint8_t* out, uint16_t id, const char* body, uint16_t total, uint16_t offset) {
  if (offset >= total || total > MaxResponse) return 0;
  out[0] = ResponseMagic; out[1] = 1;
  out[2] = id; out[3] = id >> 8;
  out[4] = offset; out[5] = offset >> 8;
  out[6] = total; out[7] = total >> 8;
  const size_t remaining = static_cast<size_t>(total - offset);
  const size_t count = remaining > Payload ? Payload : remaining;
  memcpy(out + Header, body + offset, count);
  return Header + count;
}
}

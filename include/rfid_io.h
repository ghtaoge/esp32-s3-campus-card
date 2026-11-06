#pragma once
#include <MFRC522.h>
#include <Preferences.h>
#include "campus_core.h"

// The engine's block allowlist is enforced again at the hardware boundary.
class RfidIO final : public campus::CardIO {
 public:
  explicit RfidIO(MFRC522& reader) : reader_(reader) {}
  bool readBlock(uint8_t block, uint8_t out[16]) override {
    if (!allowed(block) || !authenticate(block)) return false;
    uint8_t bytes[18], size = sizeof(bytes);
    if (reader_.MIFARE_Read(block,bytes,&size) != MFRC522::STATUS_OK || size < 16) return false;
    memcpy(out,bytes,16); return true;
  }
  bool writeBlock(uint8_t block, const uint8_t data[16]) override {
    if (!allowed(block) || !authenticate(block)) return false;
    // MFRC522's legacy API takes a mutable pointer but does not modify this buffer.
    uint8_t bytes[16]; memcpy(bytes,data,16);
    return reader_.MIFARE_Write(block,bytes,16) == MFRC522::STATUS_OK;
  }
 private:
  MFRC522& reader_;
  uint8_t sector_ = 255;
  static bool allowed(uint8_t block) {
    switch (block) {
      case 4:case 5:case 6:case 8:case 9:case 10:
      case 12:case 13:case 14:case 16:case 17:case 18:return true;
      default:return false;
    }
  }
  bool authenticate(uint8_t block) {
    if (sector_ == block / 4) return true;
    MFRC522::MIFARE_Key key; memset(key.keyByte,0xFF,sizeof(key.keyByte));
    if (reader_.PCD_Authenticate(MFRC522::PICC_CMD_MF_AUTH_KEY_A,block,&key,&reader_.uid) != MFRC522::STATUS_OK) {
      sector_=255; return false;
    }
    sector_=block/4; return true;
  }
};

class NvsStore final : public campus::Store {
 public:
  bool open() { opened_ = preferences_.begin("campus-ledger",false); return opened_; }
  int load(campus::State& state) override {
    if (!opened_) return -1;
    if (!preferences_.isKey("state")) return 0;
    if (preferences_.getBytesLength("state") != sizeof(state)) return -1;
    return preferences_.getBytes("state",&state,sizeof(state)) == sizeof(state) ? 1 : -1;
  }
  bool save(const campus::State& state) override {
    return opened_ && preferences_.putBytes("state",&state,sizeof(state)) == sizeof(state);
  }
 private:
  Preferences preferences_;
  bool opened_=false;
};

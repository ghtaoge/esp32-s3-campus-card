#pragma once
#include <stdint.h>

// WUPA and HALT are short control frames. The MFRC522 library normally gives
// every frame a 25ms timeout. Use 3ms here, then restore the original reload
// registers before selection, authentication, reads and writes.
namespace campusio {
template<class Reader> class ShortFrameTimeout {
 public:
  explicit ShortFrameTimeout(Reader& reader):reader_(reader) {
    high_=reader_.PCD_ReadRegister(Reader::TReloadRegH);
    low_=reader_.PCD_ReadRegister(Reader::TReloadRegL);
    reader_.PCD_WriteRegister(Reader::TReloadRegH,0);
    reader_.PCD_WriteRegister(Reader::TReloadRegL,120);
  }
  ~ShortFrameTimeout(){reader_.PCD_WriteRegister(Reader::TReloadRegH,high_);reader_.PCD_WriteRegister(Reader::TReloadRegL,low_);}
  ShortFrameTimeout(const ShortFrameTimeout&)=delete;
  ShortFrameTimeout& operator=(const ShortFrameTimeout&)=delete;
 private:
  Reader& reader_;uint8_t high_=0,low_=0;
};
}

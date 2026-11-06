#pragma once
struct FakeWire {
  bool begin(int,int){return true;}
  void setTimeOut(unsigned){}
  void beginTransmission(unsigned){}
  unsigned endTransmission(){return 0;}
};
inline FakeWire Wire;

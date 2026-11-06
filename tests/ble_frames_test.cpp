#include "ble_frames.h"
#include <assert.h>
#include <string>
#include <stdio.h>
using namespace campusble;
int main() {
  Receiver receiver;
  const std::string json="{\"op\":\"arm\",\"name\":\"小明\",\"amountCents\":1250}";
  uint8_t frame[20];
  for (size_t offset=0; offset<json.size();offset+=Payload) {
    size_t size=makeFrame(frame,42,json.c_str(),json.size(),offset);
    frame[0]=RequestMagic;
    auto result=receiver.accept(frame,size,100+offset);
    assert(result==(offset+Payload>=json.size()?Accepted::Complete:Accepted::Partial));
  }
  assert(receiver.id==42 && receiver.total==json.size());
  assert(std::string(receiver.body)==json);
  size_t size=makeFrame(frame,43,json.c_str(),json.size(),0);frame[0]=RequestMagic;
  assert(receiver.accept(frame,size,100)==Accepted::Partial);
  size=makeFrame(frame,43,json.c_str(),json.size(),12);frame[0]=RequestMagic;
  assert(receiver.accept(frame,size,5101)==Accepted::Invalid);
  size=makeFrame(frame,44,json.c_str(),json.size(),0);frame[0]=RequestMagic;
  assert(receiver.accept(frame,size,5200)==Accepted::Partial);
  size=makeFrame(frame,44,json.c_str(),json.size(),24);frame[0]=RequestMagic;
  assert(receiver.accept(frame,size,5300)==Accepted::Invalid);
  size=makeFrame(frame,45,json.c_str(),json.size(),0);frame[0]=RequestMagic;frame[6]=1;frame[7]=3;
  assert(receiver.accept(frame,size,5400)==Accepted::Invalid);
  assert(receiver.accept(frame,7,5500)==Accepted::Invalid);
  frame[0]=0;assert(receiver.accept(frame,size,5500)==Accepted::Invalid);
  assert(makeFrame(frame,1,json.c_str(),4097,0)==0);
  assert(makeFrame(frame,1,json.c_str(),json.size(),json.size())==0);
  puts("BLE transport boundaries, UTF-8 bytes, ordering and timeout: OK");
}

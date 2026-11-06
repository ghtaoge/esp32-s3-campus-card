#include "ble_outbox.h"
#include "usb_lines.h"
#include "power_policy.h"
#include "rfid_timing.h"
#include "log_snapshot.h"
#include <assert.h>
#include <stdio.h>
#include <string>

struct Reader {
  enum Register{TReloadRegH,TReloadRegL};uint8_t registers[2]={3,232};unsigned writes=0;
  uint8_t PCD_ReadRegister(Register r){return registers[r];}
  void PCD_WriteRegister(Register r,uint8_t value){registers[r]=value;++writes;}
};
void earlyReturn(Reader& reader){campusio::ShortFrameTimeout<Reader> guard(reader);assert(reader.registers[0]==0&&reader.registers[1]==120);}
void testTimeoutScope() {
  Reader reader;earlyReturn(reader);assert(reader.registers[0]==3&&reader.registers[1]==232&&reader.writes==4);
  reader.registers[0]=1;reader.registers[1]=100;
  {campusio::ShortFrameTimeout<Reader> guard(reader);assert(reader.registers[1]==120);}
  assert(reader.registers[0]==1&&reader.registers[1]==100);
}
void testOutbox() {
  campusble::Outbox<std::string> queue;
  assert(queue.push(0,std::string(30,'a')));assert(queue.push(0,std::string(30,'b')));
  assert(queue.size()==1&&queue.front().body[0]=='b');
  queue.front().offset=12;
  assert(queue.push(0,std::string(30,'c')));assert(queue.size()==2);
  assert(queue.push(7,"reply7"));assert(queue.size()==2&&queue.front().id==0&&queue.front().offset==12);
  assert(queue.push(8,"reply8"));assert(queue.size()==3);
  assert(!queue.push(9,"reply9"));assert(queue.size()==3);
  assert(!queue.takeDeferred());queue.pop();assert(queue.front().id==7);queue.pop();assert(queue.front().id==8);queue.pop();
  assert(queue.takeDeferred());assert(!queue.takeDeferred());
  queue.deferEvent();assert(queue.push(0,"fresh"));assert(!queue.takeDeferred());
  queue.clear();assert(queue.empty());assert(!queue.takeDeferred());
}
void testLines() {
  campususb::Lines line;const std::string input="{\"id\":1,\"body\":{\"name\":\"小明\"}}\r\n";
  for(size_t i=0;i<input.size();++i)assert(line.accept(input[i])==(i+1==input.size()?campususb::LineResult::Complete:campususb::LineResult::Partial));
  assert(std::string(line.body)==input.substr(0,input.size()-2));line.reset();
  for(size_t i=0;i<campususb::MaxRequestLine+10;++i)assert(line.accept('x')==campususb::LineResult::Partial);
  assert(line.accept('\n')==campususb::LineResult::Overflow);assert(line.size==0&&!line.discarding);
  assert(line.accept('{')==campususb::LineResult::Partial);assert(line.accept('}')==campususb::LineResult::Partial);
  assert(line.accept('\n')==campususb::LineResult::Complete);assert(std::string(line.body)=="{}");
  campususb::Connection connection;assert(!connection.update(false,0));assert(connection.update(true,10));
  assert(connection.update(false,100));assert(connection.update(true,150));assert(connection.update(false,349));
  assert(connection.update(false,548));assert(!connection.update(false,549));assert(connection.update(true,600));
  assert(connection.update(false,5000));assert(!connection.update(false,5200));
  connection.update(true,UINT32_MAX-99);assert(connection.update(false,99));assert(connection.update(false,298));assert(!connection.update(false,299));
}
void testPower() {
  campuspower::Policy power;power.config.idleSeconds=10;power.activity(0);
  assert(!power.tick(9999,false)&&power.awake);assert(power.tick(10000,false)&&!power.awake);
  assert(!power.tick(20000,false));power.activity(20001);assert(power.awake);
  assert(!power.tick(40000,true)&&power.awake);assert(power.tick(40001,false)&&!power.awake);
  power.config.idleSeconds=0;assert(power.tick(50000,false)&&power.awake);
  power.config.idleSeconds=10;power.activity(UINT32_MAX-4999);assert(!power.tick(4999,false));assert(power.tick(5000,false)&&!power.awake);
  power.config.batteryMode=true;assert(power.pollInterval(false)==500&&power.pollInterval(true)==120);
  assert(campuspower::valid(power.config));power.config.brightness=0;assert(!campuspower::valid(power.config));
}
struct LogEngine {
  campus::Result rows[campus::LogCount]{};size_t count=0;
  const campus::Result* log(size_t i)const{return i<count?&rows[i]:nullptr;}
};
void testSnapshots() {
  LogEngine engine;engine.count=20;for(size_t i=0;i<20;++i){engine.rows[i].id=i+1;engine.rows[i].balanceCents=1000-i;}
  campuslog::Snapshot ble,usb;ble.capture(engine);const uint32_t revision=ble.revision;
  engine.rows[0].balanceCents=9999;usb.capture(engine);
  assert(ble.records[0].balanceCents==1000&&usb.records[0].balanceCents==9999);
  assert(ble.matches(revision,5)&&ble.matches(revision,20)&&!ble.matches(revision,21));
  size_t visited=0;for(size_t offset=0;offset<ble.count;offset+=5)for(size_t i=offset;i<offset+5&&i<ble.count;++i){assert(ble.records[i].id==i+1);++visited;}
  assert(visited==20);ble.capture(engine);assert(!ble.matches(revision,5));ble.clear();assert(!ble.matches(ble.revision,0));
  usb.revision=UINT32_MAX;usb.capture(engine);assert(usb.revision==1);
}
int main(){testTimeoutScope();testOutbox();testLines();testPower();testSnapshots();puts("Runtime I/O: bounded queues, non-interleaving, USB boundaries, power and log snapshots passed");}

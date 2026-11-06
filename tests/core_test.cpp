#include "campus_core.h"
#include <cassert>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <type_traits>
using namespace campus;

struct MemoryStore : Store {
  State saved{};bool present=false;int saves=0,failSaveAt=-1;
  int load(State& out)override{if(!present)return 0;memcpy(&out,&saved,sizeof(saved));return 1;}
  bool save(const State& value)override {
    if(++saves==failSaveAt)return false;
    memcpy(&saved,&value,sizeof(value));present=true;return true;
  }
};
struct MemoryCard : CardIO {
  uint8_t data[64][16]{};int reads=0,writes=0,failReadAt=-1,failWriteAt=-1,crashAfterWrite=-1;
  bool readBlock(uint8_t b,uint8_t out[16])override {
    assert(b<64&&b!=0&&b%4!=3);
    if(++reads==failReadAt)return false;
    memcpy(out,data[b],16);return true;
  }
  bool writeBlock(uint8_t b,const uint8_t in[16])override {
    assert(b<64&&b!=0&&b%4!=3);
    if(++writes==failWriteAt)return false;
    memcpy(data[b],in,16);
    if(writes==crashAfterWrite)throw std::runtime_error("simulated power loss");
    return true;
  }
};
const uint8_t uid[]={0x12,0x34,0x56,0x78};
const uint8_t anotherUid[]={0x12,0x34,0x56,0x79};
Request request(uint64_t id,Kind kind,int32_t amount=0) {
  Request r{};r.id=id;r.kind=kind;r.amountCents=amount;
  if(kind==Kind::Issue){strcpy(r.name,"小明");strcpy(r.studentNo,"20260001");}
  strcpy(r.scene,kind==Kind::Spend?"食堂":kind==Kind::Topup?"充值":"开卡");return r;
}
void issue(Engine& e,MemoryCard& card) {
  assert(e.arm(request(1,Kind::Issue),1)==Code::Ok);
  assert(e.scan(card,uid,4,2,1800000000)==Code::Ok);
  assert(e.card()&&e.card()->balanceCents==0&&e.card()->sequence==0);
}
void topup(Engine& e,MemoryCard& card,uint64_t id=2,int32_t amount=5000) {
  assert(e.arm(request(id,Kind::Topup,amount),100)==Code::Ok);
  assert(e.scan(card,uid,4,101,1800000001)==Code::Ok);
}
void testHappyAndDuplicates() {
  MemoryStore store;MemoryCard card;Engine e(store);assert(e.begin());
  assert(e.scan(card,uid,4,0)==Code::CardBlank);assert(card.writes==0);
  issue(e,card);topup(e,card);
  assert(e.arm(request(3,Kind::Spend,1250),200)==Code::Ok);
  assert(e.scan(card,uid,4,201)==Code::Ok);
  assert(e.card()->balanceCents==3750&&e.card()->sequence==2);
  int writes=card.writes;
  assert(e.arm(request(3,Kind::Spend,1250),300)==Code::Ok);
  assert(e.state().pending.phase==Phase::None);
  assert(e.scan(card,uid,4,301)==Code::Ok);assert(card.writes==writes);
  assert(e.arm(request(3,Kind::Spend,1251),302)==Code::IdConflict);
  assert(e.result(3)->balanceCents==3750&&e.log(0)->kind==Kind::Spend);
  assert(e.log(2)->kind==Kind::Issue&&e.log(3)==nullptr);
  Engine reboot(store);assert(reboot.begin());
  assert(reboot.arm(request(3,Kind::Spend,1250),500)==Code::Ok);
  assert(reboot.scan(card,uid,4,501)==Code::Ok&&card.writes==writes);
}
void testDeclineCancelExpiry() {
  MemoryStore store;MemoryCard card;Engine e(store);assert(e.begin());issue(e,card);
  assert(e.arm(request(2,Kind::Spend,100),0)==Code::Ok);
  assert(e.scan(card,uid,4,1)==Code::Insufficient);
  assert(e.result(2)->status==ResultStatus::Declined&&e.state().pending.phase==Phase::None);
  assert(e.arm(request(3,Kind::Topup,100),10)==Code::Ok);
  assert(e.cancel(11)==Code::Cancelled&&e.result(3)->status==ResultStatus::Cancelled);
  assert(e.arm(request(4,Kind::Topup,100),0xfffffff0u)==Code::Ok);
  assert(!e.tick(0x20u));assert(e.tick(0x8000u));
  assert(e.result(4)->status==ResultStatus::Expired);
  assert(e.arm(request(5,Kind::Topup,100),70000)==Code::Ok);
  Engine reboot(store);assert(reboot.begin(0));
  assert(reboot.state().pending.phase==Phase::None&&reboot.result(5)->status==ResultStatus::Expired);
  assert(reboot.arm(request(6,Kind::Topup,100),100)==Code::Ok);
  assert(reboot.scan(card,uid,4,30100)==Code::Expired);assert(reboot.card()->balanceCents==0);
}
void testInvalidAndUnknownCards() {
  MemoryStore store;MemoryCard card;Engine e(store);assert(e.begin());
  assert(e.arm(request(0,Kind::Issue),0)==Code::Invalid);
  assert(e.arm(request(8,Kind::Topup,-1),0)==Code::Invalid);
  assert(e.arm(request(8,Kind::Topup,MaxBalance+1),0)==Code::Invalid);
  Request bad=request(8,Kind::Issue);memset(bad.name,'a',sizeof(bad.name));assert(e.arm(bad,0)==Code::Invalid);
  bad=request(8,Kind::Issue);strcpy(bad.name,"\xc0\x80");assert(e.arm(bad,0)==Code::Invalid);
  card.data[4][0]=42;assert(e.arm(request(1,Kind::Issue),0)==Code::Ok);
  assert(e.scan(card,uid,4,1)==Code::CardCorrupt&&card.writes==0);
  assert(e.result(1)->status==ResultStatus::Declined);
}
void testWriteFailureRecoveryAtEveryBlock() {
  for(int fail=1;fail<=6;++fail) {
    MemoryStore store;MemoryCard card;Engine e(store);assert(e.begin());issue(e,card);topup(e,card);
    assert(e.arm(request(3,Kind::Spend,1250),200)==Code::Ok);
    card.failWriteAt=card.writes+fail;
    assert(e.scan(card,uid,4,201)==Code::Uncertain);
    assert(e.state().pending.phase==Phase::Uncertain&&e.cancel(202)==Code::Busy);
    assert(e.arm(request(4,Kind::Topup,100),203)==Code::Busy);
    assert(e.scan(card,anotherUid,4,204)==Code::WrongCard);
    card.failWriteAt=-1;
    Engine reboot(store);assert(reboot.begin());
    assert(reboot.scan(card,uid,4,1)==Code::Ok);
    assert(reboot.card()->balanceCents==3750&&reboot.card()->sequence==2);
    assert(reboot.state().pending.phase==Phase::None&&reboot.result(3)->status==ResultStatus::Success);
    const int writes=card.writes;
    assert(reboot.arm(request(3,Kind::Spend,1250),5)==Code::Ok);
    assert(reboot.scan(card,uid,4,6)==Code::Ok&&card.writes==writes);
  }
}
void testPowerLossAndReadbackFailure() {
  for(int block=1;block<=6;++block) {
    MemoryStore store;MemoryCard card;Engine e(store);assert(e.begin());issue(e,card);topup(e,card);
    assert(e.arm(request(3,Kind::Spend,1250),200)==Code::Ok);
    card.crashAfterWrite=card.writes+block;
    try{e.scan(card,uid,4,201);assert(false);}catch(const std::runtime_error&){}
    card.crashAfterWrite=-1;Engine reboot(store);assert(reboot.begin());
    const int writes=card.writes;
    assert(reboot.scan(card,uid,4,0)==Code::Ok&&reboot.card()->balanceCents==3750);
    if(block==6)assert(card.writes==writes); // card had committed before power failed.
  }
  MemoryStore store;MemoryCard card;Engine e(store);assert(e.begin());issue(e,card);
  assert(e.arm(request(2,Kind::Topup,5000),100)==Code::Ok);
  card.failReadAt=card.reads+13; // twelve slot reads, then first verify block.
  assert(e.scan(card,uid,4,101)==Code::Uncertain);
  card.failReadAt=-1;const int writes=card.writes;
  assert(e.scan(card,uid,4,102)==Code::Ok&&card.writes==writes&&e.card()->balanceCents==5000);
}
void testIssueInterrupted() {
  for(int fail=1;fail<=6;++fail) {
    MemoryStore store;MemoryCard card;Engine e(store);assert(e.begin());
    assert(e.arm(request(1,Kind::Issue),0)==Code::Ok);card.failWriteAt=fail;
    assert(e.scan(card,uid,4,1)==Code::Uncertain);card.failWriteAt=-1;
    Engine reboot(store);assert(reboot.begin());assert(reboot.scan(card,uid,4,2)==Code::Ok);
    assert(reboot.card()->cardNo==10000001&&reboot.card()->balanceCents==0&&reboot.state().nextCardNo==10000002);
  }
}
void testStorageFailureBeforeAndAfterCard() {
  MemoryStore store;MemoryCard card;Engine e(store);assert(e.begin());issue(e,card);
  assert(e.arm(request(2,Kind::Topup,5000),100)==Code::Ok);int writes=card.writes;
  store.failSaveAt=store.saves+1;
  assert(e.scan(card,uid,4,101)==Code::StorageError&&card.writes==writes);
  store.failSaveAt=store.saves+2; // prepare succeeds; final local commit fails.
  assert(e.scan(card,uid,4,102)==Code::StorageError);
  assert(e.state().pending.phase==Phase::Uncertain);writes=card.writes;
  store.failSaveAt=-1;Engine reboot(store);assert(reboot.begin());
  assert(reboot.scan(card,uid,4,1)==Code::Ok&&card.writes==writes&&reboot.card()->balanceCents==5000);
}
void testStaleAndTamperedSnapshots() {
  MemoryStore store;MemoryCard card;Engine e(store);assert(e.begin());issue(e,card);topup(e,card);
  MemoryCard old=card;
  assert(e.arm(request(3,Kind::Spend,1000),200)==Code::Ok);assert(e.scan(card,uid,4,201)==Code::Ok);
  const CardRecord latest=*e.card();
  assert(e.scan(old,uid,4,202)==Code::StaleCard);
  uint8_t original[RecordBytes];CardRecord edited=latest;edited.balanceCents=9999;
  encodeRecord(edited,original);
  for(int b=0;b<6;++b)memcpy(old.data[SlotBlocks[1][b]],original+b*16,16);
  // Restore a coherent pair but alter the latest balance at the known sequence.
  for(int b=0;b<6;++b)memcpy(old.data[SlotBlocks[0][b]],card.data[SlotBlocks[0][b]],16);
  // Put the altered current snapshot in its actual slot (slot0 after third transaction).
  for(int b=0;b<6;++b)memcpy(old.data[SlotBlocks[0][b]],original+b*16,16);
  for(int b=0;b<6;++b)memcpy(old.data[SlotBlocks[1][b]],card.data[SlotBlocks[1][b]],16);
  assert(e.scan(old,uid,4,203)==Code::StaleCard);
  Engine corrupt(store);store.saved.checksum^=1;assert(!corrupt.begin());
}
void testRetentionAndLimits() {
  MemoryStore store;MemoryCard card;Engine e(store);assert(e.begin());issue(e,card);
  for(uint64_t id=2;id<=30;++id)topup(e,card,id,1);
  assert(e.state().logSize==LogCount&&e.result(2)==nullptr);
  const int writes=card.writes;
  assert(e.arm(request(2,Kind::Topup,1),500)==Code::ResultExpired);
  assert(e.scan(card,uid,4,501)==Code::Ok&&card.writes==writes);
  assert(e.arm(request(31,Kind::Topup,MaxBalance),600)==Code::Ok);
  assert(e.scan(card,uid,4,601)==Code::Limit);
}
int main() {
  static_assert(std::is_trivially_copyable<State>::value,"binary persistence requires POD-compatible state");
  testHappyAndDuplicates();testDeclineCancelExpiry();
  testInvalidAndUnknownCards();
  // Unknown card contents are rejected without issuing/writing.
  {MemoryStore s;MemoryCard c;Engine e(s);assert(e.begin());c.data[4][0]=42;
   assert(e.arm(request(50,Kind::Issue),0)==Code::Ok);assert(e.scan(c,uid,4,1)==Code::CardCorrupt&&c.writes==0);}
  {MemoryStore s;Engine e(s);assert(e.begin());assert(e.arm(request(0,Kind::Issue),0)==Code::Invalid);
   assert(e.arm(request(9,Kind::Topup,-1),0)==Code::Invalid);
   Request r=request(9,Kind::Issue);memset(r.name,'a',sizeof(r.name));assert(e.arm(r,0)==Code::Invalid);}
  testWriteFailureRecoveryAtEveryBlock();testPowerLossAndReadbackFailure();testIssueInterrupted();
  testStorageFailureBeforeAndAfterCard();testStaleAndTamperedSnapshots();testRetentionAndLimits();
  std::printf("campus core: all transaction/recovery tests passed; State=%zu bytes\n",sizeof(State));
}

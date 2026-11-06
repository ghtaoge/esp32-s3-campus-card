#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <limits.h>

// Arduino-independent single-terminal demonstration ledger. No authentication
// claim: CRC detects accidental damage, not malicious balance modifications.
namespace campus {
constexpr int32_t MaxBalance = 100000000;
constexpr size_t LogCount = 20, SeenCount = 96, HistoryCount = 16;
constexpr size_t RecordBytes = 96;
constexpr uint8_t SlotBlocks[2][6] = {{4,5,6,8,9,10},{12,13,14,16,17,18}};
enum class Kind : uint8_t { None, Issue, Topup, Spend };
enum class Phase : uint8_t { None, Waiting, Uncertain };
enum class ResultStatus : uint8_t { None, Success, Declined, Uncertain, Cancelled, Expired };
enum class Code : uint8_t {
  Ok, Invalid, Busy, IdConflict, StorageError, CardIo, CardBlank, CardCorrupt,
  AlreadyIssued, Insufficient, Limit, WrongCard, CardChanged, StaleCard,
  Uncertain, Cancelled, Expired, ResultExpired, NotReady
};
inline const char* kindName(Kind k) {
  switch(k) { case Kind::Issue:return "issue";case Kind::Topup:return "topup";
    case Kind::Spend:return "spend"; default:return "none"; }
}
inline const char* phaseName(Phase p) {
  return p==Phase::Waiting?"waiting":p==Phase::Uncertain?"uncertain":"none";
}
inline const char* statusName(ResultStatus s) {
  switch(s) {case ResultStatus::Success:return "success";case ResultStatus::Declined:return "declined";
    case ResultStatus::Uncertain:return "uncertain";case ResultStatus::Cancelled:return "cancelled";
    case ResultStatus::Expired:return "expired";default:return "none";}
}
inline const char* codeName(Code c) {
  switch(c) {
    case Code::Ok:return "OK";case Code::Invalid:return "INVALID";case Code::Busy:return "BUSY";
    case Code::IdConflict:return "ID_CONFLICT";case Code::StorageError:return "STORAGE_ERROR";
    case Code::CardIo:return "CARD_IO";case Code::CardBlank:return "CARD_NOT_ISSUED";
    case Code::CardCorrupt:return "CARD_CORRUPT";case Code::AlreadyIssued:return "ALREADY_ISSUED";
    case Code::Insufficient:return "INSUFFICIENT";case Code::Limit:return "LIMIT";
    case Code::WrongCard:return "WRONG_CARD";case Code::CardChanged:return "CARD_CHANGED";
    case Code::StaleCard:return "STALE_CARD";case Code::Uncertain:return "UNCERTAIN";
    case Code::Cancelled:return "CANCELLED";case Code::Expired:return "EXPIRED";
    case Code::ResultExpired:return "RESULT_EXPIRED";default:return "NOT_READY";
  }
}
inline const char* message(Code c) {
  switch(c) {
    case Code::Ok:return "操作成功";case Code::Invalid:return "请求参数不正确";
    case Code::Busy:return "请先完成当前交易";case Code::IdConflict:return "交易编号已用于其他操作";
    case Code::StorageError:return "本地记录保存失败，请重刷原卡核对";
    case Code::CardIo:return "读卡失败，请移开后重新刷卡";
    case Code::CardBlank:return "卡片尚未开卡";case Code::CardCorrupt:return "卡片数据异常，未执行交易";
    case Code::AlreadyIssued:return "此卡已经开卡";case Code::Insufficient:return "余额不足";
    case Code::Limit:return "金额或交易序号达到上限";case Code::WrongCard:return "请刷待确认交易的原卡";
    case Code::CardChanged:return "卡片数据已变化，请保留卡片和设备记录";
    case Code::StaleCard:return "卡片记录早于本机已确认记录，未执行交易";
    case Code::Uncertain:return "结果待确认，请移开后重新刷原卡";
    case Code::Cancelled:return "等待任务已取消";case Code::Expired:return "刷卡等待已超时";
    case Code::ResultExpired:return "该交易已处理，明细已过期，请刷卡查询余额";
    default:return "本地存储未就绪";
  }
}
inline uint32_t crc32(const uint8_t* bytes,size_t size) {
  uint32_t crc=0xffffffffu;
  while(size--) {crc^=*bytes++;for(unsigned i=0;i<8;++i)crc=(crc>>1)^(0xedb88320u&static_cast<uint32_t>(-static_cast<int32_t>(crc&1)));}
  return ~crc;
}
inline void put32(uint8_t* p,uint32_t v) {for(unsigned i=0;i<4;++i)p[i]=static_cast<uint8_t>(v>>(8*i));}
inline uint32_t get32(const uint8_t* p) {return uint32_t(p[0])|(uint32_t(p[1])<<8)|(uint32_t(p[2])<<16)|(uint32_t(p[3])<<24);}
inline void put64(uint8_t* p,uint64_t v) {put32(p,uint32_t(v));put32(p+4,uint32_t(v>>32));}
inline uint64_t get64(const uint8_t* p) {return uint64_t(get32(p))|(uint64_t(get32(p+4))<<32);}
inline bool validUtf8(const char* text,size_t capacity,bool nonempty=false) {
  size_t n=0;while(n<capacity && text[n])++n;
  if(n==capacity || (nonempty && !n))return false;
  for(size_t i=0;i<n;) {
    uint8_t a=uint8_t(text[i++]);uint32_t cp;unsigned count;uint32_t min;
    if(a<0x80){cp=a;count=0;min=0;}
    else if(a>=0xc2&&a<=0xdf){cp=a&31;count=1;min=0x80;}
    else if(a>=0xe0&&a<=0xef){cp=a&15;count=2;min=0x800;}
    else if(a>=0xf0&&a<=0xf4){cp=a&7;count=3;min=0x10000;}
    else return false;
    while(count--){if(i>=n)return false;uint8_t b=uint8_t(text[i++]);if((b&0xc0)!=0x80)return false;cp=(cp<<6)|(b&63);}
    if(cp<min||cp>0x10ffff||(cp>=0xd800&&cp<=0xdfff)||cp<32||(cp>=127&&cp<=159))return false;
  }
  return true;
}
struct Request {
  uint64_t id=0;Kind kind=Kind::None;int32_t amountCents=0;
  char name[25]={},studentNo[17]={},scene[25]={};
};
struct CardRecord {
  uint64_t lastTxId=0;uint32_t cardNo=0;int32_t balanceCents=0;uint32_t sequence=0;
  uint32_t uidHash=0;char uid[21]={},name[25]={},studentNo[17]={};
};
struct Result {
  uint64_t id=0;uint32_t requestHash=0;Kind kind=Kind::None;ResultStatus status=ResultStatus::None;
  Code code=Code::Ok;char uid[21]={};uint32_t cardNo=0;int32_t amountCents=0,balanceCents=0;
  uint32_t sequence=0;char scene[25]={};uint32_t timestamp=0,uptimeMs=0;
};
struct Pending {
  Request request{};Phase phase=Phase::None;uint32_t armedAt=0;
};
struct Journal {
  char uid[21]={};uint8_t targetSlot=0,beforeSlot=0;bool beforeValid=false;
  uint8_t before[RecordBytes]={},targetBefore[RecordBytes]={},after[RecordBytes]={};
  uint32_t timestamp=0,uptimeMs=0;
};
struct Seen {uint64_t id=0;uint32_t requestHash=0;};
struct History {uint64_t lastTxId=0;uint32_t uidHash=0,cardNo=0,sequence=0,recordHash=0;};
struct State {
  uint32_t magic=0,version=0,checksum=0,nextCardNo=10000001;
  uint16_t logSize=0,logHead=0,seenSize=0,seenHead=0,historySize=0,historyHead=0;
  Pending pending{};Journal journal{};
  Result logs[LogCount]{};Seen seen[SeenCount]{};History history[HistoryCount]{};
};
static_assert(sizeof(State)<=5120,"NVS state must fit the demonstration storage budget");
struct CardIO {
  virtual ~CardIO()=default;
  virtual bool readBlock(uint8_t block,uint8_t out[16])=0;
  virtual bool writeBlock(uint8_t block,const uint8_t data[16])=0;
};
struct Store {
  virtual ~Store()=default;
  // 0=no saved record, 1=record loaded, -1=I/O/length error.
  virtual int load(State& out)=0;
  virtual bool save(const State& value)=0;
};
inline void encodeRecord(const CardRecord& r,uint8_t out[RecordBytes]) {
  memset(out,0,RecordBytes);memcpy(out,"CAMP",4);out[4]=1;
  put32(out+8,r.cardNo);put32(out+12,uint32_t(r.balanceCents));put32(out+16,r.sequence);
  put64(out+20,r.lastTxId);put32(out+28,r.uidHash);
  memcpy(out+32,r.name,24);memcpy(out+56,r.studentNo,16);
  put32(out+92,crc32(out,92));
}
inline bool decodeRecord(const uint8_t in[RecordBytes],uint32_t uidHash,CardRecord& out) {
  if(memcmp(in,"CAMP",4)||in[4]!=1||get32(in+92)!=crc32(in,92)||get32(in+28)!=uidHash)return false;
  CardRecord r{};r.cardNo=get32(in+8);r.balanceCents=int32_t(get32(in+12));
  r.sequence=get32(in+16);r.lastTxId=get64(in+20);r.uidHash=uidHash;
  memcpy(r.name,in+32,24);memcpy(r.studentNo,in+56,16);
  if(!r.cardNo||r.balanceCents<0||r.balanceCents>MaxBalance||!r.lastTxId||
    !validUtf8(r.name,sizeof(r.name),true)||!validUtf8(r.studentNo,sizeof(r.studentNo)))return false;
  out=r;return true;
}
class Engine {
 public:
  explicit Engine(Store& store):store_(store){}
  bool begin(uint32_t now=0) {
    ready_=false;haveCard_=false;last_={};State loaded{};const int loadedStatus=store_.load(loaded);
    if(loadedStatus<0)return false;
    if(loadedStatus>0) {
      if(!validState(loaded))return false;
      state_=loaded;ready_=true;
      if(state_.logSize)last_=*log(0);
      if(state_.pending.phase==Phase::Waiting)finish(ResultStatus::Expired,Code::Expired,nullptr,now,0);
      else if(state_.pending.phase==Phase::Uncertain)makeUncertain(Code::Uncertain,now,0);
      return true;
    }
    state_=State{};ready_=persist(state_);return ready_;
  }
  const State& state()const{return state_;}
  const CardRecord* card()const{return haveCard_?&card_:nullptr;}
  const Result* lastResult()const{return last_.status==ResultStatus::None?nullptr:&last_;}
  bool ready()const{return ready_;}
  const Result* log(size_t newestIndex)const {
    if(newestIndex>=state_.logSize)return nullptr;
    return &state_.logs[(state_.logHead+LogCount-1-newestIndex)%LogCount];
  }
  const Result* result(uint64_t id)const {
    if(last_.id==id&&last_.status!=ResultStatus::None)return &last_;
    for(size_t i=0;i<state_.logSize;++i)if(log(i)->id==id)return log(i);
    return nullptr;
  }
  Code arm(const Request& request,uint32_t now,uint32_t unixTime=0) {
    if(!ready_)return Code::NotReady;
    if(!validRequest(request))return Code::Invalid;
    const uint32_t hash=requestHash(request);
    if(state_.pending.phase!=Phase::None&&state_.pending.request.id==request.id)
      return requestHash(state_.pending.request)==hash?Code::Ok:Code::IdConflict;
    for(size_t i=0;i<state_.seenSize;++i)if(state_.seen[i].id==request.id) {
      if(state_.seen[i].requestHash!=hash)return Code::IdConflict;
      const Result* prior=result(request.id);
      if(prior){last_=*prior;return prior->code;}return Code::ResultExpired;
    }
    if(state_.pending.phase!=Phase::None)return Code::Busy;
    State next=state_;next.pending={};next.pending.request=request;next.pending.phase=Phase::Waiting;
    next.pending.armedAt=now;next.journal={};
    (void)unixTime;
    if(!persist(next))return Code::StorageError;
    return Code::Ok;
  }
  Code cancel(uint32_t now,uint32_t unixTime=0) {
    if(!ready_)return Code::NotReady;
    if(state_.pending.phase==Phase::Uncertain)return Code::Busy;
    if(state_.pending.phase==Phase::None)return Code::Ok;
    return finish(ResultStatus::Cancelled,Code::Cancelled,nullptr,now,unixTime);
  }
  bool tick(uint32_t now,uint32_t unixTime=0) {
    if(state_.pending.phase==Phase::Waiting&&uint32_t(now-state_.pending.armedAt)>=30000u) {
      finish(ResultStatus::Expired,Code::Expired,nullptr,now,unixTime);return true;
    }return false;
  }
  Code scan(CardIO& io,const uint8_t* uid,uint8_t uidSize,uint32_t now,uint32_t unixTime=0) {
    if(!ready_)return Code::NotReady;
    if(!uid||!(uidSize==4||uidSize==7||uidSize==10))return Code::Invalid;
    char uidText[21]={};const char hex[]="0123456789ABCDEF";
    for(uint8_t i=0;i<uidSize;++i){uidText[2*i]=hex[uid[i]>>4];uidText[2*i+1]=hex[uid[i]&15];}
    uint8_t hashInput[11]={uidSize};memcpy(hashInput+1,uid,uidSize);const uint32_t uidHash=crc32(hashInput,uidSize+1);
    if(state_.pending.phase==Phase::Uncertain && strcmp(state_.journal.uid,uidText))return Code::WrongCard;
    Slots slots{};Code readCode=readSlots(io,uidHash,uidText,slots);
    haveCard_=false;
    if(readCode==Code::CardIo){if(state_.pending.phase==Phase::Uncertain)makeUncertain(Code::CardIo,now,unixTime);return readCode;}
    if(state_.pending.phase==Phase::Uncertain)return recover(io,slots,uidHash,uidText,now,unixTime);
    // Expiry is evaluated before accepting a card, including when polling was delayed.
    if(state_.pending.phase==Phase::Waiting&&uint32_t(now-state_.pending.armedAt)>=30000u) {
      finish(ResultStatus::Expired,Code::Expired,nullptr,now,unixTime);
      if(readCode==Code::Ok){card_=slots.records[slots.current];haveCard_=true;}return Code::Expired;
    }
    if(readCode==Code::Ok) {
      card_=slots.records[slots.current];haveCard_=true;
      if(stale(card_,slots.bytes[slots.current]))readCode=Code::StaleCard;
    }
    if(state_.pending.phase==Phase::None)return readCode;
    if(readCode!=Code::Ok&&readCode!=Code::CardBlank)
      return finish(ResultStatus::Declined,readCode,haveCard_?&card_:nullptr,now,unixTime);
    const Request request=state_.pending.request;CardRecord after{};
    if(request.kind==Kind::Issue) {
      if(readCode==Code::Ok)return finish(ResultStatus::Declined,Code::AlreadyIssued,&card_,now,unixTime);
      if(state_.nextCardNo==UINT32_MAX)return finish(ResultStatus::Declined,Code::Limit,nullptr,now,unixTime);
      after.cardNo=state_.nextCardNo;after.balanceCents=0;after.sequence=0;after.uidHash=uidHash;
      memcpy(after.name,request.name,sizeof(after.name));memcpy(after.studentNo,request.studentNo,sizeof(after.studentNo));
    } else {
      if(readCode==Code::CardBlank)return finish(ResultStatus::Declined,Code::CardBlank,nullptr,now,unixTime);
      if(card_.lastTxId==request.id)return finish(ResultStatus::Declined,Code::ResultExpired,&card_,now,unixTime);
      after=card_;
      if(after.sequence==UINT32_MAX)return finish(ResultStatus::Declined,Code::Limit,&card_,now,unixTime);
      if(request.kind==Kind::Spend&&after.balanceCents<request.amountCents)
        return finish(ResultStatus::Declined,Code::Insufficient,&card_,now,unixTime);
      if(request.kind==Kind::Topup&&after.balanceCents>MaxBalance-request.amountCents)
        return finish(ResultStatus::Declined,Code::Limit,&card_,now,unixTime);
      after.balanceCents+=request.kind==Kind::Topup?request.amountCents:-request.amountCents;++after.sequence;
    }
    after.lastTxId=request.id;memcpy(after.uid,uidText,sizeof(after.uid));
    State next=state_;next.pending.phase=Phase::Uncertain;next.journal={};
    Journal& journal=next.journal;memcpy(journal.uid,uidText,sizeof(journal.uid));
    journal.beforeValid=readCode==Code::Ok;journal.beforeSlot=journal.beforeValid?slots.current:0;
    journal.targetSlot=journal.beforeValid?1-slots.current:0;
    if(journal.beforeValid)memcpy(journal.before,slots.bytes[slots.current],RecordBytes);
    memcpy(journal.targetBefore,slots.bytes[journal.targetSlot],RecordBytes);
    encodeRecord(after,journal.after);journal.timestamp=unixTime;journal.uptimeMs=now;
    if(request.kind==Kind::Issue)++next.nextCardNo;
    // The card cannot be modified until this exact after-image is durable.
    if(!persist(next))return Code::StorageError;
    return writeAndCommit(io,after,now,unixTime);
  }
 private:
  struct Slots {uint8_t bytes[2][RecordBytes]{};CardRecord records[2]{};bool valid[2]={},blank[2]={};int current=-1;};
  Store& store_;State state_{};CardRecord card_{};Result last_{};bool ready_=false,haveCard_=false;
  static uint32_t stateChecksum(const State& s) {
    const uint8_t* bytes=reinterpret_cast<const uint8_t*>(&s);uint32_t crc=0xffffffffu;
    for(size_t i=0;i<sizeof(s);++i) {
      crc^=(i>=offsetof(State,checksum)&&i<offsetof(State,checksum)+sizeof(s.checksum))?0:bytes[i];
      for(unsigned bit=0;bit<8;++bit)crc=(crc>>1)^(0xedb88320u&static_cast<uint32_t>(-static_cast<int32_t>(crc&1)));
    }return ~crc;
  }
  static bool validState(const State& s) {
    return s.magic==0x31504d43u&&s.version==1&&s.checksum==stateChecksum(s)&&s.nextCardNo>=10000001&&
      s.logSize<=LogCount&&s.logHead<LogCount&&s.seenSize<=SeenCount&&s.seenHead<SeenCount&&
      s.historySize<=HistoryCount&&s.historyHead<HistoryCount&&uint8_t(s.pending.phase)<=uint8_t(Phase::Uncertain)&&
      (s.pending.phase==Phase::None||validRequest(s.pending.request))&&
      (s.pending.phase!=Phase::Uncertain||(s.journal.targetSlot<2&&s.journal.beforeSlot<2&&s.journal.uid[20]==0));
  }
  bool persist(State& next) {
    next.magic=0x31504d43u;next.version=1;next.checksum=0;next.checksum=stateChecksum(next);
    if(!store_.save(next))return false;
    state_=next;return true;
  }
  static bool validRequest(const Request& r) {
    if(!r.id||!validUtf8(r.scene,sizeof(r.scene)))return false;
    if(r.kind==Kind::Issue)return r.amountCents==0&&validUtf8(r.name,sizeof(r.name),true)&&validUtf8(r.studentNo,sizeof(r.studentNo));
    return (r.kind==Kind::Topup||r.kind==Kind::Spend)&&r.amountCents>0&&r.amountCents<=MaxBalance;
  }
  static uint32_t requestHash(const Request& r) {
    uint8_t bytes[1+4+25+17+25]={};bytes[0]=uint8_t(r.kind);put32(bytes+1,uint32_t(r.amountCents));
    // Hash semantic fields, not caller padding/trailing bytes.
    const bool issue=r.kind==Kind::Issue;
    if(issue){memcpy(bytes+5,r.name,strlen(r.name));memcpy(bytes+30,r.studentNo,strlen(r.studentNo));}
    memcpy(bytes+47,r.scene,strlen(r.scene));return crc32(bytes,sizeof(bytes));
  }
  static Code readSlots(CardIO& io,uint32_t uidHash,const char* uid,Slots& slots) {
    for(unsigned s=0;s<2;++s) {
      slots.blank[s]=true;
      for(unsigned b=0;b<6;++b)if(!io.readBlock(SlotBlocks[s][b],slots.bytes[s]+16*b))return Code::CardIo;
      for(uint8_t value:slots.bytes[s])if(value!=0&&value!=0xff)slots.blank[s]=false;
      slots.valid[s]=decodeRecord(slots.bytes[s],uidHash,slots.records[s]);
      if(slots.valid[s])memcpy(slots.records[s].uid,uid,strlen(uid)+1);
    }
    if(slots.valid[0]&&slots.valid[1]) {
      const CardRecord &a=slots.records[0],&b=slots.records[1];
      if(a.cardNo!=b.cardNo||strcmp(a.name,b.name)||strcmp(a.studentNo,b.studentNo))return Code::CardCorrupt;
      if(a.sequence==b.sequence){if(memcmp(slots.bytes[0],slots.bytes[1],RecordBytes))return Code::CardCorrupt;slots.current=0;}
      else {
        slots.current=a.sequence>b.sequence?0:1;
        uint32_t high=slots.records[slots.current].sequence,low=slots.records[1-slots.current].sequence;
        if(high-low!=1)return Code::CardCorrupt;
      }
    }else if(slots.valid[0]||slots.valid[1])slots.current=slots.valid[0]?0:1;
    else return slots.blank[0]&&slots.blank[1]?Code::CardBlank:Code::CardCorrupt;
    return Code::Ok;
  }
  bool stale(const CardRecord& r,const uint8_t* raw)const {
    for(size_t i=0;i<state_.historySize;++i) {
      const History& h=state_.history[i];
      if(h.uidHash==r.uidHash&&h.cardNo==r.cardNo)
        return r.sequence<h.sequence||(r.sequence==h.sequence&&get32(raw+92)!=h.recordHash);
    }return false;
  }
  Result makeResult(ResultStatus status,Code code,const CardRecord* card,uint32_t now,uint32_t unixTime)const {
    Result r{};const Request& request=state_.pending.request;r.id=request.id;r.requestHash=requestHash(request);
    r.kind=request.kind;r.status=status;r.code=code;r.amountCents=request.amountCents;
    memcpy(r.scene,request.scene,sizeof(r.scene));r.timestamp=unixTime;r.uptimeMs=now;
    if(card){memcpy(r.uid,card->uid,sizeof(r.uid));r.cardNo=card->cardNo;r.balanceCents=card->balanceCents;r.sequence=card->sequence;}
    else if(state_.pending.phase==Phase::Uncertain)memcpy(r.uid,state_.journal.uid,sizeof(r.uid));
    return r;
  }
  void makeUncertain(Code code,uint32_t now,uint32_t unixTime) {last_=makeResult(ResultStatus::Uncertain,code,haveCard_?&card_:nullptr,now,unixTime);}
  static void remember(State& next,const Result& r,const CardRecord* card) {
    next.logs[next.logHead]=r;next.logHead=(next.logHead+1)%LogCount;if(next.logSize<LogCount)++next.logSize;
    next.seen[next.seenHead]={r.id,r.requestHash};next.seenHead=(next.seenHead+1)%SeenCount;if(next.seenSize<SeenCount)++next.seenSize;
    if(r.status==ResultStatus::Success&&card) {
      size_t index=next.historySize;
      for(size_t i=0;i<next.historySize;++i)if(next.history[i].uidHash==card->uidHash&&next.history[i].cardNo==card->cardNo){index=i;break;}
      if(index==next.historySize) {index=next.historyHead;next.historyHead=(next.historyHead+1)%HistoryCount;if(next.historySize<HistoryCount)++next.historySize;}
      uint8_t raw[RecordBytes];encodeRecord(*card,raw);
      History h{};h.lastTxId=card->lastTxId;h.uidHash=card->uidHash;h.cardNo=card->cardNo;
      h.sequence=card->sequence;h.recordHash=get32(raw+92);next.history[index]=h;
    }
  }
  Code finish(ResultStatus status,Code code,const CardRecord* card,uint32_t now,uint32_t unixTime) {
    Result r=makeResult(status,code,card,now,unixTime);State next=state_;remember(next,r,card);
    next.pending={};next.journal={};
    if(!persist(next)){if(state_.pending.phase==Phase::Uncertain)makeUncertain(Code::StorageError,now,unixTime);return Code::StorageError;}
    last_=r;return code;
  }
  Code writeAndCommit(CardIO& io,const CardRecord& after,uint32_t now,uint32_t unixTime) {
    const Journal& j=state_.journal;
    for(unsigned b=0;b<6;++b)if(!io.writeBlock(SlotBlocks[j.targetSlot][b],j.after+b*16)) {
      makeUncertain(Code::Uncertain,now,unixTime);return Code::Uncertain;
    }
    uint8_t verify[RecordBytes];
    for(unsigned b=0;b<6;++b)if(!io.readBlock(SlotBlocks[j.targetSlot][b],verify+b*16)) {
      makeUncertain(Code::Uncertain,now,unixTime);return Code::Uncertain;
    }
    if(memcmp(verify,j.after,RecordBytes)){makeUncertain(Code::Uncertain,now,unixTime);return Code::Uncertain;}
    card_=after;haveCard_=true;
    return finish(ResultStatus::Success,Code::Ok,&card_,j.uptimeMs,j.timestamp);
  }
  Code recover(CardIO& io,const Slots& slots,uint32_t uidHash,const char* uid,uint32_t now,uint32_t unixTime) {
    const Journal& j=state_.journal;CardRecord after{};
    if(!decodeRecord(j.after,uidHash,after)){makeUncertain(Code::CardChanged,now,unixTime);return Code::CardChanged;}
    memcpy(after.uid,uid,strlen(uid)+1);
    if(!memcmp(slots.bytes[j.targetSlot],j.after,RecordBytes)) {
      card_=after;haveCard_=true;
      return finish(ResultStatus::Success,Code::Ok,&card_,j.uptimeMs,j.timestamp);
    }
    bool beforeIntact=j.beforeValid?!memcmp(slots.bytes[j.beforeSlot],j.before,RecordBytes):slots.blank[1-j.targetSlot];
    // A different valid target is a concurrent edit, never an incomplete write.
    const bool untouchedTarget=!memcmp(slots.bytes[j.targetSlot],j.targetBefore,RecordBytes);
    if(!beforeIntact||(slots.valid[j.targetSlot]&&!untouchedTarget)){makeUncertain(Code::CardChanged,now,unixTime);return Code::CardChanged;}
    return writeAndCommit(io,after,now,unixTime);
  }
};
} // namespace campus

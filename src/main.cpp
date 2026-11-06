#include <Arduino.h>
#include <SPI.h>
#include <MFRC522.h>
#include <ArduinoJson.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#if defined(CONFIG_BLUEDROID_ENABLED)
#include <BLE2902.h>
#endif
#include <Preferences.h>
#include <sys/time.h>
#include <atomic>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "campus_core.h"
#include "rfid_io.h"
#include "oled_ui.h"
#include "ble_frames.h"
#include "ble_outbox.h"
#include "usb_lines.h"
#include "log_snapshot.h"
#include "power_policy.h"
#include "rfid_timing.h"

// NVS commits intentionally work on complete ledger snapshots before publishing
// them. Leave room for nested transaction/recovery frames on the Arduino task.
SET_LOOP_TASK_STACK_SIZE(32768);

namespace {
constexpr char ServiceUuid[]="c4a10001-6d6a-4b2e-ae8b-3d80b18a5100";
constexpr char WriteUuid[]="c4a10002-6d6a-4b2e-ae8b-3d80b18a5100";
constexpr char NotifyUuid[]="c4a10003-6d6a-4b2e-ae8b-3d80b18a5100";
MFRC522 reader(RFID_SS,RFID_RST);
NvsStore store;
campus::Engine engine(store);
campusui::OledUi oled;
Preferences uiStore;
BLECharacteristic* notifyCharacteristic=nullptr;
QueueHandle_t receiveQueue=nullptr;
std::atomic<bool> connected{false};
std::atomic<uint32_t> connectionEpoch{0};
std::atomic<bool> receiveOverflow{false};
std::atomic<bool> notificationAccepted{false};
struct Incoming {uint32_t epoch;uint8_t size;uint8_t bytes[20];};
campusble::Outbox<String> outgoing,usbOutgoing;
campusble::Receiver receiver;
campususb::Lines usbLines;
campususb::Connection usbConnection;
campuslog::Snapshot logSnapshots[2];
campuspower::Policy power;
enum class Channel:uint8_t{Ble,Usb};
Channel requestChannel=Channel::Ble;
uint32_t requestEpoch=0;
uint32_t activeBleEpoch=0;
char deviceName[28];
char deviceId[17];
bool readerReady=false,uiStoreReady=false,usbSession=false;
String latchedUid;
uint32_t lastPresence=0,cardPollAt=0,notifyAt=0;
uint32_t lastCardMs=0,maxCardMs=0,maxLoopMs=0;

uint32_t unixTime() {const time_t value=time(nullptr);return value>=1704067200 && value<=4102444800LL?static_cast<uint32_t>(value):0;}
String hexId(uint64_t id) {char bytes[17];snprintf(bytes,sizeof(bytes),"%016llx",static_cast<unsigned long long>(id));return String(bytes);}
bool parseId(const char* value,uint64_t& id) {
  if (!value || strlen(value)!=16) return false;
  id=0;
  for (size_t i=0;i<16;++i) {
    char c=value[i];uint8_t digit;
    if(c>='0'&&c<='9')digit=c-'0';else if(c>='a'&&c<='f')digit=c-'a'+10;
    else if(c>='A'&&c<='F')digit=c-'A'+10;else return false;
    id=(id<<4)|digit;
  }
  return id!=0;
}
bool ok(campus::Code code) {return strcmp(campus::codeName(code),"OK")==0;}
const char* effectName() {return oled.settings.effect==0?"static":oled.settings.effect==1?"slide":"type";}
bool hasPending() {return engine.state().pending.phase!=campus::Phase::None;}
void activity(){power.activity(millis());oled.setSleeping(false);}

void writeResult(JsonObject object,const campus::Result& result) {
  object["id"]=hexId(result.id);object["kind"]=campus::kindName(result.kind);
  object["status"]=campus::statusName(result.status);object["code"]=campus::codeName(result.code);
  object["message"]=campus::message(result.code);object["uid"]=result.uid;
  object["cardNo"]=result.cardNo;object["amountCents"]=result.amountCents;
  object["balanceCents"]=result.balanceCents;object["sequence"]=result.sequence;
  object["scene"]=result.scene;object["timestamp"]=result.timestamp;object["uptimeMs"]=result.uptimeMs;
}
void writeState(JsonDocument& document) {
  auto dev=document["device"].to<JsonObject>();dev["name"]=deviceName;dev["id"]=deviceId;
  dev["oledReady"]=oled.ready;dev["readerReady"]=readerReady;dev["storageReady"]=engine.ready();
  dev["usbReady"]=usbSession;
  auto capabilities=dev["capabilities"].to<JsonObject>();capabilities["power"]=true;capabilities["logPagination"]=true;capabilities["diagnostics"]=true;
  auto settings=document["settings"].to<JsonObject>();settings["fontSize"]=oled.settings.fontSize;
  settings["effect"]=effectName();settings["holdMs"]=oled.settings.holdMs;
  auto energy=document["power"].to<JsonObject>();energy["batteryMode"]=power.config.batteryMode;
  energy["brightness"]=power.config.brightness;energy["idleSeconds"]=power.config.idleSeconds;
  energy["screenAwake"]=power.awake;energy["batteryMeasurement"]=false;energy["batteryVoltage"]=nullptr;
  if(const auto* card=engine.card()) {
    auto object=document["card"].to<JsonObject>();object["uid"]=card->uid;object["cardNo"]=card->cardNo;
    object["name"]=card->name;object["studentNo"]=card->studentNo;
    object["balanceCents"]=card->balanceCents;object["sequence"]=card->sequence;
  } else document["card"]=nullptr;
  if(hasPending()) {
    const auto& pending=engine.state().pending.request;
    auto object=document["pending"].to<JsonObject>();object["id"]=hexId(pending.id);
    object["kind"]=campus::kindName(pending.kind);object["amountCents"]=pending.amountCents;
    object["scene"]=pending.scene;object["phase"]=campus::phaseName(engine.state().pending.phase);
  } else document["pending"]=nullptr;
  if(const auto* result=engine.lastResult())writeResult(document["lastResult"].to<JsonObject>(),*result);
  else document["lastResult"]=nullptr;
}
void enqueueTo(Channel channel,uint16_t id,const JsonDocument& document) {
  if(channel==Channel::Ble&&!connected.load())return;
  if(id&&channel==Channel::Ble&&requestEpoch!=connectionEpoch.load())return;
  if(channel==Channel::Usb&&!usbSession)return;
  auto& queue=channel==Channel::Ble?outgoing:usbOutgoing;
  if(!id&&queue.size()>=queue.Capacity){queue.deferEvent();return;}
  String body;body.reserve(measureJson(document)+1);serializeJson(document,body);
  if(body.length()>campusble::MaxResponse)body="{\"ok\":false,\"code\":\"RESPONSE_TOO_LARGE\",\"message\":\"响应过长，请分页查询\"}";
  if(channel==Channel::Usb) {
    String envelope;envelope.reserve(body.length()+32);envelope="{\"id\":";envelope+=id;envelope+=",\"body\":";envelope+=body;envelope+="}\n";
    queue.push(id,std::move(envelope));
  }else queue.push(id,std::move(body));
}
void enqueue(uint16_t id,const JsonDocument& document) {
  if(id){enqueueTo(requestChannel,id,document);return;}
  enqueueTo(Channel::Ble,0,document);enqueueTo(Channel::Usb,0,document);
}
void event(const char* name) {
  JsonDocument document;document["ok"]=true;document["event"]=name;writeState(document);enqueue(0,document);
}
void response(uint16_t id,const char* op,campus::Code code) {
  JsonDocument document;document["op"]=op;document["ok"]=ok(code);
  document["code"]=campus::codeName(code);document["message"]=campus::message(code);
  writeState(document);enqueue(id,document);
}
void errorResponse(uint16_t id,const char* op,const char* code,const char* message) {
  JsonDocument document;document["op"]=op;document["ok"]=false;
  document["code"]=code;document["message"]=message;writeState(document);enqueue(id,document);
}
void showPending() {
  if(!hasPending()){oled.idle(connected.load());return;}
  const auto& pending=engine.state().pending.request;
  if(engine.state().pending.phase==campus::Phase::Uncertain)oled.error("交易待核对","请重新刷原卡 / 勿重复下单");
  else oled.waiting(campus::kindName(pending.kind),pending.amountCents);
}
void showResult(const campus::Result& result) {
  const char* status=campus::statusName(result.status);
  if(!strcmp(status,"uncertain")){oled.error("交易待核对","请重新刷原卡");return;}
  if(strcmp(status,"success")){oled.error(campus::message(result.code));return;}
  const char* kind=campus::kindName(result.kind);
  oled.result(!strcmp(kind,"issue")?"开卡成功":!strcmp(kind,"topup")?"充值成功":"消费成功",result.amountCents,result.balanceCents,true);
}
bool copyText(JsonVariantConst value,char* output,size_t capacity,bool required=false) {
  if(!value.is<const char*>())return !required && value.isNull();
  const char* text=value.as<const char*>();const size_t size=strlen(text);
  if(size!=value.as<JsonString>().size()||size>=capacity || (required && !size))return false;
  memcpy(output,text,size+1);return true;
}
void handleRequest(uint16_t id,const char* text,size_t size) {
  JsonDocument input;
  if(deserializeJson(input,text,size) || !input.is<JsonObject>()) {
    errorResponse(id,"","BAD_JSON","请求内容无效");return;
  }
  const char* op=input["op"]|"";
  if(!strcmp(op,"state")) {
    if(input["unixTime"].is<uint32_t>()) {
      const uint32_t time=input["unixTime"];
      if(time>=1704067200 && time<=4102444800UL){timeval tv{static_cast<time_t>(time),0};settimeofday(&tv,nullptr);}
    }
    JsonDocument document;document["ok"]=true;document["op"]=op;writeState(document);enqueue(id,document);return;
  }
  if(!strcmp(op,"diagnostics")) {
    JsonDocument document;document["ok"]=true;document["op"]=op;writeState(document);
    auto stats=document["diagnostics"].to<JsonObject>();stats["uptimeMs"]=millis();stats["freeHeapBytes"]=ESP.getFreeHeap();
    stats["minFreeHeapBytes"]=ESP.getMinFreeHeap();stats["psramBytes"]=ESP.getPsramSize();stats["flashBytes"]=ESP.getFlashChipSize();
    stats["maxLoopMs"]=maxLoopMs;stats["lastCardMs"]=lastCardMs;stats["maxCardMs"]=maxCardMs;
    stats["bleConnected"]=connected.load();stats["usbConnected"]=usbSession;stats["bleQueue"]=outgoing.size();stats["usbQueue"]=usbOutgoing.size();
    enqueue(id,document);return;
  }
  if(!strcmp(op,"logs")) {
    const bool hasOffset=input["offset"].is<int>(),hasLimit=input["limit"].is<int>();
    if((!input["offset"].isNull()&&!hasOffset)||(!input["limit"].isNull()&&!hasLimit)) {errorResponse(id,op,"BAD_LOG_PAGE","流水分页参数无效");return;}
    const int offset=hasOffset?input["offset"].as<int>():0,limit=hasLimit?input["limit"].as<int>():5;
    if(offset<0||offset>20||limit<1||limit>5){errorResponse(id,op,"BAD_LOG_PAGE","每次读取1至5条流水");return;}
    auto& snapshot=logSnapshots[requestChannel==Channel::Ble?0:1];
    if(!offset)snapshot.capture(engine);
    else {
      const char* revision=input["revision"]|"";uint32_t value=0;bool valid=strlen(revision)==8;
      for(size_t i=0;valid&&i<8;++i){const char c=revision[i];if(c>='0'&&c<='9')value=value*16+c-'0';else if(c>='a'&&c<='f')value=value*16+c-'a'+10;else if(c>='A'&&c<='F')value=value*16+c-'A'+10;else valid=false;}
      if(!valid||!snapshot.matches(value,offset)){errorResponse(id,op,"LOG_SNAPSHOT_EXPIRED","流水已变化，请重新刷新");return;}
    }
    JsonDocument document;document["ok"]=true;document["op"]=op;
    auto logs=document["logs"].to<JsonArray>();
    const size_t end=min(snapshot.count,static_cast<size_t>(offset+limit));
    for(size_t i=offset;i<end;++i)writeResult(logs.add<JsonObject>(),snapshot.records[i]);
    char revision[9];snprintf(revision,sizeof(revision),"%08lx",static_cast<unsigned long>(snapshot.revision));
    document["revision"]=revision;document["total"]=snapshot.count;
    if(end<snapshot.count)document["nextOffset"]=end;else document["nextOffset"]=nullptr;
    enqueue(id,document);return;
  }
  if(!strcmp(op,"power")) {
    if(!input["batteryMode"].is<bool>()||!input["brightness"].is<int>()||!input["idleSeconds"].is<int>()) {errorResponse(id,op,"BAD_POWER","电源设置无效");return;}
    const int brightness=input["brightness"],idle=input["idleSeconds"];
    if(brightness<1||brightness>255||idle<0||idle>3600||(idle>0&&idle<10)){errorResponse(id,op,"BAD_POWER","亮度1至255，熄屏时间为0或10至3600秒");return;}
    campuspower::Config candidate;candidate.brightness=brightness;candidate.idleSeconds=idle;candidate.batteryMode=input["batteryMode"];
    if(!campuspower::same(candidate,power.config)&&(!uiStoreReady||uiStore.putBytes("power",&candidate,sizeof(candidate))!=sizeof(candidate))) {errorResponse(id,op,"STORAGE_ERROR","电源设置保存失败");return;}
    power.config=candidate;activity();oled.setContrast(candidate.brightness);
    JsonDocument document;document["ok"]=true;document["op"]=op;writeState(document);enqueue(id,document);event("status");return;
  }
  if(!strcmp(op,"wake")) {
    activity();JsonDocument document;document["ok"]=true;document["op"]=op;writeState(document);enqueue(id,document);event("status");return;
  }
  if(!strcmp(op,"result")) {
    uint64_t businessId;
    if(!parseId(input["id"]|"",businessId)){errorResponse(id,op,"BAD_ID","业务编号无效");return;}
    JsonDocument document;document["ok"]=true;document["op"]=op;writeState(document);
    const auto* result=engine.result(businessId);
    if(result)writeResult(document["result"].to<JsonObject>(),*result);else document["result"]=nullptr;
    enqueue(id,document);return;
  }
  if(!strcmp(op,"settings")) {
    const char* effect=input["effect"]|"";
    if(!input["fontSize"].is<int>() || !input["holdMs"].is<int>()) {errorResponse(id,op,"BAD_SETTINGS","显示设置无效");return;}
    int font=input["fontSize"],hold=input["holdMs"];
    uint8_t effectId=!strcmp(effect,"static")?0:!strcmp(effect,"slide")?1:!strcmp(effect,"type")?2:255;
    if((font!=12&&font!=16&&font!=24&&font!=32)||hold<1500||hold>10000||effectId==255){errorResponse(id,op,"BAD_SETTINGS","显示设置超出范围");return;}
    campusui::Settings settings;settings.fontSize=font;settings.effect=effectId;settings.holdMs=hold;
    const bool changed=settings.fontSize!=oled.settings.fontSize||settings.effect!=oled.settings.effect||settings.holdMs!=oled.settings.holdMs;
    if(changed&&(!uiStoreReady||uiStore.putBytes("display",&settings,sizeof(settings))!=sizeof(settings))) {errorResponse(id,op,"STORAGE_ERROR","显示设置保存失败");return;}
    activity();oled.settings=settings;oled.refresh();
    JsonDocument document;document["ok"]=true;document["op"]=op;writeState(document);enqueue(id,document);event("status");return;
  }
  if(!strcmp(op,"cancel")) {
    auto code=engine.cancel(millis(),unixTime());
    // CANCELLED describes the business result; the cancel RPC itself succeeded.
    if(code==campus::Code::Cancelled)code=campus::Code::Ok;
    if(ok(code)){activity();showPending();}
    response(id,op,code);if(ok(code))event("pending");return;
  }
  if(!strcmp(op,"arm")) {
    if(!readerReady){errorResponse(id,op,"READER_UNAVAILABLE","未检测到RC522，请检查接线");return;}
    campus::Request request{};
    if(!parseId(input["id"]|"",request.id)){errorResponse(id,op,"BAD_ID","业务编号无效");return;}
    const char* kind=input["kind"]|"";
    if(!strcmp(kind,"issue"))request.kind=campus::Kind::Issue;
    else if(!strcmp(kind,"topup"))request.kind=campus::Kind::Topup;
    else if(!strcmp(kind,"spend"))request.kind=campus::Kind::Spend;
    else {errorResponse(id,op,"BAD_KIND","交易类型无效");return;}
    if(request.kind!=campus::Kind::Issue && (!input["amountCents"].is<int32_t>() || input["amountCents"].as<int32_t>()<=0)) {
      errorResponse(id,op,"BAD_AMOUNT","金额必须为正整数分");return;
    }
    request.amountCents=request.kind==campus::Kind::Issue?0:input["amountCents"].as<int32_t>();
    if(!copyText(input["name"],request.name,sizeof(request.name),request.kind==campus::Kind::Issue)||
       !copyText(input["studentNo"],request.studentNo,sizeof(request.studentNo))||
       !copyText(input["scene"],request.scene,sizeof(request.scene))) {
      errorResponse(id,op,"BAD_TEXT","姓名最多24字节，学号最多16字节，场景最多24字节");return;
    }
    if(!request.scene[0])strcpy(request.scene,request.kind==campus::Kind::Issue?"开卡":request.kind==campus::Kind::Topup?"充值":"食堂");
    auto code=engine.arm(request,millis(),unixTime());
    if(ok(code)){activity();showPending();}
    response(id,op,code);if(ok(code))event("pending");return;
  }
  errorResponse(id,op,"UNKNOWN_OPERATION","不支持此操作");
}
class ServerCallbacks final : public BLEServerCallbacks {
  void onConnect(BLEServer*) override {connected.store(true);}
  void onDisconnect(BLEServer*) override {connected.store(false);connectionEpoch.fetch_add(1);}
};
class WriteCallbacks final : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    const String value=characteristic->getValue();
    if(value.length()>20)return;
    Incoming packet{};packet.epoch=connectionEpoch.load();packet.size=value.length();
    memcpy(packet.bytes,value.c_str(),packet.size);
    if(xQueueSend(receiveQueue,&packet,0)!=pdTRUE)receiveOverflow.store(true);
  }
};
class NotifyCallbacks final : public BLECharacteristicCallbacks {
  void onStatus(BLECharacteristic*,Status status,uint32_t) override {
    // This callback reports whether the stack accepted notify(), not whether the
    // phone applied a business result. Transactions remain queryable separately.
    notificationAccepted.store(status==Status::SUCCESS_NOTIFY);
  }
};
void startBle() {
  snprintf(deviceName,sizeof(deviceName),"S3-CAMPUS-%04X",static_cast<unsigned>((ESP.getEfuseMac()>>32)&0xFFFF));
  if(!BLEDevice::init(deviceName)){Serial.println("BLE initialization failed");return;}
  auto* server=BLEDevice::createServer();server->setCallbacks(new ServerCallbacks());server->advertiseOnDisconnect(true);
  auto* service=server->createService(ServiceUuid);
  auto* write=service->createCharacteristic(WriteUuid,BLECharacteristic::PROPERTY_WRITE);write->setCallbacks(new WriteCallbacks());
  notifyCharacteristic=service->createCharacteristic(NotifyUuid,BLECharacteristic::PROPERTY_NOTIFY);
  notifyCharacteristic->setCallbacks(new NotifyCallbacks());
#if defined(CONFIG_BLUEDROID_ENABLED)
  notifyCharacteristic->addDescriptor(new BLE2902());
#endif
  service->start();
  BLEAdvertisementData advertisement,scanResponse;advertisement.setFlags(0x06);advertisement.setCompleteServices(BLEUUID(ServiceUuid));scanResponse.setName(deviceName);
  auto* advertising=BLEDevice::getAdvertising();advertising->setAdvertisementData(advertisement);advertising->setScanResponseData(scanResponse);advertising->start();
  Serial.printf("BLE ready: %s\n",deviceName);
}
void syncBleSession() {
  const uint32_t observed=connectionEpoch.load();
  if(activeBleEpoch==observed)return;
  activeBleEpoch=observed;receiver.reset();outgoing.clear();logSnapshots[0].clear();
}
void transmit(uint32_t now) {
  syncBleSession();
  if(!connected.load()||!notifyCharacteristic)return;
  if(outgoing.empty()) {if(outgoing.takeDeferred())event("status");return;}
  if(now-notifyAt<20)return;
  notifyAt=now;
  auto& message=outgoing.front();uint8_t frame[20];
  size_t length=campusble::makeFrame(frame,message.id,message.body.c_str(),message.body.length(),message.offset);
  if(!length){outgoing.pop();return;}
  notificationAccepted.store(false);
  notifyCharacteristic->setValue(frame,length);
  if(activeBleEpoch!=connectionEpoch.load())return;
  notifyCharacteristic->notify();
  if(!notificationAccepted.load()) {
    if(++message.failures>=50){outgoing.pop();outgoing.deferEvent();if(usbOutgoing.empty()||!usbOutgoing.front().offset)Serial.println("# BLE notification failed repeatedly; query original operation after reconnect.");}
    return;
  }
  message.failures=0;
  message.offset+=length-campusble::Header;
  if(message.offset>=message.body.length())outgoing.pop();
}
void transmitUsb() {
  if(!usbSession||!static_cast<bool>(Serial))return;
  if(usbOutgoing.empty()){if(usbOutgoing.takeDeferred())event("status");return;}
  auto& message=usbOutgoing.front();
  const int available=Serial.availableForWrite();if(available<=0)return;
  const size_t remaining=message.body.length()-message.offset;
  const size_t count=min(remaining,min(static_cast<size_t>(available),static_cast<size_t>(256)));
  message.offset+=Serial.write(reinterpret_cast<const uint8_t*>(message.body.c_str()+message.offset),count);
  if(message.offset>=message.body.length())usbOutgoing.pop();
}
void receiveUsb() {
  const bool ready=static_cast<bool>(Serial);
  const bool session=usbConnection.update(ready,millis());
  if(session!=usbSession) {
    usbSession=session;usbLines.reset();usbOutgoing.clear();logSnapshots[1].clear();
    // Quarantine bytes left by a previously closed serial session.
    if(!session){while(Serial.available())Serial.read();return;}
  }
  if(!ready||usbOutgoing.size()>=usbOutgoing.Capacity)return;
  for(unsigned i=0;i<128&&Serial.available();++i) {
    const auto line=usbLines.accept(static_cast<char>(Serial.read()));
    if(line==campususb::LineResult::Overflow){requestChannel=Channel::Usb;errorResponse(1,"","BAD_FRAME","串口请求过长，请重新连接核对原订单");continue;}
    if(line!=campususb::LineResult::Complete)continue;
    requestChannel=Channel::Usb;
    if(usbLines.size) {
      JsonDocument envelope;
      if(deserializeJson(envelope,usbLines.body,usbLines.size)||!envelope["id"].is<uint16_t>()||envelope["id"].as<uint16_t>()==0||!envelope["body"].is<JsonObject>())errorResponse(1,"","BAD_FRAME","串口请求格式无效");
      else {
        const uint16_t id=envelope["id"];
        String body;body.reserve(measureJson(envelope["body"])+1);serializeJson(envelope["body"],body);
        if(body.length()>campusble::MaxRequest)errorResponse(id,"","BAD_FRAME","串口请求正文过长");
        else handleRequest(id,body.c_str(),body.length());
      }
    }
    usbLines.reset();return;
  }
}
void haltCard(){campusio::ShortFrameTimeout<MFRC522> timeout(reader);reader.PICC_HaltA();reader.PCD_StopCrypto1();}
void pollCard(uint32_t now) {
  if(!readerReady||now-cardPollAt<power.pollInterval(hasPending()))return;
  cardPollAt=now;
  uint8_t answer[2],length=sizeof(answer);
  MFRC522::StatusCode status;
  {campusio::ShortFrameTimeout<MFRC522> timeout(reader);status=reader.PICC_WakeupA(answer,&length);}
  if(status!=MFRC522::STATUS_OK || !reader.PICC_ReadCardSerial()) {
    if(now-lastPresence>600)latchedUid="";
    return;
  }
  String uid;for(uint8_t i=0;i<reader.uid.size;++i){char hex[3];snprintf(hex,sizeof(hex),"%02X",reader.uid.uidByte[i]);uid+=hex;}
  lastPresence=now;
  if(uid==latchedUid){haltCard();return;}
  latchedUid=uid;
  activity();
  const auto type=reader.PICC_GetType(reader.uid.sak);
  if(type!=MFRC522::PICC_TYPE_MIFARE_1K && type!=MFRC522::PICC_TYPE_MIFARE_4K) {
    oled.error("卡片类型不支持","请使用Classic 1K/4K测试卡");
    JsonDocument document;document["ok"]=false;document["event"]="card";
    document["code"]="CARD_UNSUPPORTED";document["message"]="请使用MIFARE Classic 1K/4K测试卡";
    writeState(document);document["card"]=nullptr;enqueue(0,document);
    haltCard();return;
  }
  const auto* previous=engine.lastResult();
  uint64_t previousId=previous?previous->id:0;
  String previousStatus=previous?campus::statusName(previous->status):"";
  RfidIO io(reader);
  const uint32_t cardStarted=millis();
  const auto code=engine.scan(io,reader.uid.uidByte,reader.uid.size,now,unixTime());
  lastCardMs=millis()-cardStarted;maxCardMs=max(maxCardMs,lastCardMs);
  haltCard();
  const auto* result=engine.lastResult();
  if(result && (result->id!=previousId || previousStatus!=campus::statusName(result->status))) {
    showResult(*result);event("transaction");
  } else if(ok(code) && engine.card()) {
    const auto* card=engine.card();oled.card(card->name,card->cardNo,card->balanceCents);event("card");
  } else {
    oled.error(campus::message(code));
    JsonDocument document;document["ok"]=false;document["event"]="card";
    document["code"]=campus::codeName(code);document["message"]=campus::message(code);writeState(document);enqueue(0,document);
  }
}
}

void setup() {
  Serial.setRxBufferSize(2048);Serial.setTxTimeoutMs(0);
  Serial.begin(115200);
  oled.begin();
  uiStoreReady=uiStore.begin("campus-screen",false);
  if(uiStoreReady && uiStore.getBytesLength("display")==sizeof(campusui::Settings)) {
    campusui::Settings settings;
    if(uiStore.getBytes("display",&settings,sizeof(settings))==sizeof(settings) &&
       (settings.fontSize==12||settings.fontSize==16||settings.fontSize==24||settings.fontSize==32)&&settings.effect<=2&&settings.holdMs>=1500&&settings.holdMs<=10000)oled.settings=settings;
  }
  if(uiStoreReady&&uiStore.getBytesLength("power")==sizeof(campuspower::Config)) {
    campuspower::Config config;if(uiStore.getBytes("power",&config,sizeof(config))==sizeof(config)&&campuspower::valid(config))power.config=config;
  }
  power.activity(millis());oled.setContrast(power.config.brightness);
  if(!store.open()||!engine.begin(millis()))oled.error("本地存储不可用","交易已禁用 / 检查串口");
  SPI.begin(RFID_SCK,RFID_MISO,RFID_MOSI,RFID_SS);reader.PCD_Init();
  uint8_t version=reader.PCD_ReadRegister(MFRC522::VersionReg);readerReady=version!=0&&version!=0xFF;
  Serial.printf("OLED=%d SDA=%d SCL=%d; RC522=%d version=0x%02X SS=%d SCK=%d MOSI=%d MISO=%d RST=%d; storage=%d stateBytes=%u\n",
    oled.ready,OLED_SDA,OLED_SCL,readerReady,version,RFID_SS,RFID_SCK,RFID_MOSI,RFID_MISO,RFID_RST,engine.ready(),static_cast<unsigned>(sizeof(campus::State)));
  receiveQueue=xQueueCreate(32,sizeof(Incoming));
  if(!receiveQueue){oled.error("内存不足","请重启设备");return;}
  snprintf(deviceId,sizeof(deviceId),"%012llx",static_cast<unsigned long long>(ESP.getEfuseMac()));
  logSnapshots[0].revision=esp_random();logSnapshots[1].revision=esp_random();
  startBle();
  if(engine.ready())showPending();
  if(!readerReady)oled.error("未检测到RC522","请按README检查SPI接线");
}
void loop() {
  static bool wasConnected=false;
  const uint32_t now=millis();
  syncBleSession();
  if(wasConnected!=connected.load()){wasConnected=connected.load();if(!hasPending())oled.idle(wasConnected);}
  if(receiveQueue && connected.load() && outgoing.size()<3) {
    Incoming packet;
    if(xQueueReceive(receiveQueue,&packet,0)==pdTRUE && packet.epoch==activeBleEpoch) {
      requestChannel=Channel::Ble;
      requestEpoch=packet.epoch;
      auto accepted=receiver.accept(packet.bytes,packet.size,now);
      if(accepted==campusble::Accepted::Complete) {handleRequest(receiver.id,receiver.body,receiver.total);receiver.reset();}
      else if(accepted==campusble::Accepted::Invalid) {
        uint16_t id=packet.size>=4?packet.bytes[2]|packet.bytes[3]<<8:1;
        errorResponse(id,"","BAD_FRAME","分包顺序或长度无效，请重新查询状态");
      }
    }
  }
  receiveUsb();
  if(receiveOverflow.exchange(false)){receiver.reset();event("status");}
  // arm() timestamps the task during request handling. Use a fresh time so a
  // task created later than the loop's initial timestamp cannot appear expired.
  const uint32_t businessNow=millis();
  if(engine.tick(businessNow,unixTime())){showPending();event("pending");}
  pollCard(businessNow);transmit(millis());transmitUsb();
  // Card I/O may take time; changed() timestamps must never be compared against
  // the earlier loop timestamp (unsigned subtraction would end the result early).
  const uint32_t uiNow=millis();
  if(oled.finished(uiNow))showPending();
  if(power.tick(uiNow,hasPending())){oled.setSleeping(!power.awake);event("status");}
  oled.tick(uiNow,power.config.batteryMode);maxLoopMs=max(maxLoopMs,uint32_t(millis()-now));delay(2);
}

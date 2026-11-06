#pragma once
#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>
#include <string.h>

namespace campusui {
struct Settings {
  uint8_t fontSize = 16;
  uint8_t effect = 1; // 0=static, 1=slide, 2=type.
  uint16_t holdMs = 3000;
};
class OledUi {
 public:
  Settings settings;
  bool ready = false;
  bool begin() {
    Wire.begin(OLED_SDA, OLED_SCL);
    Wire.setTimeOut(50);
    for (uint8_t address : {0x3C, 0x3D}) {
      Wire.beginTransmission(address);
      if (Wire.endTransmission()) continue;
      display_.setI2CAddress(address << 1);
      display_.setBusClock(400000);
      display_.begin();
      display_.enableUTF8Print();
      if (contrast_ >= 0) display_.setContrast(static_cast<uint8_t>(contrast_));
      if (sleeping_) display_.setPowerSave(1);
      ready = true; idle(false); return true;
    }
    return false;
  }
  void idle(bool connected) {
    screen_ = Idle; title_ = "模拟校园一卡通";
    detail_ = connected ? "已连接 / 刷卡查余额" : "请用微信小程序连接";
    changed();
  }
  void waiting(const char* kind, int32_t cents) {
    screen_ = Waiting;
    title_ = !strcmp(kind,"issue") ? "请刷空白测试卡" : !strcmp(kind,"topup") ? "请刷卡充值" : "请刷卡消费";
    amount_ = money(cents); detail_ = "模拟余额 / 30秒内刷卡"; changed();
  }
  void card(const char* name, uint32_t number, int32_t cents) {
    screen_ = Card; title_ = String(name) + " / 余额"; amount_ = money(cents);
    char text[32]; snprintf(text,sizeof(text),"卡号 %08lu",static_cast<unsigned long>(number));
    detail_ = text; changed();
  }
  void result(const char* title, int32_t amount, int32_t balance, bool success) {
    screen_ = success ? Success : Error; title_ = title; amount_ = money(balance);
    detail_ = String("本次 ") + money(amount) + " / 模拟余额"; changed();
  }
  void error(const char* title, const char* detail = "请移开卡片后重试") {
    screen_ = Error; title_ = title; detail_ = detail; amount_ = ""; changed();
  }
  void refresh() { changed(); }
  void setContrast(uint8_t contrast) {
    if (contrast_ == contrast) return;
    contrast_ = contrast;
    if (ready) display_.setContrast(contrast);
  }
  void setSleeping(bool sleeping) {
    if (sleeping_ == sleeping) return;
    sleeping_ = sleeping;
    if (ready) display_.setPowerSave(sleeping ? 1 : 0);
    if (!sleeping) {
      // Refresh the first visible frame even if the cached pixels are identical.
      haveKey_=false;haveFrame_=false;frameAt_=millis()-65;
    }
  }
  bool sleeping() const { return sleeping_; }
  bool finished(uint32_t now) const {
    return screen_ != Idle && screen_ != Waiting && now - at_ > static_cast<uint32_t>(settings.holdMs) + 900;
  }
  void tick(uint32_t now,bool reducedMotion=false) {
    if (!ready || sleeping_) return;
    if (metricsDirty_ || measuredFontSize_ != settings.fontSize) measureText();
    const uint32_t elapsed = now - at_;
    const bool intro = (screen_ == Success || screen_ == Error) && settings.effect != 0;
    const bool inIntro = intro && elapsed < 650;
    // Only result/error screens have an introduction. Card pages and static
    // results must not restart their slide/type animation at 650 milliseconds.
    const uint32_t contentTime = intro && elapsed >= 650 ? elapsed - 650 : elapsed;
    FrameKey key{};
    key.screen = static_cast<uint8_t>(screen_);key.effect = settings.effect;key.fontSize = settings.fontSize;
    key.intro = inIntro;
    key.decorations = (screen_==Idle || screen_==Waiting) && settings.effect!=0 && !reducedMotion;
    if (screen_ == Idle && key.decorations) key.animation = (now / 180) % 13;
    else if (screen_ == Waiting && key.decorations) key.animation = (now / 30) % 144;
    else if (inIntro) key.animation = screen_ == Success ? (elapsed / 35) % 12 : (elapsed / 60) % 3;
    if (!inIntro && screen_ != Idle && screen_ != Waiting && settings.effect == 1 && contentTime < 350)
      key.slide = (350-contentTime)*64/350;
    if (!inIntro && screen_ != Idle && amount_.length()) {
      key.typed = settings.effect == 2 ? typedLength(screen_ == Waiting ? elapsed : contentTime) : amount_.length();
    }
    if (settings.effect == 1) {
      if (titleWidth_ > 128) key.titleScroll = (elapsed/40) % (titleWidth_+24);
      if (!inIntro && detailWidth_ > 128) key.detailScroll = (elapsed/40) % (detailWidth_+24);
    }
    // Polling a cheap phase key avoids both rendering and I2C transfers while a
    // static page or a completed type/slide animation has no changed pixels.
    if (haveKey_ && key == lastKey_) return;
    if (now - frameAt_ < 65) return;
    frameAt_ = now;
    display_.clearBuffer();
    display_.setClipWindow(0,0,128,64);
    display_.setDrawColor(1);
    if (screen_ == Idle) {
      chinese(title_,titleWidth_,key.titleScroll,12); display_.drawHLine(0,16,128);
      const int r = 7 + key.animation;
      display_.drawFrame(52,27,24,18);
      display_.drawCircle(64,36,r,U8G2_DRAW_UPPER_RIGHT|U8G2_DRAW_LOWER_RIGHT);
      chinese(detail_,detailWidth_,key.detailScroll,62);
    } else if (screen_ == Waiting) {
      chinese(title_,titleWidth_,key.titleScroll,12);
      if (key.decorations) {
        const int x = static_cast<int>(key.animation)-16;
        const int left = x < 0 ? 0 : x, right = x+16 > 128 ? 128 : x+16;
        if (right > left) display_.drawHLine(left,17,right-left);
      }
      number(key.typed,49);
      chinese(detail_,detailWidth_,key.detailScroll,63);
    } else if (inIntro) {
      const int shift = screen_ == Error ? static_cast<int>(key.animation)*2-2 : 0;
      display_.drawCircle(64+shift,26,18);
      if (screen_ == Success) {
        display_.drawLine(54,26,61,33); display_.drawLine(61,33,75,18);
        const int y = 3 + key.animation;
        display_.drawDisc(23,y,2); display_.drawDisc(103,17-y,2);
      } else {
        display_.drawLine(57+shift,19,71+shift,33); display_.drawLine(71+shift,19,57+shift,33);
      }
      chinese(title_,titleWidth_,key.titleScroll,61);
    } else {
      chinese(title_,titleWidth_,key.titleScroll,12+key.slide);
      if (amount_.length()) number(key.typed,49+key.slide);
      chinese(detail_,detailWidth_,key.detailScroll,63+key.slide);
    }
    lastKey_ = key;haveKey_ = true;
    // Different phases can still produce identical pixels (e.g. an off-screen
    // scan line). Never send a duplicate 1024-byte frame in that case.
    const uint8_t* pixels = display_.getBufferPtr();
    if (!haveFrame_ || memcmp(previousFrame_,pixels,sizeof(previousFrame_))) {
      display_.sendBuffer();memcpy(previousFrame_,pixels,sizeof(previousFrame_));haveFrame_ = true;
    }
  }
 private:
  struct FrameKey {
    uint8_t screen=0,effect=0,fontSize=0;bool intro=false,decorations=false;
    uint16_t animation=0,slide=0,typed=0,titleScroll=0,detailScroll=0;
    bool operator==(const FrameKey& other) const {
      return screen==other.screen&&effect==other.effect&&fontSize==other.fontSize&&intro==other.intro&&decorations==other.decorations&&
        animation==other.animation&&slide==other.slide&&typed==other.typed&&
        titleScroll==other.titleScroll&&detailScroll==other.detailScroll;
    }
  };
  enum Screen { Idle, Waiting, Card, Success, Error } screen_ = Idle;
  U8G2_SSD1306_128X64_NONAME_F_HW_I2C display_{U8G2_R0,U8X8_PIN_NONE,OLED_SCL,OLED_SDA};
  String title_, detail_, amount_;
  uint32_t at_ = 0, frameAt_ = 0;
  FrameKey lastKey_{};
  uint8_t previousFrame_[128*64/8]{};
  bool haveKey_=false,haveFrame_=false,metricsDirty_=true;
  bool sleeping_=false;
  int16_t contrast_=-1;
  uint8_t measuredFontSize_=0;
  int titleWidth_=0,detailWidth_=0,amountWidth_=0;
  const uint8_t* amountFont_=u8g2_font_logisoso16_tf;
  void changed() { at_ = millis(); frameAt_ = at_ - 65;haveKey_=false;metricsDirty_=true; }
  static String money(int32_t cents) {
    char text[24]; snprintf(text,sizeof(text),"%ld.%02ld",static_cast<long>(cents/100),static_cast<long>(cents%100));
    return String(text);
  }
  void measureText() {
    display_.setFont(u8g2_font_wqy12_t_gb2312);
    titleWidth_=display_.getUTF8Width(title_.c_str());detailWidth_=display_.getUTF8Width(detail_.c_str());
    amountFont_=settings.fontSize == 32 ? u8g2_font_logisoso32_tf :
      settings.fontSize == 24 ? u8g2_font_logisoso24_tf :
      settings.fontSize == 16 ? u8g2_font_logisoso16_tf : u8g2_font_6x12_tf;
    display_.setFont(amountFont_);amountWidth_=display_.getStrWidth(amount_.c_str());
    if (amountWidth_>126) {
      amountFont_=u8g2_font_logisoso16_tf;display_.setFont(amountFont_);
      amountWidth_=display_.getStrWidth(amount_.c_str());
    }
    measuredFontSize_=settings.fontSize;metricsDirty_=false;
  }
  bool visibleBaseline(int baseline) {
    // U8g2 uses unsigned coordinates (16 bits on ESP32). Reject fully hidden
    // lines before conversion and let the explicit clip window crop partial ones.
    return baseline>=0 && baseline-display_.getAscent()<64 && baseline-display_.getDescent()>=0;
  }
  void chinese(const String& text,int width,int scroll,int baseline) {
    display_.setFont(u8g2_font_wqy12_t_gb2312);
    if (!visibleBaseline(baseline)) return;
    if (width <= 128) display_.drawUTF8(0,baseline,text.c_str());
    else if (settings.effect == 1) {
      // U8g2 deliberately accepts a wrapped negative x for left-edge clipping.
      display_.drawUTF8(static_cast<u8g2_uint_t>(-scroll),baseline,text.c_str());
      display_.drawUTF8(width+24-scroll,baseline,text.c_str());
    } else display_.drawUTF8(0,baseline,text.c_str());
  }
  uint16_t typedLength(uint32_t elapsed) const {
    const size_t count=elapsed/100+1, length=amount_.length();
    return static_cast<uint16_t>(count<length?count:length);
  }
  void number(size_t count,int baseline) {
    display_.setFont(amountFont_);
    if (!visibleBaseline(baseline)) return;
    const int x=(128-amountWidth_)/2;
    if (settings.effect != 2) { display_.drawStr(x,baseline,amount_.c_str());return; }
    char shown[24];
    if (count>=sizeof(shown))count=sizeof(shown)-1;
    memcpy(shown,amount_.c_str(),count);shown[count]=0;
    display_.drawStr(x,baseline,shown);
  }
};
}

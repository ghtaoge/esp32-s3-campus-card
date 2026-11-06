#pragma once
#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>

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
  bool finished(uint32_t now) const {
    return screen_ != Idle && screen_ != Waiting && now - at_ > static_cast<uint32_t>(settings.holdMs) + 900;
  }
  void tick(uint32_t now) {
    if (!ready || now - frameAt_ < 65) return;
    frameAt_ = now;
    display_.clearBuffer();
    const uint32_t elapsed = now - at_;
    display_.setDrawColor(1);
    if (screen_ == Idle) {
      chinese(title_,0,12); display_.drawHLine(0,16,128);
      // A locally animated reader coil, independent of Bluetooth callbacks.
      const int r = 7 + (now / 180) % 13;
      display_.drawFrame(52,27,24,18);
      display_.drawCircle(64,36,r,U8G2_DRAW_UPPER_RIGHT|U8G2_DRAW_LOWER_RIGHT);
      chinese(detail_,0,62);
    } else if (screen_ == Waiting) {
      chinese(title_,0,12);
      const int x = (now / 30) % 144 - 16;
      display_.drawHLine(x,17,16);
      number(amount_,elapsed,49);
      chinese(detail_,0,63);
    } else if ((screen_ == Success || screen_ == Error) && elapsed < 650 && settings.effect) {
      const int shift = screen_ == Error ? static_cast<int>((elapsed / 60) % 3) * 2 - 2 : 0;
      display_.drawCircle(64+shift,26,18);
      if (screen_ == Success) {
        display_.drawLine(54,26,61,33); display_.drawLine(61,33,75,18);
        // Three short moving rays suggest coins / a completed transaction.
        const int y = 3 + (elapsed / 35) % 12;
        display_.drawDisc(23,y,2); display_.drawDisc(103,17-y,2);
      } else {
        display_.drawLine(57+shift,19,71+shift,33); display_.drawLine(71+shift,19,57+shift,33);
      }
      chinese(title_,0,61);
    } else {
      const uint32_t t = elapsed > 650 ? elapsed - 650 : elapsed;
      const int slide = settings.effect == 1 && t < 350 ? (350-t)*64/350 : 0;
      chinese(title_,0,12+slide);
      if (amount_.length()) number(amount_,t,49+slide);
      chinese(detail_,0,63+slide);
    }
    display_.sendBuffer();
  }
 private:
  enum Screen { Idle, Waiting, Card, Success, Error } screen_ = Idle;
  U8G2_SSD1306_128X64_NONAME_F_HW_I2C display_{U8G2_R0,U8X8_PIN_NONE,OLED_SCL,OLED_SDA};
  String title_, detail_, amount_;
  uint32_t at_ = 0, frameAt_ = 0;
  void changed() { at_ = millis(); frameAt_ = at_ - 65; }
  static String money(int32_t cents) {
    char text[24]; snprintf(text,sizeof(text),"%ld.%02ld",static_cast<long>(cents/100),static_cast<long>(cents%100));
    return String(text);
  }
  void chinese(const String& text, int x, int baseline) {
    display_.setFont(u8g2_font_wqy12_t_gb2312);
    const int width = display_.getUTF8Width(text.c_str());
    if (width <= 128) display_.drawUTF8(x,baseline,text.c_str());
    else if (settings.effect == 1) {
      const int delta = ((millis()-at_)/40) % (width + 24);
      display_.drawUTF8(x-delta,baseline,text.c_str());
      display_.drawUTF8(x-delta+width+24,baseline,text.c_str());
    } else display_.drawUTF8(x,baseline,text.c_str());
  }
  void number(const String& text, uint32_t elapsed, int baseline) {
    const uint8_t* font = settings.fontSize == 32 ? u8g2_font_logisoso32_tf :
      settings.fontSize == 24 ? u8g2_font_logisoso24_tf :
      settings.fontSize == 16 ? u8g2_font_logisoso16_tf : u8g2_font_6x12_tf;
    display_.setFont(font);
    int width = display_.getStrWidth(text.c_str());
    // Transaction amounts must fit in full even at the shortest hold time.
    if (width > 126) { display_.setFont(u8g2_font_logisoso16_tf); width=display_.getStrWidth(text.c_str()); }
    int x = (128-width)/2;
    String shown = text;
    if (settings.effect == 2) shown = text.substring(0, min(static_cast<unsigned>(text.length()),static_cast<unsigned>(elapsed/100+1)));
    display_.drawStr(x,baseline,shown.c_str());
  }
};
}

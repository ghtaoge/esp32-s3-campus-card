#include <assert.h>
#include <stdio.h>
#include <limits.h>
#define OLED_SDA 8
#define OLED_SCL 9
#include "oled_ui.h"

using campusui::OledUi;
static_assert(sizeof(campusui::Settings)==4,"Existing display settings must retain their four-byte NVS layout");
void tick(OledUi& ui,uint32_t now){arduinoFake::now=now;ui.tick(now);}
void begin(OledUi& ui,uint32_t now=0){arduinoFake::now=now;assert(ui.begin());oledFake::reset();}
std::string amount(){for(auto it=oledFake::text.rbegin();it!=oledFake::text.rend();++it)if(!it->utf8)return it->text;return "";}

void testStaticStopsRendering(){
  OledUi ui;begin(ui);ui.settings.effect=0;ui.card("测试",10000001,3750);
  arduinoFake::stringCopies=0;tick(ui,0);assert(oledFake::sends==1&&oledFake::clears==1);
  for(unsigned t=65;t<1000;t+=65)tick(ui,t);
  assert(oledFake::sends==1&&oledFake::clears==1&&arduinoFake::stringCopies==0);
  ui.refresh();tick(ui,1000);assert(oledFake::clears==2&&oledFake::sends==1);
}
void testIdleAndWaitingStatic(){
  OledUi ui;begin(ui);ui.settings.effect=0;tick(ui,0);tick(ui,500);tick(ui,1000);
  assert(oledFake::sends==1&&oledFake::clears==1);
  ui.waiting("topup",1250);tick(ui,1000);unsigned sends=oledFake::sends,clears=oledFake::clears;
  tick(ui,1500);tick(ui,2000);assert(oledFake::sends==sends&&oledFake::clears==clears);
}
void testIdlePhaseAndSettings(){
  OledUi ui;begin(ui);tick(ui,0);tick(ui,65);tick(ui,130);tick(ui,179);
  assert(oledFake::sends==1&&oledFake::clears==1);
  tick(ui,180);assert(oledFake::sends==2&&oledFake::clears==2);
  ui.settings.effect=0;ui.card("测试",10000001,3750);tick(ui,180);unsigned sends=oledFake::sends;
  ui.settings.fontSize=32;ui.refresh();tick(ui,190);assert(oledFake::sends==sends+1);
}
void testTypeNeverMovesBackAt650(){
  OledUi ui;begin(ui);ui.settings.effect=2;ui.card("测试",10000001,123456);
  size_t previous=0;arduinoFake::stringCopies=0;
  for(uint32_t t=0;t<=1000;t+=100){tick(ui,t);assert(amount().size()>=previous);previous=amount().size();}
  assert(amount()=="1234.56"&&arduinoFake::stringCopies==0);
  unsigned clears=oledFake::clears;tick(ui,1500);assert(oledFake::clears==clears);
}
void testOnlyResultsHaveIntro(){
  OledUi ui;begin(ui);ui.settings.effect=2;ui.result("充值成功",100,123456,true);
  tick(ui,0);assert(amount().empty());tick(ui,600);assert(amount().empty());
  tick(ui,700);assert(amount()=="1");tick(ui,800);assert(amount()=="12");
  ui.settings.effect=0;ui.result("充值成功",100,123456,true);tick(ui,800);assert(amount()=="1234.56");
}
void testSlideEndsAndClips(){
  OledUi ui;begin(ui);ui.settings.effect=1;ui.card("测试",10000001,3750);tick(ui,0);
  assert(oledFake::text.empty());
  tick(ui,65);for(const auto& call:oledFake::text)assert(call.y>=0&&call.y<96);
  tick(ui,350);unsigned clears=oledFake::clears;
  tick(ui,500);tick(ui,700);tick(ui,1000);assert(oledFake::clears==clears);
}
void testLongAmountFitsEveryEffect(){
  for(uint8_t effect=0;effect<3;++effect){
    OledUi ui;begin(ui);ui.settings.effect=effect;ui.settings.fontSize=32;ui.card("测试",10000001,100000000);
    tick(ui,1000);assert(amount()=="1000000.00");
    for(const auto& call:oledFake::text)if(!call.utf8){assert(call.font==u8g2_font_logisoso16_tf);assert(call.x>=0);}
  }
}
void testUnsignedMillisWrap(){
  const uint32_t start=UINT32_MAX-350;OledUi ui;begin(ui,start);ui.settings.effect=2;ui.card("测试",10000001,123456);
  size_t previous=0;
  for(uint32_t delta=0;delta<=1000;delta+=100){tick(ui,start+delta);assert(amount().size()>=previous);previous=amount().size();}
  assert(amount()=="1234.56");assert(!ui.finished(start+1000));assert(ui.finished(start+4000));
}
void testSleepAndContrast(){
  OledUi ui;begin(ui);ui.settings.effect=0;tick(ui,0);
  ui.setContrast(32);ui.setContrast(32);assert(oledFake::contrastCalls==1&&oledFake::contrast==32);
  ui.setContrast(120);assert(oledFake::contrastCalls==2&&oledFake::contrast==120);
  const unsigned sends=oledFake::sends,clears=oledFake::clears;
  ui.setSleeping(true);ui.setSleeping(true);assert(ui.sleeping()&&oledFake::powerSaveCalls==1&&oledFake::powerSave==1);
  tick(ui,500);tick(ui,1000);assert(oledFake::sends==sends&&oledFake::clears==clears);
  ui.setSleeping(false);ui.setSleeping(false);assert(!ui.sleeping()&&oledFake::powerSaveCalls==2&&oledFake::powerSave==0);
  tick(ui,1000);assert(oledFake::sends==sends+1&&oledFake::clears==clears+1);
}
void testPowerConfigurationBeforeBegin(){
  oledFake::reset();OledUi ui;ui.setContrast(80);ui.setSleeping(true);
  assert(oledFake::contrastCalls==0&&oledFake::powerSaveCalls==0);
  arduinoFake::now=100;assert(ui.begin());
  assert(oledFake::contrastCalls==1&&oledFake::contrast==80&&oledFake::powerSaveCalls==1&&oledFake::powerSave==1);
  tick(ui,100);assert(oledFake::clears==0&&oledFake::sends==0);
  ui.setSleeping(false);tick(ui,100);assert(oledFake::clears==1&&oledFake::sends==1);
}
void testReducedMotionKeepsTransactionAnimations(){
  OledUi ui;begin(ui);ui.tick(0,true);arduinoFake::now=500;ui.tick(500,true);
  assert(oledFake::clears==1&&oledFake::sends==1);
  ui.waiting("topup",1250);ui.tick(500,true);unsigned clears=oledFake::clears,sends=oledFake::sends;
  arduinoFake::now=1000;ui.tick(1000,true);assert(oledFake::clears==clears&&oledFake::sends==sends);
  ui.result("充值成功",100,1250,true);ui.tick(1000,true);clears=oledFake::clears;
  arduinoFake::now=1100;ui.tick(1100,true);assert(oledFake::clears==clears+1);
  ui.settings.effect=0;ui.idle(false);ui.tick(1100,false);clears=oledFake::clears;
  arduinoFake::now=1500;ui.tick(1500,false);assert(oledFake::clears==clears);
}
int main(){
  testStaticStopsRendering();testIdleAndWaitingStatic();testIdlePhaseAndSettings();testTypeNeverMovesBackAt650();
  testOnlyResultsHaveIntro();testSlideEndsAndClips();testLongAmountFitsEveryEffect();testUnsignedMillisWrap();
  testSleepAndContrast();testPowerConfigurationBeforeBegin();testReducedMotionKeepsTransactionAnimations();
  puts("OLED: phase scheduling, frame suppression, clipping, type timing, sizing, millis wrap, sleep, contrast and reduced motion passed");
}

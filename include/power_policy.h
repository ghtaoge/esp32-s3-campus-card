#pragma once
#include <stdint.h>

namespace campuspower {
struct Config {
  uint32_t version=1;
  uint16_t idleSeconds=60;
  uint8_t brightness=180;
  bool batteryMode=false;
};
inline bool valid(const Config& c) {
  return c.version==1 && c.brightness>=1 && (c.idleSeconds==0 || (c.idleSeconds>=10 && c.idleSeconds<=3600));
}
inline bool same(const Config& a,const Config& b) {
  return a.version==b.version&&a.idleSeconds==b.idleSeconds&&a.brightness==b.brightness&&a.batteryMode==b.batteryMode;
}
class Policy {
 public:
  Config config;
  bool awake=true;
  void activity(uint32_t now){lastActivity_=now;awake=true;}
  bool tick(uint32_t now,bool waiting) {
    const bool next=waiting || !config.idleSeconds || uint32_t(now-lastActivity_)<uint32_t(config.idleSeconds)*1000u;
    const bool changed=awake!=next;awake=next;return changed;
  }
  uint32_t pollInterval(bool pending)const{return config.batteryMode&&!pending?500u:120u;}
 private:
  uint32_t lastActivity_=0;
};
}

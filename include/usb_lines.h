#pragma once
#include <stddef.h>
#include <stdint.h>

namespace campususb {
constexpr size_t MaxRequestLine=768;
enum class LineResult{Partial,Complete,Overflow};
struct Connection {
  bool active=false,missing=false;uint32_t missingAt=0;
  bool update(bool ready,uint32_t now) {
    if(ready){missing=false;active=true;}
    else if(active) {
      if(!missing){missing=true;missingAt=now;}
      else if(uint32_t(now-missingAt)>=200)active=false;
    }
    return active;
  }
};
struct Lines {
  char body[MaxRequestLine+1]={};size_t size=0;bool discarding=false;
  void reset(){size=0;discarding=false;}
  LineResult accept(char value) {
    if(value=='\r')return LineResult::Partial;
    if(value=='\n'){
      if(discarding){reset();return LineResult::Overflow;}
      body[size]=0;return LineResult::Complete;
    }
    if(discarding)return LineResult::Partial;
    if(size==MaxRequestLine){discarding=true;return LineResult::Partial;}
    body[size++]=value;return LineResult::Partial;
  }
};
}

#pragma once
#include "campus_core.h"

namespace campuslog {
struct Snapshot {
  campus::Result records[campus::LogCount]{};
  size_t count=0;uint32_t revision=0;bool active=false;
  void clear(){active=false;count=0;}
  template<class Engine> void capture(const Engine& engine) {
    count=0;while(count<campus::LogCount){const auto* row=engine.log(count);if(!row)break;records[count++]=*row;}
    if(++revision==0)++revision;
    active=true;
  }
  bool matches(uint32_t requested,size_t offset)const{return active&&requested==revision&&offset<=count;}
};
}

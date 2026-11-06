#pragma once
#include <stdint.h>
#include <stddef.h>
#include <deque>
#include <utility>

namespace campusble {
template<class Body> class Outbox {
 public:
  struct Message {uint16_t id=0,offset=0;Body body;uint8_t failures=0;};
  static constexpr size_t Capacity=3;
  bool empty()const{return queue_.empty();}
  size_t size()const{return queue_.size();}
  Message& front(){return queue_.front();}
  void pop(){queue_.pop_front();}
  void clear(){queue_.clear();deferred_=false;}
  void deferEvent(){deferred_=true;}
  bool takeDeferred(){if(!empty()||!deferred_)return false;deferred_=false;return true;}
  bool push(uint16_t id,Body body) {
    // Unsent events are snapshots and may be replaced by a newer snapshot. A
    // partially-sent body must finish so the receiver never sees interleaving.
    for(auto it=queue_.begin();it!=queue_.end();) {
      if(!it->id&&!it->offset){it=queue_.erase(it);deferred_=true;}else ++it;
    }
    if(queue_.size()>=Capacity){if(!id)deferred_=true;return false;}
    Message message;message.id=id;message.body=std::move(body);
    if(!id){queue_.push_back(std::move(message));deferred_=false;return true;}
    auto where=queue_.begin();
    if(where!=queue_.end()&&where->offset)++where;
    while(where!=queue_.end()&&where->id)++where;
    queue_.insert(where,std::move(message));return true;
  }
 private:
  std::deque<Message> queue_;bool deferred_=false;
};
}

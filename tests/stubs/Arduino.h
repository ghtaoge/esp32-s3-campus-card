#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string>

namespace arduinoFake {
inline uint32_t now=0;
inline unsigned stringCopies=0;
}
inline uint32_t millis() { return arduinoFake::now; }
class String {
 public:
  String()=default;
  String(const char* text):value_(text?text:""){}
  String(const String& other):value_(other.value_) {++arduinoFake::stringCopies;}
  String(String&&)=default;
  String& operator=(const String& other) {value_=other.value_;++arduinoFake::stringCopies;return *this;}
  String& operator=(String&&)=default;
  String& operator=(const char* text) {value_=text?text:"";return *this;}
  const char* c_str()const{return value_.c_str();}
  size_t length()const{return value_.length();}
  friend String operator+(const String& left,const char* right) {return String((left.value_+right).c_str());}
  friend String operator+(const String& left,const String& right) {return String((left.value_+right.value_).c_str());}
 private:
  std::string value_;
};

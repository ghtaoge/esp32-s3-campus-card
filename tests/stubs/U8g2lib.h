#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <algorithm>
#include <cstdlib>
#include <string>
#include <vector>

// The installed U8g2 enables U8G2_16BIT on 32-bit targets, including ESP32.
using u8g2_uint_t=uint16_t;
inline constexpr int U8G2_R0=0,U8X8_PIN_NONE=255;
inline constexpr int U8G2_DRAW_UPPER_RIGHT=1,U8G2_DRAW_LOWER_RIGHT=2;
inline const uint8_t u8g2_font_wqy12_t_gb2312[]={0};
inline const uint8_t u8g2_font_logisoso32_tf[]={32};
inline const uint8_t u8g2_font_logisoso24_tf[]={24};
inline const uint8_t u8g2_font_logisoso16_tf[]={16};
inline const uint8_t u8g2_font_6x12_tf[]={12};
namespace oledFake {
struct TextCall {bool utf8;int x,y;std::string text;const uint8_t* font;};
inline unsigned sends=0,clears=0,contrastCalls=0,powerSaveCalls=0;
inline uint8_t contrast=0,powerSave=0;
inline std::vector<TextCall> text;
inline void reset(){sends=clears=contrastCalls=powerSaveCalls=0;text.clear();}
}
class U8G2_SSD1306_128X64_NONAME_F_HW_I2C {
 public:
  U8G2_SSD1306_128X64_NONAME_F_HW_I2C(int,int,int,int){}
  void setI2CAddress(unsigned){}
  void setBusClock(uint32_t){}
  void begin(){}
  void enableUTF8Print(){}
  void setContrast(uint8_t contrast){++oledFake::contrastCalls;oledFake::contrast=contrast;}
  void setPowerSave(uint8_t powerSave){++oledFake::powerSaveCalls;oledFake::powerSave=powerSave;}
  void setClipWindow(u8g2_uint_t x0,u8g2_uint_t y0,u8g2_uint_t x1,u8g2_uint_t y1){x0_=x0;y0_=y0;x1_=x1;y1_=y1;}
  void clearBuffer(){++oledFake::clears;memset(pixels_,0,sizeof(pixels_));}
  void sendBuffer(){++oledFake::sends;}
  uint8_t* getBufferPtr(){return pixels_;}
  void setDrawColor(unsigned){}
  void setFont(const uint8_t* font){font_=font;}
  int8_t getAscent(){return font_==u8g2_font_wqy12_t_gb2312?11:*font_;}
  int8_t getDescent(){return -2;}
  int getStrWidth(const char* text){return width(text,false);}
  int getUTF8Width(const char* text){return width(text,true);}
  u8g2_uint_t drawStr(u8g2_uint_t x,u8g2_uint_t y,const char* text){return drawText(x,y,text,false);}
  u8g2_uint_t drawUTF8(u8g2_uint_t x,u8g2_uint_t y,const char* text){return drawText(x,y,text,true);}
  void drawHLine(u8g2_uint_t x,u8g2_uint_t y,u8g2_uint_t count){for(unsigned i=0;i<count;++i)pixel(signedCoordinate(x)+i,signedCoordinate(y));}
  void drawFrame(u8g2_uint_t x,u8g2_uint_t y,u8g2_uint_t width,u8g2_uint_t height){
    for(unsigned i=0;i<width;++i){pixel(x+i,y);pixel(x+i,y+height-1);}
    for(unsigned i=0;i<height;++i){pixel(x,y+i);pixel(x+width-1,y+i);}
  }
  void drawCircle(u8g2_uint_t x,u8g2_uint_t y,u8g2_uint_t radius,unsigned=255){
    for(int dy=-radius;dy<=radius;++dy)for(int dx=-radius;dx<=radius;++dx)
      if(dx*dx+dy*dy<=radius*radius&&dx*dx+dy*dy>=(radius-1)*(radius-1))pixel(x+dx,y+dy);
  }
  void drawDisc(u8g2_uint_t x,u8g2_uint_t y,u8g2_uint_t radius){
    for(int dy=-radius;dy<=radius;++dy)for(int dx=-radius;dx<=radius;++dx)
      if(dx*dx+dy*dy<=radius*radius)pixel(x+dx,y+dy);
  }
  void drawLine(u8g2_uint_t x0,u8g2_uint_t y0,u8g2_uint_t x1,u8g2_uint_t y1){
    int x=x0,y=y0,dx=std::abs(int(x1)-x),sx=x<int(x1)?1:-1,dy=-std::abs(int(y1)-y),sy=y<int(y1)?1:-1,error=dx+dy;
    for(;;){pixel(x,y);if(x==x1&&y==y1)break;int doubled=2*error;if(doubled>=dy){error+=dy;x+=sx;}if(doubled<=dx){error+=dx;y+=sy;}}
  }
 private:
  uint8_t pixels_[1024]{};
  const uint8_t* font_=u8g2_font_wqy12_t_gb2312;
  int x0_=0,y0_=0,x1_=128,y1_=64;
  static int signedCoordinate(u8g2_uint_t value){return static_cast<int16_t>(value);}
  void pixel(int x,int y){if(x>=x0_&&x<x1_&&y>=y0_&&y<y1_&&x>=0&&x<128&&y>=0&&y<64)pixels_[(y/8)*128+x]|=uint8_t(1u<<(y%8));}
  static uint32_t next(const char*& at,bool utf8){
    uint8_t c=static_cast<uint8_t>(*at++);if(!utf8||c<128)return c;
    unsigned count=(c&0xe0)==0xc0?1:(c&0xf0)==0xe0?2:3;uint32_t result=c&((1u<<(6-count))-1);
    while(count--&&*at)result=(result<<6)|(static_cast<uint8_t>(*at++)&63);
    return result;
  }
  int glyphWidth(uint32_t code){return code>=128?12:code=='.'?4:font_==u8g2_font_wqy12_t_gb2312?6:std::max(6,int(*font_)/2);}
  int width(const char* text,bool utf8){int result=0;while(*text)result+=glyphWidth(next(text,utf8));return result;}
  u8g2_uint_t drawText(u8g2_uint_t x,u8g2_uint_t y,const char* text,bool utf8){
    int left=signedCoordinate(x),baseline=signedCoordinate(y),start=left;
    oledFake::text.push_back({utf8,left,baseline,text,font_});
    while(*text){uint32_t code=next(text,utf8);int glyph=glyphWidth(code);
      for(int dy=0;dy<getAscent();++dy)for(int dx=0;dx<glyph-1;++dx)
        if((dx+dy+code)%3)pixel(left+dx,baseline-getAscent()+dy);
      left+=glyph;
    }
    return static_cast<u8g2_uint_t>(left-start);
  }
};

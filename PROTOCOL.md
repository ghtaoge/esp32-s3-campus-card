# 校园卡演示协议 v1

仅用于自己的 MIFARE Classic 1K/4K 测试卡及模拟余额。设备单机管理卡片，BLE 接口默认不启用配对认证。

## 连接

广播名称 `S3-CAMPUS-XXXX`。
Service `c4a10001-6d6a-4b2e-ae8b-3d80b18a5100`；Write `c4a10002-6d6a-4b2e-ae8b-3d80b18a5100` (write with response)；Notify `c4a10003-6d6a-4b2e-ae8b-3d80b18a5100` (notify)。

每包至多 20 字节：`magic version messageIdLE16 offsetLE16 totalLE16 payload`。
请求 magic=0xC7，回应/事件 magic=0xC8，version=1。payload 至多12字节。正文 UTF-8 JSON，请求至多512字节，回应至多4096字节。offset 从0连续递增，total 必须一致。messageId=1..65535为请求与匹配回应，0为设备主动事件。请求包逐包等待微信 write success，再间隔20ms；同时仅允许一个请求。设备通知包依次间隔20ms发送，不交错不同正文。

连接后订阅通知再发送 state。客户端在完整回应前不显示操作成功；等待最多15秒。超时/断线后须用同一个业务 id 查询结果，不生成新业务 id 重试充值/消费。应用业务 id 为16位十六进制字符串（8字节）。

## 请求

- `{op:"state"}` 获取当前状态。
- `{op:"arm",id:"0123456789abcdef",kind:"issue",name:"小明",studentNo:"20260001"}` 等待开卡。name非空且UTF-8最多24字节；studentNo最多16字节；初始余额0。
- `{op:"arm",id:"...",kind:"topup"|"spend",amountCents:1250,scene:"食堂"}` 等待充值/消费。金额为正整数分，最多100000000；scene UTF-8最多24字节。任务30秒未刷卡失效；写入结果未确认时任务保留，禁止启动另一任务。
- `{op:"cancel"}` 只取消尚未开始写卡的等待任务；未确认交易不能取消。
- `{op:"logs"}` 返回最近最多20笔完整记录。
- `{op:"settings",fontSize:16,effect:"slide",holdMs:3000}`：fontSize=12/16/24/32；effect="static"/"slide"/"type"；holdMs=1500..10000。设备持久化保存。
- `{op:"result",id:"..."}` 查询原业务结果，包含在 result 字段，无记录为null。

## 回应/事件

成功回应 `{ok:true,op:"state",...状态字段}`；失败 `{ok:false,op:"arm",code:"BUSY",message:"请先完成当前交易",...状态字段}`。
所有普通回应和主动事件都带状态字段（logs可只带logs）：

```
{
  device:{name:"S3-CAMPUS-ABCD",oledReady:true,readerReady:true},
  settings:{fontSize:16,effect:"slide",holdMs:3000},
  card:null | {uid:"AABBCCDD",cardNo:12345678,name:"小明",studentNo:"20260001",balanceCents:3750,sequence:2},
  pending:null | {id:"...",kind:"topup",amountCents:5000,scene:"充值",phase:"waiting"|"uncertain"},
  lastResult:null | {id:"...",kind:"spend",status:"success"|"declined"|"uncertain"|"cancelled"|"expired",code:"OK",message:"消费成功",uid:"...",cardNo:12345678,amountCents:1250,balanceCents:3750,sequence:2,scene:"食堂",timestamp:1790000000},
  event:"card"|"transaction"|"pending"|"status"
}
```

logs/result项结构同lastResult。timestamp=设备尚未校时则0；另外含 uptimeMs。小程序显示“设备未校时”或收到时间，不能假装成精确交易时间。state请求可带unixTime（秒，2024..2100）校时。

待机刷卡只查询。所有交易先在ESP32持久化待确认记录，再写卡非当前快照槽并回读校验，最后提交本地流水。写入/读回失败视为uncertain，重新刷原卡恢复；不盲目再次扣款。每笔交易使用同一id，重复请求不重复执行。

# 校园卡演示协议 v1

适用于自己的 MIFARE Classic 1K/4K 测试卡与模拟余额。新增 USB、电源、诊断和流水分页能力，BLE 帧版本仍为 1，卡片快照格式和 NVS 账本版本不变。

## 传输与双端协作

PC 可通过 USB 串口与手机微信小程序的 BLE **同时连接**同一终端。若 PC 使用 Web Bluetooth，则与手机**轮流使用 BLE**，切换前断开已有 BLE 客户端并核对当前订单。

USB 与 BLE 共用一个交易引擎；同一时刻只有一个 `waiting` 或 `uncertain` 任务。另一端提交不同业务 id 会收到 `BUSY`。当前待办及结果通过主动事件同步到已连接的两端；连接断开不会撤销已经写入卡片的交易。显示与电源设置保存在设备，两端查询同一份配置；商品目录、充值档位及客户端原订单标记各自保存在本机，不经此协议云同步。

传输消息 id 与业务 id 是两种编号：消息 id 为 1–65535 的整数，用于匹配一次请求和回应；业务 id 是非零的 16 位十六进制字符串，用于充值、消费、开卡的幂等与恢复。消息 id=0 只用于设备主动事件。

### BLE

广播名称 `S3-CAMPUS-XXXX`。

| 特征 | UUID | 属性 |
| --- | --- | --- |
| Service | `c4a10001-6d6a-4b2e-ae8b-3d80b18a5100` | 服务 |
| Write | `c4a10002-6d6a-4b2e-ae8b-3d80b18a5100` | Write with response |
| Notify | `c4a10003-6d6a-4b2e-ae8b-3d80b18a5100` | Notify |

每包至多 20 字节：`magic version messageIdLE16 offsetLE16 totalLE16 payload`。请求 magic=`0xC7`，回应与事件 magic=`0xC8`，version=1。8 字节帧头后的 payload 至多 12 字节；正文为 UTF-8 JSON，请求最多 512 字节，回应最多 4096 字节。offset 从 0 连续递增，各包 total 和 messageId 必须一致；UTF-8 字符可跨包，完整组包后再解码。

连接后先订阅通知，再发送 `state`。客户端每包等待原生 write 成功，并间隔 20ms；每个连接串行执行 RPC，完整回应前不报告操作完成。设备按 20ms 最小间隔发送通知分包，不交错不同正文；主循环调度和卡片 I/O 可能使实际间隔更长。

客户端 RPC 超时为 15 秒。若原生写调用仍未回调，该连接应关闭，重连后查询原业务 id；不能在悬挂原生写上再并发发送。旧消息 id 的迟到帧应忽略，主动事件和当前 RPC 分别组包。BLE 默认没有配对认证。

### USB 串口

115200 波特率、UTF-8 逐行 JSON，以 `\n` 结束，接受 `\r\n`。请求外层必须为 `{id,body}`：

```json
{"id":1,"body":{"op":"state","unixTime":1794009600}}
```

回应保留消息 id，正文与 BLE 一致；主动事件的外层 id=0：

```json
{"id":1,"body":{"ok":true,"op":"state","device":{"id":"设备标识"}}}
{"id":0,"body":{"ok":true,"event":"card","card":null}}
```

上例省略了其余状态字段。USB 每行请求上限为 768 字节，内部 body 序列化后的上限仍为 512 字节；响应 body 同样最多 4096 字节。客户端串行排队等待完整回应，超时后查询原业务编号。启动和连接诊断可能产生非 JSON 行，应作为诊断文字忽略，不将其当成 RPC 回应。非法外层帧无法可靠取得消息 id 时，错误回应可能使用 id=1。

## 状态和能力协商

先请求 `{"op":"state"}`。可以携带 `unixTime`（整数秒，1704067200–4102444800）校时；`state`、`result`、`logs` 和 `diagnostics` 查询不主动唤醒屏幕。

常规回应与主动事件包含以下字段；流水分页只返回分页字段：

```json
{
  "device": {
    "id": "稳定设备标识",
    "name": "S3-CAMPUS-ABCD",
    "oledReady": true,
    "readerReady": true,
    "storageReady": true,
    "usbReady": true,
    "capabilities": {"power": true, "logPagination": true, "diagnostics": true}
  },
  "settings": {"fontSize": 16, "effect": "slide", "holdMs": 3000},
  "power": {
    "batteryMode": false,
    "brightness": 180,
    "idleSeconds": 60,
    "screenAwake": true,
    "batteryMeasurement": false,
    "batteryVoltage": null
  },
  "card": null,
  "pending": null,
  "lastResult": null
}
```

`device.id` 用于识别同一终端，独立于操作系统提供的蓝牙 deviceId。`usbReady` 表示当前固件识别到 USB 串口会话。`card` 是最近一次有效读到的卡片资料，不是“卡片仍停留在天线上”的指示。

旧固件可能缺少 `device.id`、`capabilities` 和 `power`。缺少对应能力时，客户端禁用新的电源或诊断操作，不发送未知命令。新客户端按 `nextOffset` 字段识别分页，也支持旧固件的单页流水回应。旧客户端不会自动读取新分页接口的后续页面，应配套更新客户端。

## 业务请求

| 请求 | 语义 |
| --- | --- |
| `{"op":"arm","id":"0123456789abcdef","kind":"issue","name":"小明","studentNo":"20260001"}` | 等待空白卡开卡，初始余额 0；姓名非空，UTF-8 最多 24 字节；学号最多 16 字节 |
| `{"op":"arm","id":"0123456789abcdef","kind":"topup","amountCents":5000,"scene":"充值"}` | 等待刷卡增加模拟余额 |
| `{"op":"arm","id":"0123456789abcdef","kind":"spend","amountCents":1250,"scene":"食堂"}` | 等待刷卡消费，先检查余额 |
| `{"op":"cancel"}` | 只取消尚未写卡的等待任务；`uncertain` 任务不能取消 |
| `{"op":"result","id":"0123456789abcdef"}` | 查询原业务结果，放在 `result`，无可返回结果则为 null |

表内相同示例业务 id 用于说明字段；不同业务必须生成不同 id。同一业务的重试需保留编号和所有业务参数。金额内部使用整数“分”，单笔范围 1–100000000；场景最多 24 个 UTF-8 字节。姓名、学号、场景拒绝无效 UTF-8 和控制字符。

`arm` 成功只代表进入等待状态，不能视为充值、消费或开卡已完成。等待任务 30 秒未刷卡即过期；重启后未开始写卡的等待任务也转为过期。待机刷卡只查询。交易写入或回读结果未知时保留 `uncertain`，必须在原设备重刷原卡核对。

## 屏幕、电源和诊断请求

`{"op":"settings","fontSize":16,"effect":"slide","holdMs":3000}` 保存 OLED 设置。fontSize=12/16/24/32，effect=`static`/`slide`/`type`，holdMs=1500–10000。字号和逐字效果作用于金额，中文标签固定 12 像素；超宽金额缩为 16 像素完整显示，长中文在 slide 模式滚动，其它模式可能截断。

`{"op":"power","batteryMode":true,"brightness":80,"idleSeconds":30}` 保存独立电源设置。三个字段必须同时提供；batteryMode 为布尔，brightness 为 1–255 整数，idleSeconds 为 0（常亮）或 10–3600 整数。字段无效返回 `BAD_POWER`，保存失败返回 `STORAGE_ERROR`；成功回应带设备确认后的 `power`。

`{"op":"wake"}` 只唤醒屏幕，不修改余额。新卡、业务操作及成功应用显示或电源设置会唤醒屏幕。电池省电模式将闲置刷卡轮询从 120ms 放宽到 500ms，存在待办时仍使用 120ms；动画帧率也可降低。软件不进入会断开 BLE/USB 会话的深睡眠。

当前没有电压采样硬件，设备明确返回 `batteryMeasurement:false,batteryVoltage:null`。不能据亮度或省电开关推导电量百分比。`screenAwake` 是此次设备快照确认的屏幕状态；客户端未刷新时应按“上次确认”呈现。

`{"op":"diagnostics"}` 在常规状态外增加只读 `diagnostics`：

```json
{
  "uptimeMs": 120000,
  "freeHeapBytes": 80000,
  "minFreeHeapBytes": 72000,
  "psramBytes": 8388608,
  "flashBytes": 16777216,
  "maxLoopMs": 85,
  "lastCardMs": 65,
  "maxCardMs": 80,
  "bleConnected": true,
  "usbConnected": true,
  "bleQueue": 0,
  "usbQueue": 0
}
```

以上数值仅为字段示例，客户端展示设备实报值；没有测量结果时不编造结果。lastCardMs/maxCardMs 测量交易引擎读写与存储处理耗时，maxLoopMs 为主循环已记录的最大处理时间，队列长度表示采样当时的待发送消息数。

## 流水快照分页

首请求 `{"op":"logs","offset":0,"limit":5}` 创建**当前传输通道**最近最多 20 条结果的 RAM 快照，按新到旧返回。BLE 与 USB 各自维护一个快照，两端同时读取不会使对方快照失效。

```json
{"ok":true,"op":"logs","logs":[],"nextOffset":null,"total":0,"revision":"1234abcd"}
```

实际页面含最多 limit 条记录，limit 默认为 5、范围 1–5；offset 为 0–20。还有后续记录时，nextOffset 是下一条偏移；读取结束为 null。revision 是固定 8 位十六进制字符串。

后续发送 `{"op":"logs","offset":5,"limit":5,"revision":"1234abcd"}`，保持同一快照 revision。这个通道再次请求 offset=0 会替换旧快照；会话断开清理后，旧快照也不可继续使用。revision 不匹配或已无对应快照返回 `LOG_SNAPSHOT_EXPIRED`；分页参数无效返回 `BAD_LOG_PAGE`。新交易不会改变已捕获的页面内容，完整刷新后才包含新记录。

客户端检查 revision、total、连续 offset 和重复业务 id，所有页获取完再更新列表。中间页面失败保留之前的完整列表；快照过期时可整轮重拉一次，不能无限重试。旧固件的单页回应没有 nextOffset，新客户端按单页格式接收。统计和 CSV 导出只覆盖当前读取并筛选的结果；只有 success 的充值或消费计入金额合计。

## 回应、事件与交易结果

成功 RPC 回应形如 `{"ok":true,"op":"state",...状态字段}`；失败形如 `{"ok":false,"op":"arm","code":"BUSY","message":"请先完成当前交易",...状态字段}`。不要用本地化 message 文本判断业务状态，按 ok、code、pending 和结果 status 处理。

主动事件的正文包含 `event:"card"|"transaction"|"pending"|"status"` 与状态字段，USB 外层或 BLE 消息 id 均为 0。错误读卡事件也可能 `ok:false`。设备为有界队列合并或延后主动状态通知，未收到事件不代表业务失败；客户端应查询原业务编号。

`card` 非 null 时为 `{uid,cardNo,name,studentNo,balanceCents,sequence}`。`pending` 非 null 时为 `{id,kind,amountCents,scene,phase}`，phase 为 waiting/uncertain。lastResult、result 及 logs 项共用下列结构：

```json
{
  "id": "0123456789abcdef",
  "kind": "spend",
  "status": "success",
  "code": "OK",
  "message": "操作成功",
  "uid": "AABBCCDD",
  "cardNo": 12345678,
  "amountCents": 1250,
  "balanceCents": 3750,
  "sequence": 2,
  "scene": "食堂",
  "timestamp": 1794009600,
  "uptimeMs": 120000
}
```

status 为 success/declined/uncertain/cancelled/expired。没有读到卡时 cardNo=0、balanceCents=0 是占位值，客户端显示“未读取”，不能表示余额归零；uncertain 余额显示“待核对”，不能把写卡前余额当作最终余额。取消 RPC 本身成功可以 `ok:true`，对应 lastResult 仍保留 cancelled 业务终态。

timestamp 未校时为 0，客户端显示“设备未校时”；不要将手机或 PC 收到通知的时间当成精确交易时间。uptimeMs 是设备运行毫秒数。

所有交易仍先持久化精确的待确认记录，再写卡非当前快照槽并回读校验，最后提交流水。完整、已确认的业务结果才可报告成功；蓝牙发送成功、串口写出成功或 arm 回应都不代表资金变动已完成。

幂等与旧记录识别遵循现有保留窗口：20 条结果明细、96 个已处理业务 id、16 张卡的高水位，见 [CARD_FORMAT.md](docs/CARD_FORMAT.md)。仅续办近期的原编号业务，不承诺无限期重放去重；明细过期时按 `RESULT_EXPIRED` 等明确结果处理，禁止换新编号自动重试。当前业务不包含退款或挂失。

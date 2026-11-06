# 双端校园卡实验台

## 本轮范围

PC 使用 Windows 本地浏览器控制台（Chrome / Edge），主要通过 Web Serial 连接开发板 USB；电池独立供电时可选 Web Bluetooth。手机微信小程序使用 BLE。两端共用 ESP32 上的同一个交易引擎，同一时刻只有一个等待或待核对任务；界面各自保存原业务编号，收到终态前不创建重复交易。

保留开卡、充值、消费、刷卡查余额、流水、字号与动画设置；增加可编辑商品/消费场景、充值档位、流水筛选与统计、CSV 导出、屏幕布局预览、连接诊断、原订单续办、亮度/闲置熄屏/电池省电模式。PC 提供明确标记的演示设备模式，便于未接线时检查界面。演示余额与实体卡数据相互独立。

本轮不改卡片快照格式、金额确认或NVS账本布局。电池电压和百分比在没有采样硬件时显示未配置，不编造电量；软件省电保持蓝牙和刷卡可用，不进入会断开连接的深睡眠。

## 设备协议扩展

所有现有业务请求保持兼容。BLE 使用原有 20 字节分包。

USB 串口为115200波特率、UTF-8逐行JSON：请求 `{ "id": 1, "body": {"op":"state"} }`；回应相同id，主动事件id=0。id为1..65535。设备的非JSON启动诊断行可忽略；每行请求最多768字节。响应正文仍与BLE一致。PC串口客户端串行排队，完整回应后才结束请求。

`device` 增加 `id`（稳定设备标识）、`usbReady` 和 `capabilities:{power:true,logPagination:true}`；`power` 字段为 `{batteryMode:false,brightness:180,idleSeconds:60,screenAwake:true,batteryMeasurement:false,batteryVoltage:null}`。没有电压采样时不返回电量百分比。

`{op:"power",batteryMode:true,brightness:80,idleSeconds:30}` 保存独立的电源设置；brightness=1..255、idleSeconds=0（不自动熄屏）或10..3600。`{op:"wake"}` 唤醒屏幕，不修改余额。刷新状态/读取流水不自动唤醒；新卡、业务操作及设置操作唤醒。电池模式闲置刷卡轮询间隔较长，等待交易仍保持及时检测。

`{op:"logs",offset:0,limit:5}` 创建该传输通道最近最多20条流水的RAM快照，回应 `{ok:true,op:"logs",logs:[...],nextOffset:5|null,total:20,revision:"8位hex"}`。后续请求带offset、limit和相同revision。一个页面至多5条；BLE与USB分别维护快照，避免双端同时查流水互相打断。快照失效返回 `LOG_SNAPSHOT_EXPIRED`，客户端可整轮重拉一次。旧固件没有nextOffset时客户端按原单页格式兼容。

## 共享前端模块

纯逻辑模块放在 `miniprogram/utils/` 并兼容 CommonJS 与浏览器全局：`protocol.js` 导出 `CampusProtocol`，`business.js` 导出 `CampusBusiness`，`logs.js` 导出 `CampusLogs`，`catalog.js` 导出 `CampusCatalog`。PC本地服务器仅把这些白名单脚本映射到 `/shared/`，不暴露`.local`、Git或其它工作区文件。

## 需要验证

保留所有交易和故障恢复测试；增加OLED无变化不发送、RFID短帧超时恢复、BLE队列有界/不交错、USB逐行边界与超时、日志快照分页、双端争用同一等待任务、小程序重复渲染和生命周期、PC演示/导出/设置与响应布局测试。

# VoxMind

**4G 联网的随身 AI 语音终端。说完即办：边说边识别意图，屏幕弹确认卡片，一键在飞书里建任务。**

---

## 现在到哪一步了

| 部分 | 状态 |
|---|---|
| **PCB** | ✅ **EVT_V1 布线完成** — 100×55mm 四层，DRC 连接错误 0 / 间距违规 0 |
| **制造文件** | ✅ **已导出并验证** — Gerber / 钻孔 / 坐标 / BOM / PDF / Altium 存档 |
| **实板** | 🟡 EVT v9 已到货，待 15P 屏线到货后完成 bring-up |
| **固件** | 🟡 首板自检与云端联调固件均已编译发布；PCM 持续录音、本地原子落盘、Wi-Fi/HTTPS 补传已实现，Opus、4G PPP 与卡片 UI 待实板迭代 |
| **云端** | 🟢 已部署 HTTPS：PostgreSQL、音频持久化/回放、OpenRouter 意图、动作策略/队列、飞书 OAuth、Webhook/HA 连接器与每日备份均已实现；ASR 凭据待配置 |
| **屏幕** | 🟡 微雪 2inch Capacitive Touch LCD 已到，15P 连接线待到货实测 |

---

## 目录

```
docs/
  10_硬件接线真值表.md    v8 历史真值，v9 以交付指南更正表为准
  12_云端架构.md          旧架构，仅用于理解现有代码
  13_首板Bringup清单.md   v8 历史清单，勿直接用于 v9
  20_VoxMind_开放平台产品与技术架构_v1.md  ★ 当前产品与技术主方案
交付/
  VoxMind_v9_到货采购装配与开发完全指南_20260830.md  ★ v9 实板验收唯一主指南
firmware/                 ESP-IDF，ESP32-S3-WROOM-1-N16R8
  components/board/       board.h ← 自动生成，勿手改
  main/bringup.c          首板自检
  tools/gen_board_h.py    改板后重跑
cloud/                    TypeScript / Node 20+
  src/domain.ts           当前持久化领域契约
  src/intent/             Anthropic + OpenAI-compatible 意图适配层
  web/                    已部署的控制台与实板配置入口
deploy/                   Docker Compose、Caddy、安全头与备份
firmware/releases/        ★ 可直接烧录的 bring-up / cloud-lab 二进制
制造文件_v9_20260830/      ← 当前实板对应的制造文件
VoxMind_交接包_20260824/   产品需求与设计文档
.easyeda/an/              自研 PCB 布线与校验工具链
```

---

## 四个会烧掉一整天的硬件坑

写固件前**务必**读 `交付/VoxMind_v9_到货采购装配与开发完全指南_20260830.md`
的更正表；`docs/10_*` 与 `docs/13_*` 是 v8 历史资料。这里仅列仍适用的四个标题：

1. **`MODEM_RXD` 的网名是 MCU 视角** —— GPIO15 是 ESP32 的 **RX**、GPIO16 是 **TX**（接反没有任何报错）
2. **PWRKEY 经 Q2 反相** —— GPIO 拉**高**才是开机，写成拉低现象是"完全没反应"
3. **`MODEM_RESET_N` 没接 GPIO** —— 模组死机只能靠 PWRKEY 长按 12 秒
4. **IO45 是 VDD_SPI 选压脚** —— 上电被拉高会让 flash 供电变 1.8V，直接启动失败

还有一条在 `docs/13_首板Bringup清单.md` 里：
**J1 是 3 脚电池座，必须用带 NTC 的三线电池**，否则充电芯片拒绝充电。

---

## 下单

`制造文件_20260826/VoxMind_EVT_V1_Gerber.zip` 可直接上传嘉立创。

已验证：板框 100.00×55.00mm 零偏差 / 过孔 310 个与设计一致 /
最小线宽 5.00mil、最小钻孔 0.2997mm、最小环宽 3.95mil 全部在四层板标准工艺内。

> **下单必须人工确认，不得自动点击付款。**

## 已部署控制台

访问 <https://EXAMPLE-DEMO-HOST.invalid>。管理密钥不会写入网页源码，只存于当前浏览器；实板设备密钥可在“连接设置 → 实板 Wi-Fi 联调”中生成串口配置行。

当前生产执行保持 `mock`，因此可以安全测试“文字/语音 → AI 意图 → 策略 → 卡片 → 回执”而不会误建真实飞书数据。完成网页飞书授权并做一条人工确认的测试任务后，再切换 `live`。

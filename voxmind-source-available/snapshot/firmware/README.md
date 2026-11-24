# VoxMind 固件

ESP32-S3-WROOM-1-N16R8 ｜ ESP-IDF v5.2+

## 快速开始

```bash
. $IDF_PATH/export.sh
idf.py set-target esp32s3
idf.py build
idf.py -p /dev/cu.usbmodem* flash monitor
```

仓库默认编译首板自检模式。已构建的自检版和“持续录音 + Wi-Fi 云端联调”版在 `releases/`；先烧自检版确认电源、存储、麦克风和 4G，再烧云端联调版。云端联调版可从 Web 控制台复制一行串口配置，不需要把 Wi-Fi 密码提交到源码。

烧录接 **J8**（6P GH1.25）：`1=3V3 2=GND 3=TXD0 4=RXD0 5=EN 6=IO0`
也可以直接插 USB-C（GPIO19/20 是原生 USB，支持 USB-Serial-JTAG 免转接烧录）。

## 目录

```
components/
  board/          ← board.h：引脚定义的唯一真源，【自动生成，勿手改】
  drv_modem/      ML307C-GC（⚠ PWRKEY 反相、串口网名是 MCU 视角：GPIO15=RX GPIO16=TX）
  drv_audio/      双 PDM 麦克风（⚠ 必须配立体声）
  drv_storage/    SD NAND（走 SD 2.0 协议，用 sdspi，和 MicroSD 代码一样）
  drv_power/      MAX17048 电量计
  drv_input/      三键 + 深睡眠唤醒
  drv_feedback/   WS2812 + 振动马达
  drv_display/    微雪 2inch Capacitive Touch LCD（当前骨架只做了背光，显示/触摸待移植）
main/
  main.c          状态机（v3 需求 §三）
  bringup.c       首板自检 —— 板子回来先跑这个
tools/
  gen_board_h.py  从 PCB 网表重新生成 board.h
```

## 改板之后

**不要手改 `board.h`**，重新生成：

```bash
easyeda pcb dump --project VoxMind_EVT_V1 > /tmp/board.json
python3 tools/gen_board_h.py /tmp/board.json > components/board/include/board.h
```

## 写驱动前必读

`docs/10_硬件接线真值表.md` 的「零、四个会让你烧掉一整天的坑」。
尤其是 **MODEM_RXD/TXD 的网名是 MCU 视角（GPIO15=RX、GPIO16=TX）** 和 **PWRKEY 经三极管反相** 这两条。
（2026-08-29 更正：旧版这条写反了，并带进了 board.h，现已改正。）

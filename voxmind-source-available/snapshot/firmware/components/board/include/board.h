// ╔══════════════════════════════════════════════════════════════════╗
// ║  board.h —— VoxMind EVT_V1 引脚定义                               ║
// ║  自动生成，请勿手改。改板后重跑 firmware/tools/gen_board_h.py     ║
// ╚══════════════════════════════════════════════════════════════════╝
#pragma once

#define VOXMIND_BOARD_REV   "EVT_V1"
#define VOXMIND_BOARD_SIZE  "100x55mm 4layer"
#define VOXMIND_MCU_MODULE  "ESP32-S3-WROOM-1-N16R8"   // 16MB flash / 8MB PSRAM(八线)

// ── 引脚 ────────────────────────────────────────────────────────────
//  宏名             GPIO   模组脚   网络名
#define PIN_BOOT               0      // 脚27  GPIO0_BOOT         BOOT 拨键 + J8，烧录用
#define PIN_BTN_OK             1      // 脚39  BTN_OK             确认键（按下接地，需内部上拉）
#define PIN_BTN_BACK           2      // 脚38  BTN_BACK           返回键（按下接地，需内部上拉）
#define PIN_BTN_REC            3      // 脚15  BTN_REC            录音键（按下接地，需内部上拉）
#define PIN_MIC_CLK            4      // 脚4   MIC_PDM_CLK        PDM 麦克风时钟（ESP32 输出，经 U7 降到 1.8V）
#define PIN_MIC_DATA           5      // 脚5   MIC_PDM_DATA       PDM 麦克风数据（双麦共用，经 U8 升到 3.3V）
#define PIN_LCD_MOSI           6      // 脚6   LCD_MOSI_MCU       LCD SPI MOSI
#define PIN_LCD_SCLK           7      // 脚7   LCD_SCLK_MCU       LCD SPI SCLK
#define PIN_I2C_SDA            8      // 脚12  I2C_SDA            I2C 总线（触摸屏 + MAX17048 共用）
#define PIN_I2C_SCL            9      // 脚17  I2C_SCL            I2C 总线（触摸屏 + MAX17048 共用）
#define PIN_LCD_CS             10     // 脚18  LCD_CS             LCD 片选
#define PIN_LCD_DC             11     // 脚19  LCD_DC             LCD 数据/命令选择
#define PIN_LCD_RST            12     // 脚20  LCD_RST            LCD 复位（低有效）
#define PIN_LCD_BL             13     // 脚21  LCD_BL_PWM         LCD 背光 PWM
#define PIN_TP_INT             14     // 脚22  TP_INT             触摸屏中断（输入，低有效）
#define PIN_MODEM_RX           15     // 脚8   MODEM_RXD          ESP32 的 RX ← U3脚18 (模组 TXD)
#define PIN_MODEM_TX           16     // 脚9   MODEM_TXD          ESP32 的 TX → U3脚17 (模组 RXD)
#define PIN_MODEM_PWRKEY       17     // 脚10  MODEM_PWRKEY_DRV   ⚠ 经 Q2(NPN) 反相：拉高=PWRKEY 拉低=开机
#define PIN_MODEM_STATUS       18     // 脚11  MODEM_STATUS       ML307C-GC 电源状态回读（输入）
#define PIN_USB_DM             19     // 脚13  USB_DM_MCU         USB D-（原生 USB，固定 GPIO19）
#define PIN_USB_DP             20     // 脚14  USB_DP_MCU         USB D+（原生 USB，固定 GPIO20）
#define PIN_TP_RST             21     // 脚23  TP_RST             触摸屏复位
#define PIN_SD_SCLK            38     // 脚31  SD_SCLK            SPI NAND 时钟
#define PIN_SD_MOSI            39     // 脚32  SD_MOSI            SPI NAND MOSI（芯片 CMD 脚）
#define PIN_SD_MISO            40     // 脚33  SD_MISO            SPI NAND MISO（芯片 SDD0 脚）
#define PIN_SD_CS              41     // 脚34  SD_CS              SPI NAND 片选
#define PIN_MOTOR_PWM          42     // 脚35  MOTOR_PWM          振动马达 PWM（经 Q1 NMOS，高有效）
#define PIN_UART0_TX           43     // 脚37  UART0_TXD          调试串口 TX（J8 排针）
#define PIN_UART0_RX           44     // 脚36  UART0_RXD          调试串口 RX（J8 排针）
#define PIN_SPARE_45           45     // 脚26  TP_GPIO45          ⚠ 空闲。IO45 是 VDD_SPI 选压脚，严禁外部上拉
#define PIN_SPARE_46           46     // 脚16  TP_GPIO46          ⚠ 空闲。IO46 是 ROM 打印控制脚，严禁外部上拉
#define PIN_LED_DATA           47     // 脚24  LED_DATA           WS2812C 单灯数据线
#define PIN_MODEM_DTR          48     // 脚25  MODEM_DTR          DTR：拉低唤醒模组退出 PSM

// ── 复用/占用说明 ───────────────────────────────────────────────────
//  GPIO0  是 strapping 脚（BOOT 模式）→ 本设计用作 PIN_BOOT
//  GPIO3  是 strapping 脚（JTAG 源选择）→ 本设计用作 PIN_BTN_REC
//  GPIO45 是 strapping 脚（VDD_SPI 选压（上拉会变 1.8V，烧不了 flash））→ 本设计用作 PIN_SPARE_45
//  GPIO46 是 strapping 脚（ROM 日志开关）→ 本设计用作 PIN_SPARE_46
//  GPIO35/36/37 被 N16R8 的八线 PSRAM 内部占用，本设计已避开 ✓

// ── I2C 从机地址 ────────────────────────────────────────────────────
#define I2C_ADDR_FUEL_GAUGE   0x36   // MAX17048
#define I2C_ADDR_TOUCH_HINT   0x00   // 触摸屏型号未定，见 docs/10_硬件接线真值表.md

// ── 电平与极性（写驱动前必读）───────────────────────────────────────
#define MODEM_PWRKEY_ACTIVE   1  // Q2 反相：GPIO 置 1 → PWRKEY 被拉低 → 模组开机
#define MODEM_PWRKEY_HOLD_MS  1500
#define MOTOR_ACTIVE          1  // Q1 是 NMOS，GPIO 置 1 → 马达转
#define BTN_ACTIVE            0  // 按键按下接地，需 GPIO 内部上拉
#define LCD_RST_ACTIVE        0

// 生成于 PCB dump，器件 104 个，网络 76 条

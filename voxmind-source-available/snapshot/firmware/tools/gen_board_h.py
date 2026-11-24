#!/usr/bin/env python3
"""从 EasyEDA 的 PCB dump 生成 board.h —— 引脚定义的唯一真源。

用法:
    easyeda pcb dump --project VoxMind_EVT_V1 > board_dump.json
    python3 gen_board_h.py board_dump.json > ../components/board/include/board.h

为什么要自动生成：手抄 49 个引脚必然出错，而引脚错了要烧板才发现。
改板之后重跑一次这个脚本，board.h 自动跟着更新。
"""
import json, sys, re
from collections import defaultdict

# ESP32-S3-WROOM-1 模组引脚 → 芯片 GPIO
# 来源：ESP32-S3-WROOM-1/1U Datasheet v1.3 表 3「Pin Definitions」
# 注意 28~30 脚(IO35/36/37)在 N16R8(八线 PSRAM)上被内部占用，不可外用——本设计已避开。
WROOM1_PIN2GPIO = {
     1:('GND',None),      2:('3V3',None),     3:('EN',None),
     4:('IO4',4),         5:('IO5',5),        6:('IO6',6),        7:('IO7',7),
     8:('IO15',15),       9:('IO16',16),     10:('IO17',17),     11:('IO18',18),
    12:('IO8',8),        13:('IO19',19),     14:('IO20',20),     15:('IO3',3),
    16:('IO46',46),      17:('IO9',9),       18:('IO10',10),     19:('IO11',11),
    20:('IO12',12),      21:('IO13',13),     22:('IO14',14),     23:('IO21',21),
    24:('IO47',47),      25:('IO48',48),     26:('IO45',45),     27:('IO0',0),
    28:('IO35*',35),     29:('IO36*',36),    30:('IO37*',37),    # * = N16R8 内部占用
    31:('IO38',38),      32:('IO39',39),     33:('IO40',40),     34:('IO41',41),
    35:('IO42',42),      36:('RXD0/IO44',44),37:('TXD0/IO43',43),
    38:('IO2',2),        39:('IO1',1),       40:('GND',None),    41:('GND',None),
}

# 网络名 → C 宏名。宏名统一成 **ESP32 视角**。
#
# ⚠ 2026-08-29 更正：MODEM_RXD / MODEM_TXD 的网名是 **MCU 视角**，不是模组视角。
#    实测（活原理图读模组符号的脚名 + 网表）：
#        MODEM_RXD = U2脚8(GPIO15) ←→ U3脚18 = 模组的 TXD（ML307C叫 UART0_TXD / Air780E叫 MAIN_TXD）
#        MODEM_TXD = U2脚9(GPIO16) ←→ U3脚17 = 模组的 RXD（ML307C叫 UART0_RXD / Air780E叫 MAIN_RXD）
#    所以 GPIO15 是 ESP32 的 RX、GPIO16 是 ESP32 的 TX。
#    之前这里写反了（把网名当成模组视角去翻译），会导致 4G 串口完全不通且无任何报错。
NET2MACRO = {
    'MIC_PDM_CLK':      ('PIN_MIC_CLK',       'PDM 麦克风时钟（ESP32 输出，经 U7 降到 1.8V）'),
    'MIC_PDM_DATA':     ('PIN_MIC_DATA',      'PDM 麦克风数据（双麦共用，经 U8 升到 3.3V）'),
    'LCD_MOSI_MCU':     ('PIN_LCD_MOSI',      'LCD SPI MOSI'),
    'LCD_SCLK_MCU':     ('PIN_LCD_SCLK',      'LCD SPI SCLK'),
    'LCD_CS':           ('PIN_LCD_CS',        'LCD 片选'),
    'LCD_DC':           ('PIN_LCD_DC',        'LCD 数据/命令选择'),
    'LCD_RST':          ('PIN_LCD_RST',       'LCD 复位（低有效）'),
    'LCD_BL_PWM':       ('PIN_LCD_BL',        'LCD 背光 PWM'),
    'MODEM_RXD':        ('PIN_MODEM_RX',      'ESP32 的 RX ← U3脚18(模组 TXD)'),
    'MODEM_TXD':        ('PIN_MODEM_TX',      'ESP32 的 TX → U3脚17(模组 RXD)'),
    'MODEM_PWRKEY_DRV': ('PIN_MODEM_PWRKEY',  '⚠ 经 Q2(NPN) 反相：拉高=PWRKEY 拉低=开机'),
    'MODEM_STATUS':     ('PIN_MODEM_STATUS',  'ML307C-GC 电源状态回读（输入）'),
    'MODEM_DTR':        ('PIN_MODEM_DTR',     'DTR：拉低唤醒模组退出 PSM'),
    'I2C_SDA':          ('PIN_I2C_SDA',       'I2C 总线（触摸屏 + MAX17048 共用）'),
    'I2C_SCL':          ('PIN_I2C_SCL',       'I2C 总线（触摸屏 + MAX17048 共用）'),
    'TP_INT':           ('PIN_TP_INT',        '触摸屏中断（输入，低有效）'),
    'TP_RST':           ('PIN_TP_RST',        '触摸屏复位'),
    'SD_SCLK':          ('PIN_SD_SCLK',       'SPI NAND 时钟'),
    'SD_MOSI':          ('PIN_SD_MOSI',       'SPI NAND MOSI（芯片 CMD 脚）'),
    'SD_MISO':          ('PIN_SD_MISO',       'SPI NAND MISO（芯片 SDD0 脚）'),
    'SD_CS':            ('PIN_SD_CS',         'SPI NAND 片选'),
    'BTN_REC':          ('PIN_BTN_REC',       '录音键（按下接地，需内部上拉）'),
    'BTN_OK':           ('PIN_BTN_OK',        '确认键（按下接地，需内部上拉）'),
    'BTN_BACK':         ('PIN_BTN_BACK',      '返回键（按下接地，需内部上拉）'),
    'LED_DATA':         ('PIN_LED_DATA',      'WS2812C 单灯数据线'),
    'MOTOR_PWM':        ('PIN_MOTOR_PWM',     '振动马达 PWM（经 Q1 NMOS，高有效）'),
    'USB_DM_MCU':       ('PIN_USB_DM',        'USB D-（原生 USB，固定 GPIO19）'),
    'USB_DP_MCU':       ('PIN_USB_DP',        'USB D+（原生 USB，固定 GPIO20）'),
    'UART0_TXD':        ('PIN_UART0_TX',      '调试串口 TX（J8 排针）'),
    'UART0_RXD':        ('PIN_UART0_RX',      '调试串口 RX（J8 排针）'),
    'GPIO0_BOOT':       ('PIN_BOOT',          'BOOT 拨键 + J8，烧录用'),
    'TP_GPIO45':        ('PIN_SPARE_45',      '⚠ 空闲。IO45 是 VDD_SPI 选压脚，严禁外部上拉'),
    'TP_GPIO46':        ('PIN_SPARE_46',      '⚠ 空闲。IO46 是 ROM 打印控制脚，严禁外部上拉'),
}

STRAPPING = {0:'BOOT 模式', 3:'JTAG 源选择', 45:'VDD_SPI 选压（上拉会变 1.8V，烧不了 flash）', 46:'ROM 日志开关'}

def main(path):
    b = json.load(open(path))
    comp = {c['designator']: c for c in b['components']}
    u2 = comp['U2']
    rows = []
    for p in u2['pads']:
        num = p['padNumber']
        if not num.isdigit(): continue
        net = p.get('net') or ''
        if not net or net in ('GND', '+3V3'): continue
        modpin = int(num)
        name, gpio = WROOM1_PIN2GPIO.get(modpin, ('?', None))
        if gpio is None: continue
        rows.append((modpin, gpio, name, net))
    rows.sort(key=lambda r: r[1])

    net2pins = defaultdict(list)
    for c in b['components']:
        for q in c['pads']:
            if q.get('net'): net2pins[q['net']].append(f"{c['designator']}_{q['padNumber']}")

    out = []
    W = out.append
    W('// ╔══════════════════════════════════════════════════════════════════╗')
    W('// ║  board.h —— VoxMind EVT_V1 引脚定义                               ║')
    W('// ║  自动生成，请勿手改。改板后重跑 firmware/tools/gen_board_h.py     ║')
    W('// ╚══════════════════════════════════════════════════════════════════╝')
    W('#pragma once')
    W('')
    W('#define VOXMIND_BOARD_REV   "EVT_V1"')
    W('#define VOXMIND_BOARD_SIZE  "100x55mm 4layer"')
    W('#define VOXMIND_MCU_MODULE  "ESP32-S3-WROOM-1-N16R8"   // 16MB flash / 8MB PSRAM(八线)')
    W('')
    W('// ── 引脚 ────────────────────────────────────────────────────────────')
    W('//  宏名             GPIO   模组脚   网络名')
    for modpin, gpio, name, net in rows:
        macro, note = NET2MACRO.get(net, (f'PIN_{net}', ''))
        W(f'#define {macro:<22s} {gpio:<6d} // 脚{modpin:<3d} {net:<18s} {note}')
    W('')
    W('// ── 复用/占用说明 ───────────────────────────────────────────────────')
    for gpio, why in sorted(STRAPPING.items()):
        used = [r for r in rows if r[1] == gpio]
        tag = NET2MACRO.get(used[0][3], ('?',''))[0] if used else '(未用)'
        W(f'//  GPIO{gpio:<2d} 是 strapping 脚（{why}）→ 本设计用作 {tag}')
    W('//  GPIO35/36/37 被 N16R8 的八线 PSRAM 内部占用，本设计已避开 ✓')
    W('')
    W('// ── I2C 从机地址 ────────────────────────────────────────────────────')
    W('#define I2C_ADDR_FUEL_GAUGE   0x36   // MAX17048')
    W('#define I2C_ADDR_TOUCH_HINT   0x00   // 触摸屏型号未定，见 docs/10_硬件接线真值表.md')
    W('')
    W('// ── 电平与极性（写驱动前必读）───────────────────────────────────────')
    W('#define MODEM_PWRKEY_ACTIVE   1  // Q2 反相：GPIO 置 1 → PWRKEY 被拉低 → 模组开机')
    W('#define MODEM_PWRKEY_HOLD_MS  1500')
    W('#define MOTOR_ACTIVE          1  // Q1 是 NMOS，GPIO 置 1 → 马达转')
    W('#define BTN_ACTIVE            0  // 按键按下接地，需 GPIO 内部上拉')
    W('#define LCD_RST_ACTIVE        0')
    W('')
    W(f'// 生成于 PCB dump，器件 {len(comp)} 个，网络 {len(net2pins)} 条')
    return '\n'.join(out)

if __name__ == '__main__':
    print(main(sys.argv[1] if len(sys.argv) > 1 else 'board_dump.json'))

#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "driver/i2c_master.h"

/* 电量计 MAX17048（I2C 0x36），与触摸屏共用一条 I2C。
 *
 * ⚠ EVT 已知硬件限制（真值表 §2.3）：
 *   CHG_PGOOD 和 USB VBUS 原板都【没有接到 GPIO】，软件读不到"是否在充电"。
 *   对策：用 SOC/电压的上升趋势推断。
 *   改线后（docs/32 改线 B：R3 的 CHG_PGOOD 端飞线到 J8 脚 4 = GPIO44）可以直接读
 *   "USB 有没有插着"，见 power_usb_present()。
 */

typedef struct {
    float    voltage_v;     /* 电池电压 */
    float    soc_pct;       /* 剩余电量 0~100 */
    float    crate_pct_h;   /* 充放电速率 %/小时，正=充电 —— 这是推断充电状态的依据 */
    bool     charging;      /* 由 crate 推断，非硬件直读 */
} power_status_t;

esp_err_t power_init(void);
esp_err_t power_read(power_status_t *out);

/* 电池首次接入或深度放电后，SOC 会不准。调一次快速校准。
 * 它按"此刻"的电压重估电量：插着充电器时调会估高，大负载时调会估低，只在没插电时调。*/
esp_err_t power_quick_start(void);

/* 电量计刚上过电（STATUS.RI=1）：电池被放空过或拔过，之前算的电量全丢了，
 * 现在的数是上电那一刻凭电压猜的。读到后用 power_clear_reset_flag() 清掉，下次就不再报。*/
esp_err_t power_gauge_was_reset(bool *reset);
esp_err_t power_clear_reset_flag(void);

/* USB 有没有插着（BQ24074 /PGOOD，低=有输入电源）。
 * 1=插着，0=没插，-1=不知道（没做改线 B：这根脚悬空，读不出区别）。
 * 第一次读到"插着"就知道改线做了（存 NVS），之后"高"才算可信的"没插"。*/
int power_usb_present(void);

/* 屏幕触摸控制器与电量计共用 I2C0；其它驱动必须复用该句柄。 */
i2c_master_bus_handle_t power_get_i2c_bus(void);

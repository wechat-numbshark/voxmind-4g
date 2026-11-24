#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "driver/i2c_master.h"

/* 电量计 MAX17048（I2C 0x36），与触摸屏共用一条 I2C。
 *
 * ⚠ EVT 已知硬件限制（真值表 §2.3）：
 *   CHG_PGOOD 和 USB VBUS 都【没有接到 GPIO】，软件读不到"是否在充电"。
 *   对策：用 SOC/电压的上升趋势推断。DVT 改板建议补一根线。
 */

typedef struct {
    float    voltage_v;     /* 电池电压 */
    float    soc_pct;       /* 剩余电量 0~100 */
    float    crate_pct_h;   /* 充放电速率 %/小时，正=充电 —— 这是推断充电状态的依据 */
    bool     charging;      /* 由 crate 推断，非硬件直读 */
} power_status_t;

esp_err_t power_init(void);
esp_err_t power_read(power_status_t *out);

/* 电池首次接入或深度放电后，SOC 会不准。调一次快速校准。*/
esp_err_t power_quick_start(void);

/* 屏幕触摸控制器与电量计共用 I2C0；其它驱动必须复用该句柄。 */
i2c_master_bus_handle_t power_get_i2c_bus(void);

#include <string.h>
#include "drv_power.h"
#include "board.h"
#include "driver/i2c_master.h"
#include "esp_log.h"
#include "driver/gpio.h"
#include "nvs.h"

static const char *TAG = "power";
static i2c_master_bus_handle_t s_bus = NULL;
static i2c_master_dev_handle_t s_gauge = NULL;

#define REG_VCELL   0x02
#define REG_SOC     0x04
#define REG_MODE    0x06
#define REG_CRATE   0x16
#define REG_STATUS  0x1A
#define STATUS_RI   0x0100   /* 寄存器高字节 bit0：上电复位过 */

/* 改线 B：/PGOOD 飞线到 GPIO44（J8 脚 4，原 UART0 RX，控制台走 USB，没人用它）。
 * R3 100kΩ 上拉到 3V3，USB 插着时 BQ24074 把它拉低。*/
#define PIN_CHG_PGOOD 44
static int8_t s_pgood_wired = -1;     /* -1 还没读 NVS，0 没见过低电平，1 已确认接了线 */

/* 充电判据：MAX17048 的 CRATE 是有符号量，正=在充。
 * 阈值取 +0.5%/h，避开静置时的噪声。*/
#define CHARGING_THRESHOLD_PCT_H   0.5f

static esp_err_t rd16(uint8_t reg, uint16_t *val)
{
    uint8_t rx[2];
    esp_err_t e = i2c_master_transmit_receive(s_gauge, &reg, 1, rx, 2, 200);
    if (e == ESP_OK) *val = ((uint16_t)rx[0] << 8) | rx[1];
    return e;
}

esp_err_t power_init(void)
{
    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = PIN_I2C_SDA,
        .scl_io_num = PIN_I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,   /* 板上若已有外部上拉，这里可关 */
    };
    ESP_ERROR_CHECK(i2c_new_master_bus(&bus_cfg, &s_bus));

    i2c_device_config_t dev = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address  = I2C_ADDR_FUEL_GAUGE,
        .scl_speed_hz    = 400000,
    };
    ESP_ERROR_CHECK(i2c_master_bus_add_device(s_bus, &dev, &s_gauge));
    gpio_config_t pg = { .pin_bit_mask = 1ULL << PIN_CHG_PGOOD, .mode = GPIO_MODE_INPUT,
                         .pull_up_en = GPIO_PULLUP_ENABLE };   /* 没接线时也别悬空乱跳 */
    gpio_config(&pg);
    ESP_LOGI(TAG, "MAX17048 就绪 @0x%02X (SDA=GPIO%d SCL=GPIO%d)",
             I2C_ADDR_FUEL_GAUGE, PIN_I2C_SDA, PIN_I2C_SCL);
    return ESP_OK;
}

/* 触摸屏驱动要复用这条总线，把句柄暴露出去，避免重复初始化 I2C */
i2c_master_bus_handle_t power_get_i2c_bus(void) { return s_bus; }

esp_err_t power_read(power_status_t *out)
{
    if (!out) return ESP_ERR_INVALID_ARG;
    uint16_t v, s, c;
    if (rd16(REG_VCELL, &v) != ESP_OK) return ESP_FAIL;
    if (rd16(REG_SOC,   &s) != ESP_OK) return ESP_FAIL;
    if (rd16(REG_CRATE, &c) != ESP_OK) return ESP_FAIL;

    out->voltage_v   = v * 78.125e-6f;              /* 78.125 µV/LSB */
    out->soc_pct     = s / 256.0f;                  /* 1/256 %/LSB   */
    out->crate_pct_h = (int16_t)c * 0.208f;         /* 0.208 %/h/LSB，有符号 */
    out->charging    = out->crate_pct_h > CHARGING_THRESHOLD_PCT_H;
    return ESP_OK;
}

esp_err_t power_quick_start(void)
{
    uint8_t tx[3] = { REG_MODE, 0x40, 0x00 };
    return i2c_master_transmit(s_gauge, tx, 3, 200);
}

static esp_err_t wr16(uint8_t reg, uint16_t val)
{
    uint8_t tx[3] = { reg, (uint8_t)(val >> 8), (uint8_t)val };
    return i2c_master_transmit(s_gauge, tx, 3, 200);
}

esp_err_t power_gauge_was_reset(bool *reset)
{
    uint16_t st;
    esp_err_t e = rd16(REG_STATUS, &st);
    if (e == ESP_OK) *reset = (st & STATUS_RI) != 0;
    return e;
}

esp_err_t power_clear_reset_flag(void)
{
    uint16_t st;
    esp_err_t e = rd16(REG_STATUS, &st);
    return e == ESP_OK ? wr16(REG_STATUS, st & (uint16_t)~STATUS_RI) : e;
}

int power_usb_present(void)
{
    if (s_pgood_wired < 0) {
        uint8_t v = 0;
        nvs_handle_t h;
        if (nvs_open("voxmind", NVS_READONLY, &h) == ESP_OK) { nvs_get_u8(h, "pgood_wired", &v); nvs_close(h); }
        s_pgood_wired = v ? 1 : 0;
    }
    bool low = gpio_get_level(PIN_CHG_PGOOD) == 0;
    if (low && !s_pgood_wired) {
        s_pgood_wired = 1;
        nvs_handle_t h;
        if (nvs_open("voxmind", NVS_READWRITE, &h) == ESP_OK) { nvs_set_u8(h, "pgood_wired", 1); nvs_commit(h); nvs_close(h); }
        ESP_LOGI(TAG, "读到 /PGOOD 低：改线 B 已接，之后用它判断 USB 插拔");
    }
    if (low) return 1;
    return s_pgood_wired ? 0 : -1;
}

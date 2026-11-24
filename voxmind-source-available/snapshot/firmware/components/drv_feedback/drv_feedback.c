#include "drv_feedback.h"

#include <math.h>
#include "board.h"
#include "driver/gpio.h"
#include "driver/rmt_encoder.h"
#include "driver/rmt_tx.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"

static const char *TAG = "feedback";
static rmt_channel_handle_t s_rmt;
static rmt_encoder_handle_t s_enc;
static TaskHandle_t s_led_task;
static volatile led_pattern_t s_pattern = LED_OFF;
static volatile led_mode_t s_mode = LED_MODE_DESIGNED;
static volatile bool s_flash_ok;

/* 这颗灯贴在身上、离眼睛近：满亮度刺眼，也费电（WS2812 全白约 60mA）。
 * 所有颜色都按 1/8 亮度给，实测足够在室内看清。*/
#define BRIGHT 32

typedef struct { uint8_t r, g, b; } rgb_t;
typedef enum { STEADY, BREATHE, BLINK_SLOW, BLINK_FAST } rhythm_t;

static const struct { rgb_t color; rhythm_t rhythm; } LOOK[] = {
    [LED_OFF]           = {{0, 0, 0},                    STEADY},
    [LED_STANDBY]       = {{0, BRIGHT, BRIGHT / 4},      STEADY},
    [LED_RECORDING]     = {{BRIGHT, 0, BRIGHT / 16},     BREATHE},
    [LED_OFFLINE_CACHE] = {{BRIGHT, BRIGHT * 3 / 4, 0},  BLINK_SLOW},
    [LED_UPLOADING]     = {{0, BRIGHT / 4, BRIGHT},      BLINK_FAST},
    [LED_AWAIT_WINDOW]  = {{0, BRIGHT / 4, BRIGHT},      STEADY},
    [LED_PENDING]       = {{0, BRIGHT / 4, BRIGHT},      BREATHE},
    [LED_OK_FLASH]      = {{0, BRIGHT, BRIGHT / 4},      BLINK_FAST},
    [LED_CHARGING]      = {{BRIGHT, BRIGHT / 3, 0},      BREATHE},
};

static void write_rgb(rgb_t c)
{
    uint8_t grb[3] = { c.g, c.r, c.b };   /* WS2812 的字节序是 G-R-B */
    rmt_transmit_config_t cfg = { .loop_count = 0 };
    if (rmt_transmit(s_rmt, s_enc, grb, sizeof(grb), &cfg) == ESP_OK)
        /* 发 24 位本身只要 30µs；等得久是因为写 flash 时 RMT 中断会被挂起，给足余量 */
        rmt_tx_wait_all_done(s_rmt, pdMS_TO_TICKS(200));
}

static rgb_t scale(rgb_t c, uint32_t level /* 0..255 */)
{
    return (rgb_t){ (uint8_t)(c.r * level / 255), (uint8_t)(c.g * level / 255), (uint8_t)(c.b * level / 255) };
}

/* 灯效任务。静态状态写一次就睡，直到状态变化被通知；只有呼吸/闪烁时才 25Hz 跑，
 * 而且一帧只发 24 位数据，CPU 开销可以忽略。*/
static void led_task(void *arg)
{
    led_pattern_t shown = (led_pattern_t)-1;
    uint32_t t = 0;
    for (;;) {
        led_pattern_t p = s_pattern;
        if (s_mode == LED_MODE_OFF) p = LED_OFF;
        else if (s_mode == LED_MODE_DARK_WHILE_RECORDING && p == LED_RECORDING) p = LED_OFF;

        if (s_flash_ok && s_mode != LED_MODE_OFF) {
            s_flash_ok = false;
            for (int i = 0; i < 2; ++i) {                 /* 绿闪两下 */
                write_rgb(LOOK[LED_OK_FLASH].color); vTaskDelay(pdMS_TO_TICKS(120));
                write_rgb((rgb_t){0, 0, 0});          vTaskDelay(pdMS_TO_TICKS(120));
            }
            shown = (led_pattern_t)-1;
            continue;
        }

        rhythm_t rhythm = LOOK[p].rhythm;
        if (rhythm == STEADY) {
            if (p != shown) { write_rgb(LOOK[p].color); shown = p; }
            ulTaskNotifyTake(pdTRUE, portMAX_DELAY);       /* 静态：等下一次变化 */
            continue;
        }
        shown = p;
        uint32_t level;
        if (rhythm == BREATHE) {
            /* 2.4 秒一个呼吸周期，余弦缓动；最暗不到 0，免得看起来像灭了 */
            float phase = (float)(t % 60) / 60.0f;
            level = (uint32_t)(40 + 215 * (0.5f - 0.5f * cosf(phase * 2 * (float)M_PI)));
        } else if (rhythm == BLINK_SLOW) {
            level = (t % 50) < 5 ? 255 : 0;                /* 2 秒闪一下 */
        } else {
            level = (t % 10) < 5 ? 255 : 0;                /* 0.4 秒一次 */
        }
        write_rgb(scale(LOOK[p].color, level));
        ++t;
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(40));       /* 25Hz，状态变了立刻醒 */
    }
}

esp_err_t feedback_init(void)
{
    if (s_led_task) return ESP_OK;
    gpio_config_t m = { .pin_bit_mask = 1ULL << PIN_MOTOR_PWM, .mode = GPIO_MODE_OUTPUT };
    ESP_ERROR_CHECK(gpio_config(&m));
    gpio_set_level(PIN_MOTOR_PWM, !MOTOR_ACTIVE);

    rmt_tx_channel_config_t tx = {
        .gpio_num = PIN_LED_DATA,
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 10 * 1000 * 1000,   /* 10MHz → 0.1µs/tick */
        .mem_block_symbols = 64,
        .trans_queue_depth = 2,
    };
    ESP_ERROR_CHECK(rmt_new_tx_channel(&tx, &s_rmt));
    /* WS2812 时序（数据手册）：0 码 高0.3µs/低0.9µs，1 码 高0.9µs/低0.3µs。
     * WS2812C-2020 在 3.3V 下 VIH≈2.31V，ESP32 直驱满足，不需要电平转换。*/
    rmt_bytes_encoder_config_t enc = {
        .bit0 = { .level0 = 1, .duration0 = 3, .level1 = 0, .duration1 = 9 },
        .bit1 = { .level0 = 1, .duration0 = 9, .level1 = 0, .duration1 = 3 },
        .flags.msb_first = 1,
    };
    ESP_ERROR_CHECK(rmt_new_bytes_encoder(&enc, &s_enc));
    ESP_ERROR_CHECK(rmt_enable(s_rmt));
    write_rgb((rgb_t){0, 0, 0});
    xTaskCreatePinnedToCore(led_task, "led", 2560, NULL, 2, &s_led_task, 1);
    ESP_LOGI(TAG, "LED=GPIO%d  马达=GPIO%d", PIN_LED_DATA, PIN_MOTOR_PWM);
    return ESP_OK;
}

esp_err_t led_set(led_pattern_t p)
{
    if (p > LED_CHARGING) return ESP_ERR_INVALID_ARG;
    if (s_pattern == p) return ESP_OK;
    s_pattern = p;
    if (s_led_task) xTaskNotifyGive(s_led_task);
    return ESP_OK;
}

void led_flash_ok(void)
{
    s_flash_ok = true;
    if (s_led_task) xTaskNotifyGive(s_led_task);
}

void led_set_mode(led_mode_t mode)
{
    if (s_mode == mode) return;
    s_mode = mode;
    ESP_LOGI(TAG, "指示灯模式 → %s", mode == LED_MODE_OFF ? "全关" : mode == LED_MODE_DARK_WHILE_RECORDING ? "录音时不亮" : "按状态变色");
    if (s_led_task) xTaskNotifyGive(s_led_task);
}

esp_err_t motor_buzz(uint16_t on_ms, uint8_t times)
{
    for (uint8_t i = 0; i < times; i++) {
        gpio_set_level(PIN_MOTOR_PWM, MOTOR_ACTIVE);
        vTaskDelay(pdMS_TO_TICKS(on_ms));
        gpio_set_level(PIN_MOTOR_PWM, !MOTOR_ACTIVE);
        if (i + 1 < times) vTaskDelay(pdMS_TO_TICKS(on_ms));
    }
    return ESP_OK;
}

/* VoxMind 主程序
 *
 * 两种模式，靠 menuconfig 或改这里的宏切换：
 *   BRINGUP —— 首板自检，板子焊回来先跑这个
 *   APP     —— 正常业务状态机（v3 需求 §三）
 */
#include <stdio.h>
#include "board.h"
#include "drv_input.h"
#include "drv_feedback.h"
#include "drv_power.h"
#include "drv_modem.h"
#include "app_cloud.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "nvs_flash.h"
#include "esp_sleep.h"
#include "esp_log.h"

void bringup_run(void);
static const char *TAG = "app";

/* ── 状态机（对应 v3 需求 §三，含离线态）────────────────── */
typedef enum {
    ST_DEEP_SLEEP,      /* ~10µA，REC 键唤醒 */
    ST_HOME,            /* 待机，显示今日 + 待确认数 */
    ST_RECORDING,       /* 录音中，熄屏不停录 */
    ST_OFFLINE_CACHE,   /* 录完没网，数据躺在 NAND */
    ST_UPLOADING,       /* 分块上传，可断点续传 */
    ST_AWAIT_WINDOW,    /* ★ 上传完保持唤醒 30 秒等卡片 —— 少了这个，
                         *   "有网了马上处理"就不成立（4G 进 PSM 后推送会延迟） */
    ST_PENDING,         /* 有待确认卡片，队列可堆积 */
} app_state_t;

#define AWAIT_WINDOW_MS      30000   /* v3 需求 §2.5 T4 */
#define HOME_IDLE_SLEEP_MS   60000   /* 待机 60 秒无操作进深睡眠 */

static app_state_t s_state = ST_HOME;
static QueueHandle_t s_btn_q;

static void enter_deep_sleep(void)
{
    ESP_LOGI(TAG, "进深睡眠。4G 保持 PSM（不断电！冷启动要 5~15 秒，PSM 恢复只要 1~2 秒）");
    led_set(LED_OFF);
    input_arm_wakeup();
    esp_deep_sleep_start();
}

static void app_run(void)
{
    s_btn_q = xQueueCreate(16, sizeof(btn_event_t));
    ESP_ERROR_CHECK(input_init(s_btn_q));
    ESP_ERROR_CHECK(feedback_init());
    ESP_ERROR_CHECK(power_init());
    ESP_ERROR_CHECK(modem_init());

    /* 冷启动才需要开模组；从深睡眠醒来时模组一直在 PSM 里活着 */
    if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_UNDEFINED) {
        modem_power_on(20000);
        modem_psm_enable(3600, 30);      /* TAU=1h / Active=30s，实测后再调 */
    }

    led_set(LED_STANDBY);
    TickType_t idle_since = xTaskGetTickCount();
    btn_event_t ev;

    for (;;) {
        if (xQueueReceive(s_btn_q, &ev, pdMS_TO_TICKS(200)) == pdTRUE) {
            idle_since = xTaskGetTickCount();
            switch (s_state) {
            case ST_HOME:
                if (ev.id == BTN_REC_E && ev.type == BTN_EV_DOWN) {
                    /* v3 要求：按下到开始录音 ≤0.2s，且丢弃前 50ms 瞬态 */
                    s_state = ST_RECORDING;
                    led_set(LED_RECORDING);
                    motor_buzz(80, 1);
                    /* TODO: recorder_start(); */
                } else if (ev.id == BTN_OK_E && ev.type == BTN_EV_CLICK) {
                    /* TODO: 有待确认则进队列，否则进指令速览菜单 */
                }
                break;
            case ST_RECORDING:
                if (ev.id == BTN_REC_E && ev.type == BTN_EV_CLICK) {
                    /* TODO: recorder_stop(); 然后判断有没有网 */
                    s_state = ST_OFFLINE_CACHE;
                    led_set(LED_OFFLINE_CACHE);
                }
                break;
            case ST_PENDING:
                /* v3 §2.3：OK=确认 / BACK=丢弃 / REC=跳过留队列 */
                break;
            default: break;
            }
        }

        if (s_state == ST_HOME &&
            (xTaskGetTickCount() - idle_since) > pdMS_TO_TICKS(HOME_IDLE_SLEEP_MS)) {
            enter_deep_sleep();
        }
    }
}

void app_main(void)
{
    esp_err_t e = nvs_flash_init();
    if (e == ESP_ERR_NVS_NO_FREE_PAGES || e == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }
#if CONFIG_VOXMIND_BRINGUP_MODE
    bringup_run();
    for (;;) vTaskDelay(portMAX_DELAY);
#else
    cloud_app_run();
#endif
}

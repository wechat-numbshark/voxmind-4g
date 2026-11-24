#include "drv_input.h"
#include "board.h"
#include "driver/gpio.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "esp_log.h"

static const char *TAG = "input";
static const int s_pins[BTN_COUNT] = { PIN_BTN_REC, PIN_BTN_OK, PIN_BTN_BACK };
static QueueHandle_t s_q = NULL;
static int64_t s_down_us[BTN_COUNT];
static int64_t s_up_us[BTN_COUNT];
static bool s_pressed[BTN_COUNT];

bool input_is_down(btn_id_t id) { return id < BTN_COUNT && gpio_get_level(s_pins[id]) == BTN_ACTIVE; }

static void IRAM_ATTR isr(void *arg)
{
    btn_id_t id = (btn_id_t)(intptr_t)arg;
    int level = gpio_get_level(s_pins[id]);
    int64_t now = esp_timer_get_time();
    btn_event_t ev = { .id = id };

    BaseType_t hp = pdFALSE;
    /* 按下、松手两头都要防抖。以前只防了「按下后马上弹开」：松手时触点弹回来那一下被当成新的按下，
     * 紧跟着真正的松开又因为离这次「按下」太近被当抖动丢掉——结果驱动以为键一直按着，
     * 「在听」松手了也不结束（2026-10-07 用户实测）。现在记住键的状态：按着时不再发按下，
     * 松开后 50ms 内的「按下」都算弹跳 */
    if (level == BTN_ACTIVE) {                     /* 按下（低电平） */
        if (now - s_up_us[id] < 50000) return;      /* 刚松开，触点在弹 */
        if (s_pressed[id] && now - s_down_us[id] < 50000) return;   /* 按下时的弹跳 */
        s_pressed[id] = true;                      /* 已经按着又来按下＝漏了一次松开，当新的一次 */
        s_down_us[id] = now; ev.type = BTN_EV_DOWN; ev.held_ms = 0;
    } else {
        if (!s_pressed[id]) return;                /* 没按着又来松开：弹跳 */
        uint32_t held = (uint32_t)((now - s_down_us[id]) / 1000);
        if (held < BTN_DEBOUNCE_MS) return;        /* 按下后马上弹开，抖动，丢弃（还算按着） */
        s_pressed[id] = false;
        s_up_us[id] = now;
        /* 松手先发 UP，再发单击/长按。
         * "按住说话"这类功能要的是"手一松就结束"，不能等按够 800ms 才算数；
         * 而确认/取消这些老逻辑照旧看 CLICK。一次松手两个事件，各取所需。*/
        ev.type = BTN_EV_UP; ev.held_ms = held;
        xQueueSendFromISR(s_q, &ev, &hp);
        ev.type = (held >= BTN_LONG_PRESS_MS) ? BTN_EV_LONG : BTN_EV_CLICK;
    }
    xQueueSendFromISR(s_q, &ev, &hp);
    if (hp) portYIELD_FROM_ISR();
}

esp_err_t input_init(QueueHandle_t out_queue)
{
    s_q = out_queue;
    gpio_config_t cfg = {
        .pin_bit_mask = (1ULL << PIN_BTN_REC) | (1ULL << PIN_BTN_OK) | (1ULL << PIN_BTN_BACK),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,          /* 按键接地，必须上拉 */
        .intr_type = GPIO_INTR_ANYEDGE,
    };
    ESP_ERROR_CHECK(gpio_config(&cfg));
    /* 触摸驱动（熄屏靠触摸中断叫醒）可能先装过中断服务：那就直接用，别当错误重启 */
    esp_err_t isr_svc = gpio_install_isr_service(0);
    if (isr_svc != ESP_ERR_INVALID_STATE) ESP_ERROR_CHECK(isr_svc);
    for (int i = 0; i < BTN_COUNT; i++)
        ESP_ERROR_CHECK(gpio_isr_handler_add(s_pins[i], isr, (void *)(intptr_t)i));
    ESP_LOGI(TAG, "三键就绪 REC=%d OK=%d BACK=%d", PIN_BTN_REC, PIN_BTN_OK, PIN_BTN_BACK);
    return ESP_OK;
}

esp_err_t input_arm_wakeup(void)
{
    /* GPIO3 在 RTC 域，可做 ext1 唤醒。按下=低电平，所以用 LOW 触发。*/
    return esp_sleep_enable_ext1_wakeup_io(1ULL << PIN_BTN_REC, ESP_EXT1_WAKEUP_ANY_LOW);
}

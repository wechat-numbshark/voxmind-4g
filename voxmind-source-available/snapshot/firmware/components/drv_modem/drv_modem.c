#include <stdbool.h>
#include <string.h>
#include "drv_modem.h"
#include "board.h"
#include "driver/gpio.h"
#include "driver/uart.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_system.h"

static const char *TAG = "modem";
#define MODEM_UART   UART_NUM_1
#define RX_BUF_SZ    2048

static modem_state_t s_state = MODEM_OFF;
/* ESP32 和模组之间这根串口就是升级慢的瓶颈：115200 的理论上限 11.5KB/s，
 * 实测整包 3.96MB 走了 641 秒＝6.2KB/s（扣掉 PPP/TCP/TLS 开销，正好对得上）。
 * 提到 460800 理论上能快 4 倍。板子上模组的 RTS/CTS 没接到 MCU，没有硬件流控，
 * 所以：不写进模组的永久配置（不发 AT&W），断电重开就回到 115200；
 * 而且开机时两个波特率都探一遍，MCU 单独重启后也能重新对上话。*/
#define MODEM_BAUD_DEFAULT 115200
#define MODEM_BAUD_FAST    460800
static int s_baud = MODEM_BAUD_DEFAULT;

static void use_baud(int baud)
{
    uart_set_baudrate(MODEM_UART, baud);
    uart_flush_input(MODEM_UART);
    s_baud = baud;
}

int modem_uart_baud(void) { return s_baud; }

esp_err_t modem_init(void)
{
    /* 关机前把电源键这根脚钉在"不按"并打开了保持（见 modem_power_off），保持会跨过深睡眠复位
     * 一直留着，不先解开就驱动不了它，模组永远开不了机 */
    gpio_hold_dis(PIN_MODEM_PWRKEY);
    gpio_config_t out = {
        .pin_bit_mask = (1ULL << PIN_MODEM_PWRKEY) | (1ULL << PIN_MODEM_DTR),
        .mode = GPIO_MODE_OUTPUT,
    };
    ESP_ERROR_CHECK(gpio_config(&out));
    /* 上电默认不触发 PWRKEY。因为 Q2 反相，"不触发" = 输出 0。*/
    gpio_set_level(PIN_MODEM_PWRKEY, !MODEM_PWRKEY_ACTIVE);
    /* DTR 低 = 叫醒/不许睡。开机先让它醒着：上次开了休眠的话（MLPMCFG 可能掉电不丢），
     * DTR 高着开机时模组可能睡着，开机这串 AT 就全石沉大海了。联网后由 app_cloud 接管 */
    gpio_set_level(PIN_MODEM_DTR, 0);

    gpio_config_t in = {
        .pin_bit_mask = (1ULL << PIN_MODEM_STATUS),
        .mode = GPIO_MODE_INPUT,
        .pull_down_en = GPIO_PULLDOWN_ENABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&in));

    uart_config_t cfg = {
        .baud_rate = s_baud,
        .data_bits = UART_DATA_8_BITS,
        .parity    = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_ERROR_CHECK(uart_driver_install(MODEM_UART, RX_BUF_SZ, 0, 0, NULL, 0));
    ESP_ERROR_CHECK(uart_param_config(MODEM_UART, &cfg));
    /* 顺序是 (TX, RX)，均为 ESP32 视角：
     *   PIN_MODEM_TX = GPIO16 → U3脚17（模组 RXD）
     *   PIN_MODEM_RX = GPIO15 ← U3脚18（模组 TXD）
     * 网络名 MODEM_TXD / MODEM_RXD 是 MCU 视角命名，board.h 里已按实测对齐。*/
    ESP_ERROR_CHECK(uart_set_pin(MODEM_UART, PIN_MODEM_TX, PIN_MODEM_RX,
                                 UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));

    s_state = gpio_get_level(PIN_MODEM_STATUS) ? MODEM_READY : MODEM_OFF;
    ESP_LOGI(TAG, "init 完成，STATUS=%d", gpio_get_level(PIN_MODEM_STATUS));
    return ESP_OK;
}

static void pwrkey_pulse(uint32_t hold_ms)
{
    gpio_set_level(PIN_MODEM_PWRKEY, MODEM_PWRKEY_ACTIVE);   /* 高 → Q2 导通 → PWRKEY 拉低 */
    vTaskDelay(pdMS_TO_TICKS(hold_ms));
    gpio_set_level(PIN_MODEM_PWRKEY, !MODEM_PWRKEY_ACTIVE);
}

/* 开射频。关机时为了省电用 AT+CFUN=0 关掉了射频（电源键关不掉模组，见 modem_power_off），
 * 模组本身没断电，所以开机必须显式打开，否则永远注册不上网。顺带查一下关机期间射频
 * 是不是真的关着：查到 +CFUN: 0 就说明上次关机那一步生效了。*/
static void radio_on(void)
{
    char resp[96] = "";
    modem_at("AT+CFUN?", "OK", resp, sizeof(resp), 2000);
    bool was_off = strstr(resp, "+CFUN: 0") != NULL;
    if (modem_at("AT+CFUN=1", "OK", NULL, 0, 15000) == ESP_OK)
        ESP_LOGI(TAG, "射频已打开%s", was_off ? "（关机期间是关着的，关机那一步生效了）" : "");
    else
        ESP_LOGE(TAG, "AT+CFUN=1 没成功，可能注册不上网");
}

esp_err_t modem_power_on(uint32_t timeout_ms)
{
    if (gpio_get_level(PIN_MODEM_STATUS)) {
        /* 冷启动（从关机里长按开机）时这里本该是低：如果是高，说明上次关机模组没关掉，
         * 关机那段时间 4G 一直在耗电。MCU 单独重启（OTA、看门狗）时是高属正常。*/
        ESP_LOGW(TAG, "开机时模组本来就开着（复位原因 %d；若是从关机里开机，说明上次没关掉）",
                 (int)esp_reset_reason());
        /* STATUS 高只说明模组电源域没断——PWRKEY 是脉冲不是电平开关，MCU 侧
         * 复位（崩溃/看门狗/手动 reset）并不会让模组跟着断电重开。如果上次
         * MCU 是在 PPP 拨号过程中被复位的，模组会一直停在数据模式甚至基站
         * 侧还在往 UART 上吐残留的 PPP 帧，这时候直接当"已就绪"会导致后面
         * 所有 AT 指令永远超时或收到乱码（实测复现过：+++ 能让 AT 应答恢复，
         * 但紧接着的下一条指令还是会收到二进制垃圾，说明"半恢复"状态不可信）。
         * 所以这里只用 AT 探测判断"要不要重开"，探测失败就不再尝试逃逸，
         * 直接强制断电重开一次，换一个确定干净的状态，宁可多等几十秒。*/
        if (modem_at("AT", "OK", NULL, 0, 500) == ESP_OK) {
            s_state = MODEM_READY;
            radio_on();
            return ESP_OK;
        }
        /* MCU 单独重启（崩溃/看门狗/OTA）时模组没断电，可能还停在上次提速后的波特率。
         * 换另一个波特率再探一次，探到了就不用白白断电重开一次（那要多等二十几秒）。*/
        int other = s_baud == MODEM_BAUD_FAST ? MODEM_BAUD_DEFAULT : MODEM_BAUD_FAST;
        use_baud(other);
        if (modem_at("AT", "OK", NULL, 0, 500) == ESP_OK) {
            ESP_LOGW(TAG, "模组还停在 %d 波特率，已对上", other);
            s_state = MODEM_READY;
            radio_on();
            return ESP_OK;
        }
        use_baud(MODEM_BAUD_DEFAULT);
        ESP_LOGW(TAG, "STATUS=1 但 AT 无响应，模组状态不可信，强制关机重开");
        modem_force_reset();
        vTaskDelay(pdMS_TO_TICKS(2000));
        /* 落到下面走一次完整开机流程 */
    }
    ESP_LOGI(TAG, "开机：PWRKEY 脉冲 %dms", MODEM_PWRKEY_HOLD_MS);
    s_state = MODEM_BOOTING;
    pwrkey_pulse(MODEM_PWRKEY_HOLD_MS);

    /* 按真实经过的时间算超时。以前每轮里 10 次 AT 各等 1 秒，却只给 waited 加 200ms——
     * 模组答不上话时 20 秒的超时实际要等半个多小时，整机就一直"等网络"。
     *
     * AT 在两种波特率之间轮流探：ML307C 的 AT+IPR 会被模组记住，断电重开后可能还是 460800
     * （实测 20260919：OTA 重启 → 强制断电重开 → 只用 115200 探，永远对不上）。*/
    TickType_t start = xTaskGetTickCount();
    while ((xTaskGetTickCount() - start) * portTICK_PERIOD_MS < timeout_ms) {
        if (gpio_get_level(PIN_MODEM_STATUS)) {
            /* STATUS 起来只代表电源域通了，AT 还要再等几秒 */
            for (int i = 0; i < 12; i++) {
                use_baud(i % 2 ? MODEM_BAUD_FAST : MODEM_BAUD_DEFAULT);
                if (modem_at("AT", "OK", NULL, 0, 700) == ESP_OK) {
                    s_state = MODEM_READY;
                    ESP_LOGI(TAG, "开机完成，耗时 %lums，波特率 %d",
                             (unsigned long)((xTaskGetTickCount() - start) * portTICK_PERIOD_MS), s_baud);
                    radio_on();
                    return ESP_OK;
                }
            }
        }
        vTaskDelay(pdMS_TO_TICKS(200));
    }
    use_baud(MODEM_BAUD_DEFAULT);
    s_state = MODEM_FAULT;
    ESP_LOGE(TAG, "开机超时。检查：① GPIO17 是否真拉高了 ② Q2 是否贴反 ③ VBAT_MODEM 供电");
    return ESP_ERR_TIMEOUT;
}

/* 关机前钉住电源键：芯片深睡时这根脚会松开悬空，三极管基极一飘高就等于按住了模组电源键，
 * 按满 1 秒模组又开机了。GPIO17 在 S3 上属于 RTC 域，保持状态深睡眠里一直有效。*/
static void pwrkey_hold_released(void)
{
    gpio_set_level(PIN_MODEM_PWRKEY, !MODEM_PWRKEY_ACTIVE);
    gpio_hold_en(PIN_MODEM_PWRKEY);
}

void modem_prepare_sleep(void) { pwrkey_hold_released(); }

/* 关机：按住电源键不放，盯着 STATUS，一变低立刻松手。
 *
 * 2026-10-01/02 实测：以前按 1.5 秒（和开机一样），松手后等 20 秒 STATUS 还是高；从关机里
 * 冷启动时模组也确实一直开着——关机期间 4G 照样耗电，而且醒来时它已不应答，又得强制
 * 按 12 秒重启，每次开机白等十几秒。手头的 ML307C 资料只有宣传册，没有关机时序，所以不猜
 * 一个按多久：按到它真断电为止，最多 12.5 秒（按 12 秒强制关机在开机流程里验证过管用）。
 * 一断电立刻松手，不会按过头又把它按开。*/
esp_err_t modem_power_off(uint32_t timeout_ms)
{
    if (!gpio_get_level(PIN_MODEM_STATUS)) { s_state = MODEM_OFF; pwrkey_hold_released(); return ESP_OK; }
    uint32_t held = 0, limit = timeout_ms < 12500 ? timeout_ms : 12500;
    gpio_set_level(PIN_MODEM_PWRKEY, MODEM_PWRKEY_ACTIVE);
    while (held < limit && gpio_get_level(PIN_MODEM_STATUS)) { vTaskDelay(pdMS_TO_TICKS(100)); held += 100; }
    gpio_set_level(PIN_MODEM_PWRKEY, !MODEM_PWRKEY_ACTIVE);
    bool off = !gpio_get_level(PIN_MODEM_STATUS);
    pwrkey_hold_released();
    if (off) {
        s_state = MODEM_OFF;
        ESP_LOGW(TAG, "模组已断电：电源键按了 %lu ms STATUS 变低", (unsigned long)held);
        return ESP_OK;
    }
    ESP_LOGE(TAG, "模组没断电：电源键按了 %lu ms STATUS 仍是高", (unsigned long)held);
    return ESP_ERR_TIMEOUT;
}

esp_err_t modem_force_reset(void)
{
    /* RESET 脚没接 GPIO（见真值表坑 3），只能长按 PWRKEY */
    ESP_LOGW(TAG, "强制关机：PWRKEY 拉住 12 秒");
    pwrkey_pulse(12000);
    s_state = MODEM_OFF;
    return ESP_OK;
}

modem_state_t modem_get_state(void) { return s_state; }

esp_err_t modem_at(const char *cmd, const char *expect, char *resp, size_t resp_len, uint32_t timeout_ms)
{
    uart_flush_input(MODEM_UART);
    uart_write_bytes(MODEM_UART, cmd, strlen(cmd));
    uart_write_bytes(MODEM_UART, "\r\n", 2);

    static char buf[RX_BUF_SZ];
    size_t got = 0;
    TickType_t deadline = xTaskGetTickCount() + pdMS_TO_TICKS(timeout_ms);
    while (xTaskGetTickCount() < deadline && got < sizeof(buf) - 1) {
        int n = uart_read_bytes(MODEM_UART, (uint8_t *)buf + got, sizeof(buf) - 1 - got, pdMS_TO_TICKS(50));
        if (n > 0) {
            got += n; buf[got] = 0;
            if (expect && strstr(buf, expect)) {
                if (resp && resp_len) { strncpy(resp, buf, resp_len - 1); resp[resp_len - 1] = 0; }
                return ESP_OK;
            }
            if (strstr(buf, "ERROR")) return ESP_FAIL;
        }
    }
    if (resp && resp_len) { strncpy(resp, buf, resp_len - 1); resp[resp_len - 1] = 0; }
    return ESP_ERR_TIMEOUT;
}

esp_err_t modem_psm_enable(uint32_t tau_sec, uint32_t active_sec)
{
    /* 3GPP T3412(TAU) / T3324(Active) 用的是 8 位编码，不是秒。
     * TODO(bring-up): 按 TS 24.008 §10.5.7.4a 编码。先用 AT+CPSMS 的字符串形式跑通，
     *                 实测待机电流后再调 TAU —— TAU 越长越省电、下行推送延迟越大。*/
    char cmd[96];
    snprintf(cmd, sizeof(cmd), "AT+CPSMS=1,,,\"%s\",\"%s\"",
             "00100001" /* TAU ≈ 1h，占位，需按实测校正 */,
             "00000011" /* Active ≈ 30s，占位 */);
    esp_err_t e = modem_at(cmd, "OK", NULL, 0, 3000);
    if (e == ESP_OK) s_state = MODEM_PSM;
    return e;
}

esp_err_t modem_psm_wake(uint32_t timeout_ms)
{
    gpio_set_level(PIN_MODEM_DTR, 0);           /* DTR 拉低 = 唤醒 */
    vTaskDelay(pdMS_TO_TICKS(50));
    esp_err_t e = ESP_ERR_TIMEOUT;
    uint32_t waited = 0;
    while (waited < timeout_ms) {
        if (modem_at("AT", "OK", NULL, 0, 500) == ESP_OK) { e = ESP_OK; break; }
        vTaskDelay(pdMS_TO_TICKS(100)); waited += 600;
    }
    gpio_set_level(PIN_MODEM_DTR, 1);
    if (e == ESP_OK) { s_state = MODEM_READY; ESP_LOGI(TAG, "PSM 唤醒，耗时 %dms", waited); }
    return e;
}

/* 提速这根串口。失败就把本地改回 115200 并确认还能对话。
 * 注意：实测 ML307C 会记住 AT+IPR，断电重开也不一定回到 115200，所以开机探测两种都要试。*/
esp_err_t modem_set_uart_baud(int baud)
{
    if (baud == s_baud) return ESP_OK;
    char cmd[24];
    snprintf(cmd, sizeof(cmd), "AT+IPR=%d", baud);
    if (modem_at(cmd, "OK", NULL, 0, 1000) != ESP_OK) {
        ESP_LOGW(TAG, "模组不接受 AT+IPR=%d，继续用 %d", baud, s_baud);
        return ESP_ERR_NOT_SUPPORTED;
    }
    int previous = s_baud;
    vTaskDelay(pdMS_TO_TICKS(100));     /* 模组回完 OK 才换，别抢在它前面 */
    use_baud(baud);
    for (int i = 0; i < 3; ++i) {
        if (modem_at("AT", "OK", NULL, 0, 500) == ESP_OK) {
            ESP_LOGI(TAG, "串口已提速到 %d", baud);
            return ESP_OK;
        }
        vTaskDelay(pdMS_TO_TICKS(150));
    }
    ESP_LOGW(TAG, "提速到 %d 之后对不上话，退回 %d", baud, previous);
    use_baud(previous);
    return modem_at("AT", "OK", NULL, 0, 800);
}

esp_err_t modem_release_uart_for_ppp(void)
{
    esp_err_t e = uart_driver_delete(MODEM_UART);
    if (e == ESP_OK) ESP_LOGI(TAG, "已交出 UART%d，esp_modem 可以接管拨号了", MODEM_UART);
    return e;
}

#include "drv_display.h"
#include <math.h>
#include "driver/ledc.h"
#include <stdlib.h>
#include "board.h"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/spi_master.h"
#include "drv_power.h"
#include "esp_check.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_commands.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"

static const char *TAG = "display";
static esp_lcd_panel_handle_t s_panel;
static esp_lcd_panel_io_handle_t s_io;
static i2c_master_dev_handle_t s_touch;
static SemaphoreHandle_t s_draw_done;

static bool draw_done(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *event, void *context)
{
    BaseType_t wake = pdFALSE;
    xSemaphoreGiveFromISR(s_draw_done, &wake);
    return wake == pdTRUE;
}

static esp_err_t draw_wait(int x0, int y0, int x1, int y1, const void *pixels)
{
    ESP_RETURN_ON_ERROR(esp_lcd_panel_draw_bitmap(s_panel, x0, y0, x1, y1, pixels), TAG, "draw submit");
    return xSemaphoreTake(s_draw_done, pdMS_TO_TICKS(2000)) == pdTRUE ? ESP_OK : ESP_ERR_TIMEOUT;
}

/* Ported from Waveshare's 2inch Capacitive Touch LCD ESP32S3 demo,
 * bundled GFX_Library_for_Arduino Arduino_ST7789.h init table.
 * Keep VoxMind board.h GPIOs; the demo's development-board GPIOs differ. */
static esp_err_t waveshare_init(esp_lcd_panel_io_handle_t io)
{
    const struct { uint8_t command, count, data[14]; } commands[] = {
        {0x3a,1,{0x55}}, {0x36,1,{0x00}}, {0xb0,2,{0x00,0xf0}},
        {0xb2,5,{0x0c,0x0c,0x00,0x33,0x33}}, {0xb7,1,{0x35}},
        {0xbb,1,{0x19}}, {0xc0,1,{0x2c}}, {0xc2,1,{0x01}},
        {0xc3,1,{0x12}}, {0xc4,1,{0x20}}, {0xc6,1,{0x0f}},
        {0xd0,2,{0xa4,0xa1}},
        {0xe0,14,{0xf0,0x09,0x13,0x12,0x12,0x2b,0x3c,0x44,0x4b,0x1b,0x18,0x17,0x1d,0x21}},
        {0xe1,14,{0xf0,0x09,0x13,0x0c,0x0d,0x27,0x3b,0x44,0x4d,0x0b,0x17,0x17,0x1d,0x21}},
    };
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, 0x01, NULL, 0), TAG, "software reset");
    vTaskDelay(pdMS_TO_TICKS(120));
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, 0x11, NULL, 0), TAG, "sleep out");
    vTaskDelay(pdMS_TO_TICKS(120));
    for (size_t i = 0; i < sizeof(commands)/sizeof(commands[0]); ++i)
        ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, commands[i].command,
                            commands[i].data, commands[i].count), TAG, "vendor init");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, 0x13, NULL, 0), TAG, "normal on");
    vTaskDelay(pdMS_TO_TICKS(10));
    return ESP_OK;
}

#define LCD_HOST SPI3_HOST
#define LCD_WIDTH 240
#define LCD_HEIGHT 320
#define TOUCH_ADDRESS 0x15

/* esp_lcd_panel_draw_bitmap() 不做任何字节序转换 —— 它只是把 buffer 原样
 * DMA 到 SPI。ESP32-S3 是小端，一个 uint16_t 的 RGB565 在内存里低字节在前；
 * 但 ST7789 在 16bpp 模式下要求每个像素【高字节先发】(D[15:8] 后 D[7:0])。
 * 不转换的后果：颜色被系统性地打乱，而不是花屏噪点——实测：
 * 紫色背景+蓝色确认区块，正是 0x0861/0x771a 字节序颠倒后的样子。
 * 定位过程：从串口读回运行中的板子日志，反推 fill_rect 传入的 RGB565 常量，
 * 按字节颠倒重算 RGB 分量，和照片里的紫块/蓝条颜色吻合，确认根因。*/
static inline uint16_t rgb565_be(uint16_t color) { return (uint16_t)((color << 8) | (color >> 8)); }

static esp_err_t draw_test_pattern(void)
{
    const uint16_t colors[] = {0xf800, 0xfd20, 0xffe0, 0x07e0, 0x07ff, 0x001f, 0xf81f, 0xffff};
    const int band_height = LCD_HEIGHT / (int)(sizeof(colors) / sizeof(colors[0]));
    uint16_t *band = heap_caps_malloc(LCD_WIDTH * band_height * sizeof(uint16_t), MALLOC_CAP_DMA);
    if (!band) return ESP_ERR_NO_MEM;
    esp_err_t result = ESP_OK;
    for (size_t color = 0; color < sizeof(colors) / sizeof(colors[0]); ++color) {
        uint16_t be = rgb565_be(colors[color]);
        for (int i = 0; i < LCD_WIDTH * band_height; ++i) band[i] = be;
        result = draw_wait(0, color * band_height,
                                           LCD_WIDTH, (color + 1) * band_height, band);
        if (result != ESP_OK) break;
    }
    free(band);
    return result;
}

static esp_err_t fill_rect(int x, int y, int width, int height, uint16_t color)
{
    const int rows = 20;
    uint16_t *buffer = heap_caps_malloc(width * rows * sizeof(uint16_t), MALLOC_CAP_DMA);
    if (!buffer) return ESP_ERR_NO_MEM;
    uint16_t be = rgb565_be(color);
    for (int i = 0; i < width * rows; ++i) buffer[i] = be;
    esp_err_t result = ESP_OK;
    for (int top = y; top < y + height; top += rows) {
        int bottom = top + rows < y + height ? top + rows : y + height;
        result = draw_wait(x, top, x + width, bottom, buffer);
        if (result != ESP_OK) break;
    }
    free(buffer);
    return result;
}

esp_err_t display_show_queue(uint32_t pending_count)
{
    if (!s_panel) return ESP_ERR_INVALID_STATE;
    ESP_RETURN_ON_ERROR(fill_rect(0, 0, LCD_WIDTH, LCD_HEIGHT, 0x0861), TAG, "queue background");
    ESP_RETURN_ON_ERROR(fill_rect(0, 272, LCD_WIDTH / 2 - 2, 48, 0xf9e7), TAG, "cancel area");
    ESP_RETURN_ON_ERROR(fill_rect(LCD_WIDTH / 2 + 2, 272, LCD_WIDTH / 2 - 2, 48, 0x771a), TAG, "confirm area");
    uint32_t dots = pending_count > 8 ? 8 : pending_count;
    for (uint32_t i = 0; i < dots; ++i) {
        ESP_RETURN_ON_ERROR(fill_rect(12 + (int)i * 26, 14, 16, 8, i == 0 ? 0x771a : 0x7bef), TAG, "queue dot");
    }
    return ESP_OK;
}

/* 背光调光：LEDC PWM。
 * 频率 25kHz——在人耳和麦克风音频带宽之外。背光电流的 PWM 纹波会串到电源上，
 * 频率落在音频带里的话，录音里能听到啸叫。
 * 亮度按人眼感知做 2.2 次方：滑块拉到 50%，看起来就是一半亮，而不是几乎全亮。*/
esp_err_t display_backlight(uint8_t percent)
{
    static bool inited = false;
    if (!inited) {
        /* 深睡眠前把这根脚钉在了低电平（见 display_power_down），保持状态会跨过深睡眠复位
         * 一直留着——不先解开，LEDC 接管不了这根脚，开机后背光就一直不亮。*/
        gpio_hold_dis(PIN_LCD_BL);
        ledc_timer_config_t timer = {
            .speed_mode = LEDC_LOW_SPEED_MODE, .duty_resolution = LEDC_TIMER_10_BIT,
            .timer_num = LEDC_TIMER_0, .freq_hz = 25000, .clk_cfg = LEDC_AUTO_CLK,
        };
        ESP_RETURN_ON_ERROR(ledc_timer_config(&timer), TAG, "backlight timer");
        ledc_channel_config_t channel = {
            .gpio_num = PIN_LCD_BL, .speed_mode = LEDC_LOW_SPEED_MODE, .channel = LEDC_CHANNEL_0,
            .timer_sel = LEDC_TIMER_0, .duty = 0, .hpoint = 0,
        };
        ESP_RETURN_ON_ERROR(ledc_channel_config(&channel), TAG, "backlight channel");
        inited = true;
    }
    if (percent > 100) percent = 100;
    uint32_t duty = percent ? (uint32_t)(powf(percent / 100.0f, 2.2f) * 1023.0f + 0.5f) : 0;
    if (percent && duty < 8) duty = 8;          /* 最暗也要看得见 */
    ESP_RETURN_ON_ERROR(ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, duty), TAG, "duty");
    return ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

esp_err_t display_init(void)
{
    ESP_RETURN_ON_ERROR(display_backlight(0), TAG, "backlight init");
    spi_bus_config_t bus = {
        .mosi_io_num = PIN_LCD_MOSI, .miso_io_num = -1, .sclk_io_num = PIN_LCD_SCLK,
        .quadwp_io_num = -1, .quadhd_io_num = -1,
        /* 单次 SPI 传输上限。调小到 20 行：万一缓冲没对齐、驱动要借内部 RAM 中转，
         * 借 9.6KB 比借 19KB 容易得多——内存紧的时候借不到就会丢一块画面。*/
        .max_transfer_sz = LCD_WIDTH * 20 * sizeof(uint16_t),
    };
    ESP_RETURN_ON_ERROR(spi_bus_initialize(LCD_HOST, &bus, SPI_DMA_CH_AUTO), TAG, "lcd spi bus");
    esp_lcd_panel_io_spi_config_t io_config = {
        .dc_gpio_num = PIN_LCD_DC,
        .cs_gpio_num = PIN_LCD_CS,
        /* 10MHz 是 bring-up 时的保守值：整屏 240x320x2 字节要 123ms，界面切换
         * 会肉眼可见地"擦"过去。ST7789 规格支持更高，走线也很短。40MHz 下整屏 29ms。
         *
         * ★ 试过 80MHz（整屏 15ms），实测不能用：画布在 PSRAM，SPI 靠 DMA 直接从
         * PSRAM 读。断网时总线闲，画面正常；4G 一连上，TLS 上传和 PSRAM 抢带宽，
         * DMA 喂不上 80MHz 的时钟，屏上就出空白横条，严重时一帧传不完、
         * flush 回调不来，界面直接卡死划不动。40MHz 是这块板子上带 PSRAM 画布的上限，
         * 别再往上调——要提速得先把画布挪出 PSRAM。*/
        .pclk_hz = 40 * 1000 * 1000,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
        .spi_mode = 3,
        .trans_queue_depth = 2,   /* 让下一块的传输和 LVGL 渲染重叠 */
    };
    esp_lcd_panel_io_handle_t io = NULL;
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)LCD_HOST, &io_config, &io), TAG, "lcd io");
    s_io = io;
    s_draw_done = xSemaphoreCreateBinary();
    if (!s_draw_done) return ESP_ERR_NO_MEM;
    esp_lcd_panel_io_callbacks_t callbacks = { .on_color_trans_done = draw_done };
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_register_event_callbacks(io, &callbacks, NULL), TAG, "draw callback");
    esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = PIN_LCD_RST,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = 16,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_st7789(io, &panel_config, &s_panel), TAG, "st7789");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_reset(s_panel), TAG, "lcd reset");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(s_panel), TAG, "lcd init");
    ESP_RETURN_ON_ERROR(waveshare_init(io), TAG, "waveshare init");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_invert_color(s_panel, true), TAG, "lcd invert");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_disp_on_off(s_panel, true), TAG, "lcd on");
    ESP_RETURN_ON_ERROR(draw_test_pattern(), TAG, "lcd pattern");
    ESP_LOGI(TAG, "ST7789T3 八色数据发送完成（SPI mode 3 / 10MHz）；实际画面须人工确认");
    return display_backlight(100);
}
esp_err_t display_sleep(bool on) { return display_backlight(on ? 0 : 80); }

/* 真关机前调：让屏幕彻底黑掉、不再耗电。
 *
 * 以前关机只把背光 PWM 调到 0 就进深睡眠了。可深睡眠时 LEDC 不工作，这根脚松开成高阻，
 * 而屏模组背光是高电平点亮、自带上拉——于是芯片一睡，背光反倒被上拉点满，
 * 屏上还停着最后一帧「已关机…」。看着像没关干净，也确实一直在耗电。
 *
 * 所以：先让屏自己熄（DISPOFF）并进睡眠（SLPIN，屏的电流从几毫安降到几十微安），
 * 再把背光脚改成普通输出、拉低、打开保持——GPIO13 在 S3 上属于 RTC 域，
 * 保持状态在深睡眠里一直有效。*/
void display_power_down(void)
{
    /* 关机流程里会被调两次（一按到先黑屏、睡下前再确认一次），第二次什么都不用做 */
    static bool done;
    if (done) return;
    done = true;
    if (s_panel) {
        esp_lcd_panel_disp_on_off(s_panel, false);
        esp_lcd_panel_disp_sleep(s_panel, true);
    }
    ledc_stop(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, 0);
    gpio_reset_pin(PIN_LCD_BL);
    gpio_set_direction(PIN_LCD_BL, GPIO_MODE_OUTPUT);
    gpio_set_level(PIN_LCD_BL, 0);
    gpio_pulldown_en(PIN_LCD_BL);
    gpio_hold_en(PIN_LCD_BL);
}

/* 触摸中断：CST816D 检测到按下时把 TP_INT 拉低一下。熄屏时靠它叫醒，不用一直轮询 I2C */
static volatile bool s_touch_irq;
static void IRAM_ATTR touch_isr(void *arg) { (void)arg; s_touch_irq = true; }
bool display_touch_irq_take(void) { bool v = s_touch_irq; s_touch_irq = false; return v; }

/* 深睡中、或刚复位还没起来（复位后约 150ms 内读 I2C 会 NACK，驱动会刷错误日志） */
static bool s_touch_asleep;
static int64_t s_touch_ready_us;

void display_touch_sleep(bool sleep)
{
    if (!s_touch || sleep == s_touch_asleep) return;
    if (sleep) {
        uint8_t cmd[2] = { 0xe5, 0x03 };          /* CST816 深睡；只有复位能叫醒 */
        if (i2c_master_transmit(s_touch, cmd, sizeof(cmd), 50) != ESP_OK) ESP_LOGW(TAG, "触摸芯片深睡指令没发出去");
        s_touch_asleep = true;
    } else {
        gpio_set_level(PIN_TP_RST, 0);
        esp_rom_delay_us(2000);
        gpio_set_level(PIN_TP_RST, 1);
        s_touch_asleep = false;
        s_touch_ready_us = esp_timer_get_time() + 150000;
    }
    s_touch_irq = false;
}

esp_err_t display_touch_init(void)
{
    i2c_master_bus_handle_t bus = power_get_i2c_bus();
    if (!bus) return ESP_ERR_INVALID_STATE;
    gpio_config_t reset = {
        .pin_bit_mask = 1ULL << PIN_TP_RST,
        .mode = GPIO_MODE_OUTPUT,
    };
    gpio_config_t interrupt = {
        .pin_bit_mask = 1ULL << PIN_TP_INT,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&reset), TAG, "touch reset gpio");
    ESP_RETURN_ON_ERROR(gpio_config(&interrupt), TAG, "touch interrupt gpio");
    gpio_set_level(PIN_TP_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(200));
    gpio_set_level(PIN_TP_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(300));
    i2c_device_config_t config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = TOUCH_ADDRESS,
        .scl_speed_hz = 400000,
    };
    ESP_RETURN_ON_ERROR(i2c_master_bus_add_device(bus, &config, &s_touch), TAG, "touch i2c");
    uint8_t reg = 0xa7, chip_id = 0;
    ESP_RETURN_ON_ERROR(i2c_master_transmit(s_touch, &reg, 1, 200), TAG, "touch chip id register");
    ESP_RETURN_ON_ERROR(i2c_master_receive(s_touch, &chip_id, 1, 200), TAG, "touch chip id");
    ESP_LOGI(TAG, "CST816D 已响应 @0x15 chip_id=0x%02x", chip_id);
    /* 按键驱动已经装过中断服务的话这里会报 INVALID_STATE，照常往下走 */
    esp_err_t isr = gpio_install_isr_service(0);
    if (isr != ESP_OK && isr != ESP_ERR_INVALID_STATE) ESP_LOGW(TAG, "中断服务装不上(%s)，熄屏时退回轮询", esp_err_to_name(isr));
    gpio_set_intr_type(PIN_TP_INT, GPIO_INTR_NEGEDGE);
    if (gpio_isr_handler_add(PIN_TP_INT, touch_isr, NULL) != ESP_OK) ESP_LOGW(TAG, "触摸中断没挂上，熄屏时退回轮询");
    return ESP_OK;
}

esp_lcd_panel_handle_t display_panel(void) { return s_panel; }
esp_lcd_panel_io_handle_t display_io(void) { return s_io; }

bool display_touch_read(uint16_t *x, uint16_t *y)
{
    if (!s_touch || s_touch_asleep || esp_timer_get_time() < s_touch_ready_us) return false;
    uint8_t reg = 0x02, value[5] = {0};
    if (i2c_master_transmit_receive(s_touch, &reg, 1, value, sizeof(value), 50) != ESP_OK || !(value[0] & 0x0f))
        return false;
    *x = ((uint16_t)(value[1] & 0x0f) << 8) | value[2];
    *y = ((uint16_t)(value[3] & 0x0f) << 8) | value[4];
    return true;
}

esp_err_t display_touch_wait(uint32_t timeout_ms, uint16_t *x, uint16_t *y)
{
    if (!s_touch || !x || !y) return ESP_ERR_INVALID_STATE;
    TickType_t deadline = xTaskGetTickCount() + pdMS_TO_TICKS(timeout_ms);
    while ((int32_t)(deadline - xTaskGetTickCount()) > 0) {
        uint8_t reg = 0x02, value[5] = {0};
        if (i2c_master_transmit_receive(s_touch, &reg, 1, value, sizeof(value), 200) == ESP_OK && (value[0] & 0x0f)) {
            *x = ((uint16_t)(value[1] & 0x0f) << 8) | value[2];
            *y = ((uint16_t)(value[3] & 0x0f) << 8) | value[4];
            return ESP_OK;
        }
        vTaskDelay(pdMS_TO_TICKS(40));
    }
    return ESP_ERR_TIMEOUT;
}

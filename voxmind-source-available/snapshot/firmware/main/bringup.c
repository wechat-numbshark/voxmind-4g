/* 首板自检 —— 板子焊回来第一件事跑这个。
 * 每一项都对应 docs/13_首板Bringup清单.md 里的一条，失败会打印【该查哪里】。
 */
#include <stdio.h>
#include <inttypes.h>
#include "board.h"
#include "drv_modem.h"
#include "drv_audio.h"
#include "drv_storage.h"
#include "drv_power.h"
#include "drv_input.h"
#include "drv_feedback.h"
#include "drv_display.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_psram.h"

static int s_pass = 0, s_fail = 0;

#define CHECK(name, expr, hint) do {                                    \
    printf("\n[%02d] %s ... ", s_pass + s_fail + 1, name);              \
    fflush(stdout);                                                     \
    if (expr) { printf("✅ 通过\n"); s_pass++; }                        \
    else      { printf("❌ 失败\n     → %s\n", hint); s_fail++; }        \
} while (0)

void bringup_run(void)
{
    printf("\n╔════════════════════════════════════════════════════╗\n");
    printf("║  VoxMind %s 首板自检                          ║\n", VOXMIND_BOARD_REV);
    printf("║  %s                          ║\n", VOXMIND_MCU_MODULE);
    printf("╚════════════════════════════════════════════════════╝\n");

    /* ── 1. 内存：PSRAM 必须是八线，配错模式会直接开不起来 ── */
    size_t psram = esp_psram_get_size();
    CHECK("PSRAM 8MB 识别", psram >= 8 * 1024 * 1024,
          "sdkconfig 里 CONFIG_SPIRAM_MODE_OCT 必须为 y（N16R8 是八线 PSRAM）");

    /* ── 2. 电量计：I2C 通不通、电池在不在 ── */
    power_status_t ps = {0};
    CHECK("MAX17048 电量计 (I2C 0x36)", power_init() == ESP_OK && power_read(&ps) == ESP_OK,
          "查 U5 是否贴反；查 I2C 上拉；用 i2c 扫描看 0x36 在不在");
    if (ps.voltage_v > 0.1f)
        printf("     电池 %.2fV  %.1f%%  速率 %+.2f%%/h  %s\n",
               ps.voltage_v, ps.soc_pct, ps.crate_pct_h, ps.charging ? "充电中" : "放电中");
    CHECK("电池电压在合理区间 (3.0~4.3V)", ps.voltage_v > 3.0f && ps.voltage_v < 4.3f,
          "J1 是【3 脚】座：1=VBAT、2=GND、3=TS。当前 v9 由板上 R4 给 TS 偏置，"
          "两线电池只接 1/2 脚、3 脚留空；先检查电池极性和连接器是否错位");

    /* ── 3. 存储：SD NAND 走 SPI，首次是空片会自动格式化 ── */
    CHECK("SD NAND 挂载 (U9 CSNP4GCR01)", storage_init() == ESP_OK,
          "① U9 方向是否贴反 ② R12/R13 上拉是否在位 "
          "③ 把 host.max_freq_khz 降到 4000 再试");
    uint32_t sec = 0;
    if (storage_free_seconds(&sec) == ESP_OK)
        printf("     剩余可录 %" PRIu32 " 秒 ≈ %.1f 小时（Opus 16kbps）\n", sec, sec / 3600.0f);

    /* ── 4. 音频：双麦 PDM 立体声 ── */
    CHECK("PDM 麦克风初始化", audio_init() == ESP_OK && audio_start() == ESP_OK,
          "查 U7/U8 电平转换片方向；查 +1V8 是否有电（U6 输出）");
    {   /* 丢弃上电瞬态后采 200ms，看左右两路是否都有信号 */
        static int16_t buf[AUDIO_SAMPLE_RATE / 5 * 2];
        size_t got = 0;
        vTaskDelay(pdMS_TO_TICKS(AUDIO_DISCARD_MS));
        audio_read(buf, sizeof(buf), &got, 1000);
        int32_t peakL = 0, peakR = 0;
        for (size_t i = 0; i + 1 < got / 2; i += 2) {
            int32_t l = buf[i] < 0 ? -buf[i] : buf[i];
            int32_t r = buf[i+1] < 0 ? -buf[i+1] : buf[i+1];
            if (l > peakL) peakL = l;
            if (r > peakR) peakR = r;
        }
        printf("     左麦(MIC1) 峰值 %ld   右麦(MIC2) 峰值 %ld\n", (long)peakL, (long)peakR);
        CHECK("左麦 MIC1 有信号", peakL > 50,
              "MIC1 的 L/R 脚接 GND=左声道。信号为 0 查 MIC1 焊接和 MIC_DATA_1V8 走线");
        CHECK("右麦 MIC2 有信号", peakR > 50,
              "MIC2 的 L/R 脚接 +1V8=右声道。两路都为 0 则查 U8 方向(DIR 应接 1V8)");
        CHECK("双麦独立（不是同一路复制）", peakL != peakR || peakL == 0,
              "两路完全相同说明 L/R 脚配置有误或只有一颗麦在工作");
    }
    audio_stop();

    /* ── 5. 4G 模组：注意 PWRKEY 是反相的 ── */
    CHECK("ML307C-GC 驱动初始化", modem_init() == ESP_OK, "—");
    CHECK("ML307C-GC 开机（PWRKEY 反相，GPIO17 拉高触发）",
          modem_power_on(20000) == ESP_OK,
          "① 万用表量 GPIO17：置 1 时应为高 ② 量 Q2 集电极：应被拉低 "
          "③ 查 Q2 是否贴反 ④ 查 VBAT_MODEM(U3 脚42/43) 供电");
    if (modem_get_state() == MODEM_READY) {
        char resp[128] = {0};
        if (modem_at("AT+CPIN?", "OK", resp, sizeof(resp), 3000) == ESP_OK)
            printf("     SIM 卡: %s", resp);
        if (modem_at("AT+CSQ", "OK", resp, sizeof(resp), 3000) == ESP_OK)
            printf("     信号: %s", resp);
    }

    /* ── 6. 人机：这几项要人眼确认 ── */
    CHECK("反馈器件初始化", feedback_init() == ESP_OK, "—");
    printf("\n     ▶ 马达应短振两下（看不到就查 Q1/D7/J6 和马达本体）\n");
    motor_buzz(120, 2);
    printf("     ▶ 屏幕应亮起并显示红橙黄绿青蓝紫白八条横向色带\n");
    CHECK("ST7789T3 屏幕初始化与测试图", display_init() == ESP_OK,
          "查 15Pin 排线方向和锁扣；查 LCD_CS/DC/RST/MOSI/SCLK；确认使用硬排线连接主板与屏幕");
    printf("     ▶ 请在 10 秒内轻触屏幕任意位置\n");
    uint16_t touch_x = 0, touch_y = 0;
    CHECK("CST816D 触摸（I2C 0x15）", display_touch_init() == ESP_OK &&
          display_touch_wait(10000, &touch_x, &touch_y) == ESP_OK,
          "查 TP_SDA/TP_SCL/TP_INT/TP_RST；确认 15Pin 排线锁紧并检查 I2C 0x15");
    if (touch_x || touch_y) printf("     触摸坐标 x=%u y=%u\n", touch_x, touch_y);

    printf("\n╔════════════════════════════════════════════════════╗\n");
    printf("║  自检结果：通过 %2d 项，失败 %2d 项                 ║\n", s_pass, s_fail);
    printf("╚════════════════════════════════════════════════════╝\n");
    if (s_fail == 0)
        printf("\n全部通过。接下来按 docs/13_首板Bringup清单.md 做人工确认项。\n");
}

#include "drv_audio.h"
#include "board.h"
#include "driver/i2s_pdm.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"

static const char *TAG = "audio";
static i2s_chan_handle_t s_rx = NULL;

esp_err_t audio_init(void)
{
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    /* 16 块 × 15ms = 240ms 硬件缓冲：采集任务偶尔被系统任务抢占也不丢数据。
     * 真正的大缓冲（8 秒）在 app_cloud 的 PSRAM 环形缓冲里。*/
    chan_cfg.dma_desc_num  = 16;
    chan_cfg.dma_frame_num = 240;               /* 240 帧 @16k = 15ms/块 */
    ESP_ERROR_CHECK(i2s_new_channel(&chan_cfg, NULL, &s_rx));

    i2s_pdm_rx_config_t pdm_cfg = {
        .clk_cfg  = I2S_PDM_RX_CLK_DEFAULT_CONFIG(AUDIO_SAMPLE_RATE),
        .slot_cfg = I2S_PDM_RX_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT,
                                                   I2S_SLOT_MODE_STEREO),  /* ← 双麦关键 */
        .gpio_cfg = {
            .clk = PIN_MIC_CLK,
            .din = PIN_MIC_DATA,
            .invert_flags = { .clk_inv = false },
        },
    };
    ESP_ERROR_CHECK(i2s_channel_init_pdm_rx_mode(s_rx, &pdm_cfg));
    ESP_LOGI(TAG, "PDM 立体声就绪 %dHz  CLK=GPIO%d DATA=GPIO%d",
             AUDIO_SAMPLE_RATE, PIN_MIC_CLK, PIN_MIC_DATA);
    return ESP_OK;
}

esp_err_t audio_start(void) { return i2s_channel_enable(s_rx); }
esp_err_t audio_stop(void)  { return i2s_channel_disable(s_rx); }

esp_err_t audio_read(void *dst, size_t max_bytes, size_t *out_bytes, uint32_t timeout_ms)
{
    /* ESP-IDF I2S takes milliseconds, not FreeRTOS ticks. Converting twice
     * shortens a 1000ms timeout to 100ms on our 100Hz scheduler. */
    return i2s_channel_read(s_rx, dst, max_bytes, out_bytes, timeout_ms);
}

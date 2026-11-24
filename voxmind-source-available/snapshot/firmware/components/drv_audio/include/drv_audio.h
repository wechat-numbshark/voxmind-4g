#pragma once
#include <stdint.h>
#include <stddef.h>
#include "esp_err.h"

/* 双 PDM 麦克风（MSM261DDB019 × 2）
 *
 * 硬件事实（docs/10_硬件接线真值表.md §2.1）：
 *   两颗麦【共用一根 CLK、一根 DATA】，靠 L/R 脚分声道：
 *       MIC1 的 L/R 接 GND  → 左声道
 *       MIC2 的 L/R 接 1V8  → 右声道
 *   所以必须配成【立体声】PDM RX，一次拿到两路。配成单声道只会拿到其中一路。
 *
 * 采样率：语音用 16kHz 足够（ASR 的标准输入）。PDM 时钟 = 采样率 × 下采样比(64)。
 */

#define AUDIO_SAMPLE_RATE   16000
#define AUDIO_CHANNELS      2          /* 双麦 = 立体声，不要改成 1 */
#define AUDIO_BITS          16

esp_err_t audio_init(void);

/* 开始采集。I2S DMA 只有约 240ms 硬件缓冲；调用方要用独立的高优先级任务及时读走。*/
esp_err_t audio_start(void);
esp_err_t audio_stop(void);

/* 读交织的立体声样本 (L,R,L,R...)。返回实际读到的字节数。*/
esp_err_t audio_read(void *dst, size_t max_bytes, size_t *out_bytes, uint32_t timeout_ms);

/* 唤醒后前 ~50ms 是麦克风上电瞬态，必须丢弃，否则 ASR 开头会吃到爆音。
 * v3 需求 §2.5 的 T0 明确写了这一条。*/
#define AUDIO_DISCARD_MS    50

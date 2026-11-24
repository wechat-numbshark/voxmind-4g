#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* 16kHz 单声道语音场景的 Ogg/Opus 封装器：每个 5 秒录音块独立封装成一个
 * 自包含、可被 ffmpeg 直接解码的 .opus (Ogg 容器) 文件。整个模块只服务
 * "当前正在写的这一个文件"，不支持并发多流——录音本身就是单任务顺序写的。
 *
 * 用法：
 *   codec_opus_init();                          // 开机调用一次
 *   codec_opus_begin_file(file);                 // 每个新 chunk 文件开始时调用
 *   codec_opus_write_pcm(file, pcm, n_samples);   // 喂多少算多少，内部自己按帧攒
 *   codec_opus_end_file(file);                    // chunk 结束时调用，收尾+标记流结束
 */

esp_err_t codec_opus_init(int sample_rate, int bitrate, int complexity);
/** 换音质（只能在两个块之间调） */
esp_err_t codec_opus_reconfigure(int sample_rate, int bitrate, int complexity);
esp_err_t codec_opus_begin_file(FILE *file);
esp_err_t codec_opus_write_pcm(FILE *file, const int16_t *pcm, size_t num_samples);
esp_err_t codec_opus_end_file(FILE *file);

#ifdef __cplusplus
}
#endif

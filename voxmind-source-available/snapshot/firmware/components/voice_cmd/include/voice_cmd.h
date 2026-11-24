#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

/* 离线指令词识别（乐鑫 ESP-SR MultiNet7 中文模型），只在软关机时运行：
 * 设备不录音、不上传，只在本地听「小沃，开机」。声音不离开设备。
 *
 * 指令词按拼音配置（空格分隔、不带声调，如 "xiao wo kai ji"），由云端根据
 * 用户设置的唤醒词生成后随心跳下发——改唤醒词不用重新训练模型。*/

/* 加载模型并设置指令词。模型放在 "model" 分区，约 2.6MB，加载约 1 秒。*/
esp_err_t voice_cmd_start(const char *const phrases[], int count);

/* 每次要喂多少个 16kHz 单声道采样 */
int voice_cmd_chunk_samples(void);

/* 喂一帧；识别到任一指令词时返回 true */
bool voice_cmd_feed(int16_t *samples);

void voice_cmd_stop(void);

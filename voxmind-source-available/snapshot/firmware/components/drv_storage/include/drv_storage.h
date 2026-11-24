#pragma once
#include "esp_err.h"

/* 板载 512MB SD NAND（U9 = MKDV4GIL-AST，4Gbit）
 *
 * 关键事实：这颗芯片走【SD 2.0 协议】，不是裸 NAND、不是 SPI Flash。
 * 所以 ESP-IDF 的 sdspi 驱动直接可用，和 MicroSD 的代码【完全一样】——
 * 这也是 v3 换料时选它的原因：固件零改动。
 *
 * 引脚映射见 docs/10_硬件接线真值表.md §2.2（芯片脚号与 MicroSD 不同，
 * 但那是硬件的事，固件只认 board.h 里的 SD_* 四根线）。
 */

#define STORAGE_MOUNT_POINT   "/rec"

esp_err_t storage_init(void);
esp_err_t storage_deinit(void);

/* 剩余可录时长（秒），按 Opus 16kbps 估算。
 * 512MB ÷ 7.2MB/小时 ≈ 71 小时。*/
esp_err_t storage_free_seconds(uint32_t *out_sec);

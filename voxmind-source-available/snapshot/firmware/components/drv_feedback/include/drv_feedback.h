#pragma once
#include <stdint.h>
#include "esp_err.h"

/* 状态灯（WS2812C 单颗，GPIO47）+ 振动马达（GPIO42 经 Q1 NMOS，高有效）
 * 状态与灯效的对应表来自 v3 需求 §三「状态机」。*/

typedef enum {
    LED_OFF = 0,
    LED_STANDBY,        /* 绿常亮   —— 待机 Home */
    LED_RECORDING,      /* 红呼吸   —— 录音中 */
    LED_OFFLINE_CACHE,  /* 黄慢闪   —— 录完但没网，数据在 NAND */
    LED_UPLOADING,      /* 蓝快闪   —— 上传中 */
    LED_AWAIT_WINDOW,   /* 蓝常亮   —— 上传完的 30 秒等卡片窗口 */
    LED_PENDING,        /* 蓝呼吸   —— 有待确认卡片 */
    LED_OK_FLASH,       /* 绿闪两下 —— 执行成功 */
    LED_CHARGING,       /* 橙呼吸   —— 充电中 */
} led_pattern_t;

/* 管理端三档（设置里的「指示灯」）：
 *   LED_MODE_DESIGNED            按上表颜色节奏
 *   LED_MODE_DARK_WHILE_RECORDING 录音时不亮，其余状态照常
 *   LED_MODE_OFF                 全灭 */
typedef enum {
    LED_MODE_DESIGNED = 0,
    LED_MODE_DARK_WHILE_RECORDING,
    LED_MODE_OFF,
} led_mode_t;

esp_err_t feedback_init(void);
/* 设置底色状态（线程安全，重复设同一状态没有开销）。*/
esp_err_t led_set(led_pattern_t p);
/* 叠加一次短闪（执行成功），闪完自动回到底色状态。*/
void led_flash_ok(void);
void led_set_mode(led_mode_t mode);

/* 马达。v3 需求定义的三种：录音起始短振一次 / 卡片到达短振两下 / 确认短振一下 */
esp_err_t motor_buzz(uint16_t on_ms, uint8_t times);

#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

/* 三键：REC / OK / BACK，均为【按下接地】，必须开内部上拉。
 * REC 键(GPIO3) 同时是深睡眠唤醒源 —— v3 需求要求"按下到开始录音 ≤0.2s"。*/

typedef enum { BTN_REC_E = 0, BTN_OK_E, BTN_BACK_E, BTN_COUNT } btn_id_t;
typedef enum { BTN_EV_DOWN, BTN_EV_UP, BTN_EV_CLICK, BTN_EV_LONG } btn_evt_type_t;

typedef struct { btn_id_t id; btn_evt_type_t type; uint32_t held_ms; } btn_event_t;

esp_err_t input_init(QueueHandle_t out_queue);

/* 把 REC 键配成 deep-sleep 唤醒源。调用后即可 esp_deep_sleep_start()。*/
esp_err_t input_arm_wakeup(void);

/* 现在这颗键是不是真的按着（直接读电平）。「按住说话」用它兜底：万一松手的事件被抖动吃掉，
 * 照样能发现手已经松了 */
bool input_is_down(btn_id_t id);

#define BTN_LONG_PRESS_MS   800
#define BTN_DEBOUNCE_MS     25

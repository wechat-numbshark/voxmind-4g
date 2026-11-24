#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include "lvgl.h"
typedef int esp_err_t;
typedef void *esp_lcd_panel_handle_t;
typedef void *esp_lcd_panel_io_handle_t;
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_INVALID_STATE -2
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGW(...) ((void)0)
#define ESP_LOGE(...) ((void)0)
#define ESP_RETURN_ON_ERROR(expr, ...) do { int e = (expr); if (e) return e; } while(0)
#define ESP_LVGL_PORT_INIT_CONFIG() {0}
#define pdMS_TO_TICKS(n) (n)
typedef struct { int task_priority, task_affinity, task_stack; } lvgl_port_cfg_t;
typedef struct {
    void *io_handle, *panel_handle;
    size_t buffer_size;
    bool double_buffer, monochrome;
    int hres, vres;
    lv_color_format_t color_format;
    struct { bool swap_xy, mirror_x, mirror_y; } rotation;
    struct { bool buff_dma, buff_spiram, swap_bytes; } flags;
} lvgl_port_display_cfg_t;
static inline bool lvgl_port_lock(uint32_t ms) { (void)ms; return true; }
static inline void lvgl_port_unlock(void) {}
static inline void lvgl_port_stop(void) {}
static inline void lvgl_port_resume(void) {}
static inline void vTaskDelay(uint32_t ms) { lv_tick_inc(ms); }
static inline int64_t esp_timer_get_time(void) { return (int64_t)lv_tick_get() * 1000; }
typedef struct { const char *version; } esp_app_desc_t;
static inline const esp_app_desc_t *esp_app_get_description(void) { static esp_app_desc_t d={"1.0.24"}; return &d; }
static inline esp_err_t esp_lcd_panel_disp_sleep(void *p, bool b) { (void)p; (void)b; return 0; }
static inline esp_err_t lvgl_port_init(const lvgl_port_cfg_t *p) { (void)p; lv_init(); return 0; }
lv_display_t *lvgl_port_add_disp(const lvgl_port_display_cfg_t *cfg);

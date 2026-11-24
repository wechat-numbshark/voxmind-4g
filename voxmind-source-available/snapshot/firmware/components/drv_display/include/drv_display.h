#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "esp_lcd_types.h"

/* 已定型：Waveshare 2inch Capacitive Touch LCD，240x320。
 * LCD=ST7789T3/SPI，触摸=CST816D/I2C 0x15，经 15Pin 硬排线连接。 */

esp_err_t display_init(void);
esp_err_t display_backlight(uint8_t percent);   /* GPIO13 LEDC PWM */
esp_err_t display_sleep(bool on);               /* 待机省电 */
void display_power_down(void);                  /* 真关机前：屏熄灭+睡眠，背光脚钉低（深睡眠里也保持） */
esp_err_t display_touch_init(void);
esp_err_t display_touch_wait(uint32_t timeout_ms, uint16_t *x, uint16_t *y);
esp_err_t display_show_queue(uint32_t pending_count); /* 联调 UI：上方队列点，底部左取消/右确认 */

/* 交给 LVGL 接管屏幕用。交出后不要再调 display_show_queue()：LVGL 会注册
 * 自己的刷屏完成回调，覆盖本驱动的。*/
esp_lcd_panel_handle_t display_panel(void);
esp_lcd_panel_io_handle_t display_io(void);
/* 非阻塞读一次触摸：有手指按着返回 true 并给出坐标（屏幕坐标，竖屏 240x320）。*/
bool display_touch_read(uint16_t *x, uint16_t *y);
/** 触摸芯片按下时会拉一下 TP_INT：熄屏时界面不再每 30ms 去问它，等这个中断。取一次清一次 */
bool display_touch_irq_take(void);
/* 触摸芯片深睡（约 5µA，不再扫描，碰屏幕也不会醒）/ 叫醒（拉一下复位脚，约 150ms 后才能读） */
void display_touch_sleep(bool sleep);

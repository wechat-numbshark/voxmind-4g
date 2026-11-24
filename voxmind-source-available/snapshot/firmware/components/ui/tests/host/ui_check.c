/* Runs the real ui.c and bundled LVGL/fonts; only ESP hardware calls are stubbed. */
#include "host.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "../../ui.c"

static uint16_t framebuffer[240 * 320];
static void flush(lv_display_t *d, const lv_area_t *a, uint8_t *pixels)
{
    uint16_t *p = (uint16_t *)pixels;
    for (int y = a->y1; y <= a->y2; ++y)
        for (int x = a->x1; x <= a->x2; ++x) framebuffer[y * 240 + x] = *p++;
    lv_display_flush_ready(d);
}
lv_display_t *lvgl_port_add_disp(const lvgl_port_display_cfg_t *cfg)
{
    static uint16_t buffer[240 * 320];
    lv_display_t *d = lv_display_create(cfg->hres, cfg->vres);
    lv_display_set_color_format(d, LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(d, buffer, NULL, sizeof(buffer), LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_set_flush_cb(d, flush);
    return d;
}
esp_lcd_panel_handle_t display_panel(void) { return (void *)1; }
esp_lcd_panel_io_handle_t display_io(void) { return (void *)1; }
esp_err_t display_backlight(uint8_t b) { (void)b; return 0; }
void display_power_down(void) {}
bool display_touch_read(uint16_t *x, uint16_t *y) { *x = *y = 0; return false; }
bool display_touch_irq_take(void) { return false; }
void display_touch_sleep(bool s) { (void)s; }
static ui_status_t status = { .paused = true, .network = true, .battery_pct = 82, .charging = true, .recording_seconds = 1500 };
static void status_read(ui_status_t *s) { *s = status; }
static bool accept = true;
static char dismissed[40];
static bool action(const char *id, const char *verb)
{
    if (accept && strcmp(verb, "dismiss") == 0) strcpy(dismissed, id);
    return accept;
}
static void snapshot(const char *name)
{
    lv_obj_update_layout(lv_screen_active());
    lv_refr_now(NULL);
    FILE *f = fopen(name, "wb"); assert(f);
    fprintf(f, "P6\n240 320\n255\n");
    for (int i = 0; i < 240 * 320; ++i) {
        uint16_t p = framebuffer[i];
        uint8_t rgb[] = { ((p >> 11) & 31) * 255 / 31, ((p >> 5) & 63) * 255 / 63, (p & 31) * 255 / 31 };
        fwrite(rgb, 1, 3, f);
    }
    fclose(f);
}
static void assert_slots(void)
{
    lv_obj_update_layout(lv_screen_active());
    int last_bottom = UI_STACK_TOP - UI_STACK_GAP;
    for (int i = 0; i < STACK_SLOTS; ++i) {
        if (lv_obj_has_flag(s_slot[i], LV_OBJ_FLAG_HIDDEN)) continue;
        int outline = S_EDGE ? S_CARD_BW : 0;
        int top = lv_obj_get_y(s_slot[i]) - outline;
        int bottom = lv_obj_get_y(s_slot[i]) + lv_obj_get_height(s_slot[i]) + outline;
        assert(top >= last_bottom + UI_STACK_GAP);
        assert(bottom <= UI_STACK_BOTTOM);
        last_bottom = bottom;
    }
}
int main(void)
{
    assert(ui_init(status_read, action) == ESP_OK);
    ui_receipt_t receipts[4] = {0};
    for (int i = 0; i < 4; ++i) {
        snprintf(receipts[i].id, 40, "receipt-%d", i);
        strcpy(receipts[i].tool, "iot.ir.send");
        strcpy(receipts[i].title, "打开空调，进入25度制冷");
        strcpy(receipts[i].at, "01:34");
        strcpy(receipts[i].evidence, "请帮我把家里的空调打开");
    }
    ui_today_t today = { .valid = true, .recorded_sec = 1500, .done = 4 };
    ui_set_feed(receipts, 4, NULL, 0, &today);
    for (int edge = 0; edge <= 3; ++edge) {
        s_theme.s.edge = edge;
        for (int offline = 0; offline <= 1; ++offline) {
            status.network = !offline;
            status.battery_pct = offline ? 9 : 82;
            status.charging = !offline;
            status_tick(NULL); rebuild_stack(); assert_slots();
        }
    }
    status.network = true; status.battery_pct = 82; status.charging = true;
    s_theme.s.edge = 0;
    status_tick(NULL); rebuild_stack();
    assert(s_slot_receipt[0] == 0 && s_slot_receipt[1] == 1);
    assert(lv_obj_has_flag(s_meter, LV_OBJ_FLAG_HIDDEN));
    snapshot("paused.ppm");
    /* The user's reported overlap occurred with the shipped papercut theme. */
    ui_theme_t papercut;
    const int shape[] = {2, 1, 3, 2, 2};
    assert(ui_theme_parse("papercut", "F2E3C6,FFF9EE,4A2A1C,BFA27A,2B1A12,5C4033,7E6150,C8102E,9E0B23,FFF9EE,C8102E,C77A12,F8E3BC,6E3F06,1F5673,163F55,2F7A4F,D04A1F,9A520C,9E0B23,2B1A12,F2E3C6,C8102E,FFF4E0,FCE6CC,FFD98E,FFFFFF,FFF4E0,C8102E,C8102E", shape, 5, &papercut));
    ui_apply_theme(&papercut);
    ui_set_feed(receipts, 4, NULL, 0, &today);
    assert_slots();
    assert(s_slot_receipt[0] == 0 && s_slot_receipt[1] == 1);
    snapshot("paused-papercut.ppm");
    /* Feed refresh invalidates the gesture identity; an old completion cannot delete a new row. */
    strcpy(s_slot_gesture_id[0], "receipt-0");
    ui_set_feed(receipts + 1, 3, NULL, 0, &today);
    lv_anim_t a = { .var = s_slot[0] };
    slot_out_ready(&a);
    assert(!dismissed[0] && s_receipt_count == 3);
    strcpy(s_slot_gesture_id[0], "receipt-1");
    accept = false; slot_out_ready(&a);
    assert(s_receipt_count == 3);
    accept = true; strcpy(s_slot_gesture_id[0], "receipt-1"); slot_out_ready(&a);
    assert(strcmp(dismissed, "receipt-1") == 0 && s_receipt_count == 2);
    show(s_toast, false);
    ui_show_reminder("提醒：这是一个很长的标题用来验证界面的文字不会把底部提示挤出屏幕", "今天记得检查温湿度传感器和红外遥控器，完成后查看空调状态。长提醒需要完整保留确认入口。", "12:00");
    lv_obj_update_layout(s_msg);
    assert(lv_obj_get_y(s_msg_sub) + lv_obj_get_height(s_msg_sub) <= lv_obj_get_y(s_msg_note));
    assert(lv_obj_get_y(s_msg_note) + lv_obj_get_height(s_msg_note) <= H);
    snapshot("reminder.ppm");
    puts("real LVGL: multi-state bounds, paused receipts, cancelled/stale swipe and long reminder passed");
    return 0;
}

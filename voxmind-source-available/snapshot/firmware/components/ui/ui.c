#include "ui.h"
#include "ui_logic.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "drv_display.h"
#include "esp_app_desc.h"
#include "esp_check.h"
#include "esp_log.h"
#include "esp_lvgl_port.h"
#include "esp_lcd_panel_ops.h"
#include "esp_timer.h"
#include "lvgl.h"
#include "display/lv_display_private.h"   /* 只为拿到 LVGL 分配的两个缓冲指针，用来切换刷新模式 */

/* 设计契约（选定方案 A+B，见 docs/design/device-screen-options.html）
 * THESIS  设备屏是网页进程单的随身延伸：一叠插在卡槽里的白纸条，划走一条就是签掉一条；
 *         拒绝"深色科技仪表盘"那一套渐变和发光。
 * WORLD   灰底 #E9EDEC、白纸条、1px #D5DCDA 边；卡槽色＝风险等级（黄对外/蓝个人/绿记录/橙设备）；
 *         墨色 #12202A 字；录音红 #D92D3A 只给录音点。三个字号：16 Medium、24 Bold、44 数字。
 * FIRST   A 屏：白色状态带（44px 时钟 + 电量）→ 录音行（红点、走时、电平）→ 纸条区 → 底部两点页码。
 * 性能    只用纯色和圆角，不用渐变/阴影/常驻动画；文字没变就不重设，免得整块重绘。*/

static const char *TAG = "ui";

LV_FONT_DECLARE(font_cn_16);
LV_FONT_DECLARE(font_cn_24);
LV_FONT_DECLARE(font_num_44);

#define W 240
#define H 320
#define PAD 12

/* ── 配色和形状：后台可换主题 ─────────────────────────────────────
 * 以前这些是编译期常量。现在从当前主题读：调用点照旧写 C_INK，取到的就是当前主题的颜色。
 * 默认值就是原来那套（航管进程单：浅灰台面、白纸条、墨绿主色），后台没选主题时一切照旧。
 * 字段顺序就是服务端 themes.ts 下发颜色串的顺序，两边必须一致。*/
static ui_theme_t s_theme = {
    .id = "classic",
    .c = { .console = 0xE9EDEC, .paper = 0xFFFFFF, .rule = 0xD5DCDA, .rule2 = 0xB3BFBC,
           .ink = 0x12202A, .ink2 = 0x445561, .ink3 = 0x61717C,
           .act = 0x0A6E64, .act_press = 0x085A52, .on_act = 0xFFFFFF, .rec = 0xD92D3A,
           .ext = 0xE9A21B, .ext_tint = 0xFFF3D6, .ext_ink = 0x5E4200, .own = 0x2766AE, .own_ink = 0x133F6E,
           .recd = 0x1E7A4B, .phy = 0xE0604A, .warn = 0xB26A00, .bad = 0xC4262F,
           .night = 0x12202A, .night_ink = 0xFFFFFF,
           .head = 0xFFFFFF, .head_ink = 0x12202A, .head_ink2 = 0x445561, .head_ok = 0x1E7A4B, .head_bad = 0xC4262F,
           .clock = 0x12202A, .big_clock = 0x12202A, .edge = 0xD5DCDA },
    .s = { .card_r = 6, .card_bw = 1, .edge = 0, .btn_r = 8, .chip_r = 4 },
};
#define C_CONSOLE   (s_theme.c.console)   /* 台面（屏幕底色） */
#define C_PAPER     (s_theme.c.paper)     /* 纸面：纸条、卡片、详情页、整屏提示 */
#define C_RULE      (s_theme.c.rule)      /* 细线、纸条描边 */
#define C_RULE_2    (s_theme.c.rule2)
#define C_INK       (s_theme.c.ink)
#define C_INK_2     (s_theme.c.ink2)
#define C_INK_3     (s_theme.c.ink3)
#define C_ACT       (s_theme.c.act)       /* 主色：确认按钮、音量条 */
#define C_ACT_PRESS (s_theme.c.act_press)
#define C_ON_ACT    (s_theme.c.on_act)    /* 主色上的字。以前直接用 C_PAPER，深色主题里纸面是黑的，就分开了 */
#define C_REC       (s_theme.c.rec)
#define C_EXT       (s_theme.c.ext)
#define C_EXT_TINT  (s_theme.c.ext_tint)
#define C_EXT_INK   (s_theme.c.ext_ink)
#define C_OWN       (s_theme.c.own)
#define C_OWN_INK   (s_theme.c.own_ink)
#define C_RECD      (s_theme.c.recd)
#define C_PHY       (s_theme.c.phy)
#define C_WARN      (s_theme.c.warn)
#define C_BAD       (s_theme.c.bad)
#define C_NIGHT     (s_theme.c.night)
#define C_NIGHT_INK (s_theme.c.night_ink)
/* 顶栏单独一组：主题可以把顶栏做成色块（多巴胺黄、剪纸红），上面的字、充电中、低电量
 * 都得换成在这块底色上看得清的颜色——红底上放绿色"充电中"是看不见的 */
#define C_HEAD      (s_theme.c.head)
#define C_HEAD_INK  (s_theme.c.head_ink)
#define C_HEAD_INK_2 (s_theme.c.head_ink2)
#define C_HEAD_OK   (s_theme.c.head_ok)
#define C_HEAD_BAD  (s_theme.c.head_bad)
#define C_CLOCK     (s_theme.c.clock)     /* A 屏顶栏的大钟 */
#define C_BIG_CLOCK (s_theme.c.big_clock) /* B 屏的大钟 */
#define C_EDGE      (s_theme.c.edge)      /* 纸条右下的"垫层"颜色（剪纸风那一层红纸） */
#define S_CARD_R    (s_theme.s.card_r)
#define S_CARD_BW   (s_theme.s.card_bw)
#define S_EDGE      (s_theme.s.edge)
#define S_BTN_R     (s_theme.s.btn_r)
#define S_CHIP_R    (s_theme.s.chip_r)

#define LEVEL_BARS 9
#define STACK_SLOTS 3
#define SWIPE_PAGE_PX 50        /* 翻屏：横向划过 50px 就算 */
#define SWIPE_DISMISS_PX 70     /* 划掉回执要多划一点，防止误触 */

static ui_status_provider_t s_status_provider;
static ui_action_handler_t s_action_handler;

/* ── 数据 ──────────────────────────────────────────────────────── */
static ui_receipt_t s_receipts[UI_MAX_RECEIPTS];
static int s_receipt_count;
static ui_timeline_row_t s_rows[UI_MAX_TIMELINE];
static int s_row_count;
static ui_today_t s_today;
static uint32_t s_today_recorded_baseline;
static ui_status_t s_last;             /* 最近一次状态，纸条区重排时用 */

static char s_card_id[40];
static char s_card_tool[40];
static char s_card_title[256];
static bool s_busy;
static int32_t s_expires_in = -1;
static uint8_t s_level_hist[LEVEL_BARS];
static int s_page;                     /* 0＝A 1＝B */
static uint8_t s_brightness = 80;
static ui_brightness_saver_t s_brightness_saver;
static uint16_t s_screen_timeout;      /* 秒，0＝不熄屏 */
static volatile bool s_screen_off;
static bool s_msg_keeps_awake = true;        /* 当前全屏提示要不要一直亮着（关机、升级要；暂停不要） */
static bool s_msg_is_reminder;               /* 当前全屏提示是到点提醒：点一下屏幕就算收下 */
/* 标记「点了会做事」的对象：双击熄屏时绕开它们 */
#define INTERACTIVE LV_OBJ_FLAG_USER_1
static volatile bool s_swallow_touch;   /* 熄屏时按下的那一下：只点亮，松手前都不往下传 */

/* ── 对象 ──────────────────────────────────────────────────────── */
static lv_obj_t *s_pager;
static lv_obj_t *s_dot[2];
/* A 屏：展开状态带 */
static lv_obj_t *s_head, *s_clock, *s_date, *s_bat_pct, *s_bat_fill, *s_bat_shell, *s_bat_nub, *s_bolt;
static lv_obj_t *s_recrow, *s_rec_dot, *s_rec_label, *s_rec_time, *s_level[LEVEL_BARS];
static lv_obj_t *s_meter;
/* A 屏：有卡片时的紧凑状态带 */
static lv_obj_t *s_mini, *s_mini_clock, *s_mini_dot, *s_mini_time, *s_mini_bat;
/* A 屏：纸条区 */
static lv_obj_t *s_slot[STACK_SLOTS], *s_slot_bar[STACK_SLOTS], *s_slot_meta[STACK_SLOTS],
                *s_slot_time[STACK_SLOTS], *s_slot_title[STACK_SLOTS], *s_slot_sub[STACK_SLOTS];
static int s_slot_receipt[STACK_SLOTS];     /* 这个位置放的是第几条回执；-1＝不是回执（不可划） */
static char s_slot_gesture_id[STACK_SLOTS][40];
static lv_obj_t *s_hint;
/* 详情页：点一条回执或时刻表里的一行就整屏打开，标题完整换行、带原话。
 * 以前点了没反应——手势只接了左右划掉，标题又被服务端截到 15 个字，屏上什么也看不全。*/
/* 翻页时的帧率统计：滑动顺不顺不该靠感觉，直接数帧 */
static lv_display_t *s_disp;
static uint32_t s_frames, s_frame_worst_ms, s_frame_last;
static uint16_t s_frame_at[12];      /* 每帧相对测量起点的毫秒，用来看动画期间到底刷了几次 */
static uint16_t s_frame_cost[12];
static int64_t s_frame_t0, s_render_t0, s_render_us, s_flush_us;
static bool s_measuring;
static lv_obj_t *s_detail, *s_detail_meta, *s_detail_time, *s_detail_title, *s_detail_body, *s_detail_back,
                *s_detail_badge, *s_detail_badge_sym, *s_detail_card, *s_detail_bar, *s_detail_chip, *s_detail_quote;
static lv_obj_t *s_stats;                    /* 录音行下面固定的一行"今天录了多久"，不跟着回执变 */
/* A 屏：待确认卡片 */
static lv_obj_t *s_card, *s_card_bar, *s_card_chip, *s_card_count, *s_card_title_l, *s_card_evidence,
                *s_card_expiry, *s_btn_cancel, *s_btn_confirm, *s_btn_confirm_label;
/* B 屏 */
static lv_obj_t *s_b_clock, *s_b_date, *s_b_pill_time, *s_b_pill_bat, *s_b_pill_dot, *s_b_empty;
static lv_obj_t *s_b_row[UI_MAX_TIMELINE], *s_b_at[UI_MAX_TIMELINE], *s_b_kind[UI_MAX_TIMELINE], *s_b_title[UI_MAX_TIMELINE];
/* 覆盖层 */
static lv_obj_t *s_toast, *s_toast_label;
static lv_timer_t *s_toast_timer;
/* 「处理中」小条：按住说完松手后挂着，等服务器回话再收。点点点每 0.5 秒动一下，只重画这一小条 */
static lv_obj_t *s_work, *s_work_label;
static lv_timer_t *s_work_timer;
static bool s_work_on;
static uint8_t s_work_tick;
static void work_dots(lv_timer_t *timer);
static lv_timer_t *s_status_timer, *s_level_timer;   /* 换主题重建时要先删掉，不然会叠出两份定时器 */
static bool s_built;                                 /* 界面建好了没：之前换主题只记下，之后才重建 */
static lv_obj_t *s_bright, *s_bright_track, *s_bright_fill, *s_bright_pct;
static lv_timer_t *s_bright_timer;
static lv_obj_t *s_msg, *s_msg_mark, *s_msg_bars[2], *s_msg_title, *s_msg_sub, *s_msg_note, *s_msg_bar, *s_msg_bar_fill, *s_msg_ver;

/* ── 工具种类 → 风险等级（和服务端 TOOL_RISKS、网页 format.ts 同一张表）─── */
/* 表里只记"这类动作属于哪一档"，颜色运行时按当前主题取——主题能换，颜色就不能写死在表里 */
typedef enum { K_RECD, K_OWN, K_EXT, K_PHY } look_kind_t;
typedef struct { const char *tool; const char *label; const char *tier; look_kind_t kind; } tool_look_t;
static const tool_look_t TOOLS[] = {
    {"note.create",                "笔记",     "记录", K_RECD},
    {"feishu.task.create",         "飞书任务", "个人", K_OWN},
    {"feishu.calendar.create",     "飞书日程", "个人", K_OWN},
    {"feishu.doc.create",          "飞书文档", "个人", K_OWN},
    {"feishu.message.send",        "飞书消息", "对外", K_EXT},
    {"webhook.call",               "Webhook",  "对外", K_EXT},
    {"homeassistant.service.call", "智能家居", "设备", K_PHY},
    {"iot.light.set",              "智能灯",   "设备", K_PHY},
    {"iot.switch.set",             "智能开关", "设备", K_PHY},
    {"iot.climate.set",            "空调",     "设备", K_PHY},
    {"iot.ir.send",                "红外遥控", "设备", K_PHY},
    {"irrigation.zone.run",        "灌溉",     "设备", K_PHY},
};
static const tool_look_t *look_of(const char *tool)
{
    static const tool_look_t fallback = {"", "待办", "个人", K_OWN};
    for (size_t i = 0; tool && i < sizeof(TOOLS) / sizeof(TOOLS[0]); ++i)
        if (strcmp(tool, TOOLS[i].tool) == 0) return &TOOLS[i];
    return &fallback;
}
/* 卡槽色条 */
static uint32_t look_color(const tool_look_t *lk)
{
    return lk->kind == K_RECD ? C_RECD : lk->kind == K_OWN ? C_OWN : lk->kind == K_EXT ? C_EXT : C_PHY;
}
/* 标签字色 */
static uint32_t look_ink(const tool_look_t *lk)
{
    return lk->kind == K_RECD ? C_RECD : lk->kind == K_OWN ? C_OWN_INK : lk->kind == K_EXT ? C_EXT_INK : C_PHY;
}
/* 办完了怎么说：笔记是「已记下」，其余「已执行」 */
static const char *done_word(const char *tool) { return tool && strcmp(tool, "note.create") == 0 ? "已记下" : "已执行"; }
/* B 屏类型列只有 44px，用两个字的简称 */
static const char *short_kind(const char *tool)
{
    const char *l = look_of(tool)->label;
    if (strncmp(l, "飞书", 6) == 0) return l + 6;      /* "飞书任务" → "任务" */
    if (strcmp(l, "智能家居") == 0) return "家居";
    if (strcmp(l, "红外遥控") == 0) return "红外";
    if (strcmp(l, "智能开关") == 0) return "开关";
    if (strcmp(l, "Webhook") == 0) return "接口";
    return l;
}

/* ── 小工具 ───────────────────────────────────────────────────── */

/* 文字没变就不动：lv_label_set_text 即使内容相同也会让整块重绘，
 * 以前每秒重设一遍所有文字是界面任务吃 CPU 的主要来源之一。*/
static void set_text(lv_obj_t *l, const char *text)
{
    if (strcmp(lv_label_get_text(l), text) != 0) lv_label_set_text(l, text);
}
static void set_color(lv_obj_t *l, uint32_t c)
{
    lv_color_t want = lv_color_hex(c);
    if (!lv_color_eq(lv_obj_get_style_text_color(l, 0), want)) lv_obj_set_style_text_color(l, want, 0);
}
static void show(lv_obj_t *o, bool visible)
{
    if (visible == lv_obj_has_flag(o, LV_OBJ_FLAG_HIDDEN)) {
        if (visible) lv_obj_remove_flag(o, LV_OBJ_FLAG_HIDDEN);
        else lv_obj_add_flag(o, LV_OBJ_FLAG_HIDDEN);
    }
}

static lv_obj_t *label(lv_obj_t *parent, const lv_font_t *font, uint32_t color)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(color), 0);
    lv_label_set_text(l, "");
    return l;
}

/* 纯容器：默认不可点、不可滚，这样按在它上面的手势会落到翻屏容器上 */
static lv_obj_t *box(lv_obj_t *parent, int x, int y, int w, int h)
{
    lv_obj_t *o = lv_obj_create(parent);
    lv_obj_remove_style_all(o);
    lv_obj_set_pos(o, x, y);
    lv_obj_set_size(o, w, h);
    lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_remove_flag(o, LV_OBJ_FLAG_CLICKABLE);
    return o;
}
static lv_obj_t *fill(lv_obj_t *parent, int x, int y, int w, int h, uint32_t color, int radius)
{
    lv_obj_t *o = box(parent, x, y, w, h);
    lv_obj_set_style_bg_color(o, lv_color_hex(color), 0);
    lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(o, radius, 0);
    return o;
}
static lv_obj_t *hairline(lv_obj_t *parent, int y) { return fill(parent, 0, y, W, 1, C_RULE, 0); }

/* 纸面上的"垫层"：主题设了 edge 时，右下各加一道粗边，像纸片垫高了一层（剪纸风那层红纸）。
 * 描边改走 outline（画在对象外面），这样四周的细线和右下的垫层能同时存在。
 * 不用阴影：LVGL 不带模糊的阴影直接不画，带模糊的每帧都要算，这块屏扛不住；边框只是填几条矩形。*/
static void paper_edge(lv_obj_t *o, uint32_t line, uint32_t edge)
{
    if (S_EDGE == 0) {
        lv_obj_set_style_border_width(o, S_CARD_BW, 0);
        lv_obj_set_style_border_color(o, lv_color_hex(line), 0);
        return;
    }
    lv_obj_set_style_outline_width(o, S_CARD_BW, 0);
    lv_obj_set_style_outline_color(o, lv_color_hex(line), 0);
    lv_obj_set_style_border_width(o, S_EDGE, 0);
    lv_obj_set_style_border_side(o, LV_BORDER_SIDE_BOTTOM | LV_BORDER_SIDE_RIGHT, 0);
    lv_obj_set_style_border_color(o, lv_color_hex(edge), 0);
}

/* 纸条：左边一条卡槽色，描边和圆角按主题 */
static lv_obj_t *strip(lv_obj_t *parent, int y, int h, lv_obj_t **bar)
{
    lv_obj_t *o = fill(parent, 8, y, W - 16, h, C_PAPER, S_CARD_R);
    paper_edge(o, C_RULE, C_EDGE);
    /* 不用 clip_corner（它让每张纸条都走遮罩渲染，很贵）：色条缩进上下各 4px，碰不到圆角 */
    *bar = fill(o, 1, 4, 5, h - 8, C_RULE_2, 2);
    return o;
}

static void strip_height(lv_obj_t *o, lv_obj_t *bar, int h)
{
    if (lv_obj_get_style_height(o, 0) != h) { lv_obj_set_height(o, h); lv_obj_set_height(bar, h - 8); }
}

/* "14 分钟后作废" 而不是 "14:53"——后者在一块同时显示钟点的屏上会被读成下午两点五十三。
 *
 * 以前写成"还剩 1407 分钟，不确认就作废"：一天有效期的卡片按分钟数出来是四位数，
 * 一行放不下被截掉了尾巴，而且没人能一眼换算 1407 分钟是多久。
 * 现在超过 2 小时按小时说；"不确认"三个字省掉——下面就是确认按钮，意思不会丢。*/
static void fmt_expiry(char *out, size_t n, int32_t s)
{
    if (s < 0) s = 0;
    if (s >= 2 * 3600) snprintf(out, n, "%ld 小时后作废", (long)((s + 3599) / 3600));
    else if (s >= 60) snprintf(out, n, "%ld 分钟后作废", (long)((s + 59) / 60));
    else snprintf(out, n, "%ld 秒后作废", (long)s);
}

static void fmt_hms(char *out, size_t n, uint32_t s)
{
    snprintf(out, n, "%02lu:%02lu:%02lu", (unsigned long)(s / 3600), (unsigned long)(s / 60 % 60), (unsigned long)(s % 60));
}

/* ── 亮度与熄屏 ───────────────────────────────────────────────── */

#define BRIGHT_MIN 10
#define TRACK_H 180

static bool s_wake_inhibit;              /* 耗电测量期间：屏幕一直黑着，提醒/卡片/按键都不点亮 */
static void (*s_screen_cb)(bool on);     /* 亮屏/熄屏时通知外面：亮屏要把 CPU 提到满速，界面才跟手 */
static volatile bool s_tap_wake;
static volatile bool s_dtap_off = true;  /* 亮着时双击空白处熄屏 */         /* 熄屏时碰屏幕能不能点亮。关着（默认）＝只有按键能亮，触摸芯片熄屏就深睡 */

/* 熄屏：关背光，再让面板睡（SLPIN）。以前只关背光，面板和它的驱动芯片照常工作——
 * 实测黑屏时面板+麦克风约 29mA。面板睡着时显存照样能写，叫醒后画面就是最新的 */
static void screen_off_now(void)
{
    s_screen_off = true;
    display_backlight(0);
    esp_lcd_panel_disp_sleep(display_panel(), true);
    if (s_screen_cb) s_screen_cb(false);
}

void ui_set_screen_listener(void (*cb)(bool on)) { s_screen_cb = cb; }

static void screen_on(void)
{
    if (!s_screen_off || s_wake_inhibit) return;
    ESP_LOGI(TAG, "亮屏");
    if (s_screen_cb) s_screen_cb(true);      /* 先提频，再画 */
    s_screen_off = false;
    /* 熄屏时面板睡了（见 screen_off_now），先叫醒它（驱动里等 100ms），再开背光 */
    esp_lcd_panel_disp_sleep(display_panel(), false);
    display_backlight(s_brightness);
    display_touch_sleep(false);              /* 按键点亮的：触摸芯片复位醒来，约 150ms 后能点 */
    lv_display_trigger_activity(NULL);
}

static void bright_show_value(void)
{
    char buf[8];
    snprintf(buf, sizeof(buf), "%u%%", s_brightness);
    set_text(s_bright_pct, buf);
    lv_obj_set_height(s_bright_fill, TRACK_H * s_brightness / 100);
    lv_obj_set_y(s_bright_fill, TRACK_H - TRACK_H * s_brightness / 100);
}

static void bright_close(lv_timer_t *t)
{
    LV_UNUSED(t);
    if (s_bright_timer) { lv_timer_delete(s_bright_timer); s_bright_timer = NULL; }
    if (lv_obj_has_flag(s_bright, LV_OBJ_FLAG_HIDDEN)) return;
    show(s_bright, false);
    if (s_brightness_saver) s_brightness_saver(s_brightness);   /* 收起时才存一次，拖动过程中不写 flash */
}

static void bright_touch_timer(void)
{
    /* 4 秒不碰自动收起 */
    if (s_bright_timer) lv_timer_reset(s_bright_timer);
    else { s_bright_timer = lv_timer_create(bright_close, 4000, NULL); lv_timer_set_repeat_count(s_bright_timer, 1); }
}

static void bright_open(void)
{
    bright_show_value();
    show(s_bright, true);
    lv_obj_move_foreground(s_bright);
    bright_touch_timer();
}

static void bright_track_event(lv_event_t *e)
{
    lv_event_code_t code = lv_event_get_code(e);
    if (code != LV_EVENT_PRESSED && code != LV_EVENT_PRESSING) return;
    lv_indev_t *indev = lv_indev_active();
    if (!indev) return;
    lv_point_t p;
    lv_indev_get_point(indev, &p);
    lv_area_t a;
    lv_obj_get_coords(s_bright_track, &a);
    int32_t pct = (a.y2 - p.y) * 100 / TRACK_H;
    if (pct < BRIGHT_MIN) pct = BRIGHT_MIN;      /* 调到全黑就找不回来了 */
    if (pct > 100) pct = 100;
    if (pct != s_brightness) {
        s_brightness = (uint8_t)pct;
        display_backlight(s_brightness);
        bright_show_value();
    }
    bright_touch_timer();
}

static void bright_done(lv_event_t *e) { LV_UNUSED(e); bright_close(NULL); }

static void build_brightness(lv_obj_t *scr)
{
    s_bright = fill(scr, 0, 0, W, H, C_CONSOLE, 0);
    lv_obj_add_flag(s_bright, LV_OBJ_FLAG_CLICKABLE);     /* 挡住下面 */
    lv_obj_t *title = label(s_bright, &font_cn_24, C_INK);
    lv_label_set_text(title, "亮度");
    lv_obj_set_pos(title, PAD, 14);
    s_bright_pct = label(s_bright, &font_num_44, C_INK);
    lv_obj_align(s_bright_pct, LV_ALIGN_TOP_RIGHT, -PAD, 6);
    lv_obj_t *hint = label(s_bright, &font_cn_16, C_INK_3);
    lv_label_set_text(hint, "上下拖动");
    lv_obj_set_pos(hint, PAD, 46);
    /* 竖条：白底灰边，下面是填满的墨绿。整条都能按，按哪就调到哪 */
    s_bright_track = fill(s_bright, (W - 72) / 2, 76, 72, TRACK_H, C_PAPER, 14);
    lv_obj_set_style_border_width(s_bright_track, 1, 0);
    lv_obj_set_style_border_color(s_bright_track, lv_color_hex(C_RULE_2), 0);
    lv_obj_add_flag(s_bright_track, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_flag(s_bright, INTERACTIVE);
    lv_obj_add_event_cb(s_bright_track, bright_track_event, LV_EVENT_ALL, NULL);
    s_bright_fill = fill(s_bright_track, 0, 0, 72, 0, C_ACT, 14);
    lv_obj_t *done = lv_button_create(s_bright);
    lv_obj_set_pos(done, PAD, H - 44 - 10);
    lv_obj_set_size(done, W - PAD * 2, 44);
    lv_obj_set_style_radius(done, S_BTN_R, 0);
    lv_obj_set_style_shadow_width(done, 0, 0);
    lv_obj_set_style_bg_color(done, lv_color_hex(C_INK), 0);
    lv_obj_t *dl = label(done, &font_cn_24, C_ON_ACT);
    lv_label_set_text(dl, "完成");
    lv_obj_center(dl);
    lv_obj_add_event_cb(done, bright_done, LV_EVENT_CLICKED, NULL);
    show(s_bright, false);
}

/* ── 翻屏 ─────────────────────────────────────────────────────── */

static uint32_t s_anim_steps;
static void pager_x_cb(void *obj, int32_t v) { s_anim_steps++; lv_obj_set_x((lv_obj_t *)obj, v); }
uint32_t ui_anim_steps(void) { uint32_t n = s_anim_steps; s_anim_steps = 0; return n; }

/* ★ 这里曾经在滑动期间临时切成整屏刷新（停下来再切回局部），测出来一次滑动能多出一两帧。
 * 实测不能用：切模式会动 LVGL 显示管线的内部状态，如果上一帧还在往屏上传，
 * flush 回调就回不来——界面整个冻住，没传完的那一块留成空白横条。
 * 断网时负载轻、撞不上，4G 一连上必现。别再加回来。*/
static void slide_mode(bool on) { LV_UNUSED(on); }

static void slide_anim_done(lv_anim_t *a) { LV_UNUSED(a); slide_mode(false); }

static void go_page(int page, bool animate)
{
    s_page = page;
    int32_t target = page ? -W : 0;
    lv_anim_delete(s_pager, pager_x_cb);
    if (animate) slide_mode(true); else slide_mode(false);
    if (animate) {
        lv_anim_t a;
        lv_anim_init(&a);
        lv_anim_set_var(&a, s_pager);
        lv_anim_set_exec_cb(&a, pager_x_cb);
        lv_anim_set_values(&a, lv_obj_get_x(s_pager), target);
        /* 200ms 不是拍脑袋：整屏合成 ~20ms + 80MHz 下传屏 15ms，单帧 35ms 是地板，
         * 140ms 的动画最多出 4 帧，看着就是"跳"。拉到 200ms 能出 6 帧，
         * 再长就开始显得拖沓了。*/
        lv_anim_set_duration(&a, 200);
        lv_anim_set_path_cb(&a, lv_anim_path_ease_out);
        lv_anim_set_completed_cb(&a, slide_anim_done);
        lv_anim_start(&a);
    } else {
        lv_obj_set_x(s_pager, target);
    }
    lv_obj_set_style_bg_color(s_dot[0], lv_color_hex(page ? C_RULE_2 : C_INK), 0);
    lv_obj_set_style_bg_color(s_dot[1], lv_color_hex(page ? C_INK : C_RULE_2), 0);
    lv_obj_set_width(s_dot[0], page ? 6 : 16);
    lv_obj_set_width(s_dot[1], page ? 16 : 6);
    lv_obj_set_x(s_dot[1], page ? 106 + 6 + 6 : 106 + 16 + 6);
}

static lv_point_t s_press_at;
static int32_t s_press_x0;

static void pager_event(lv_event_t *e)
{
    lv_event_code_t code = lv_event_get_code(e);
    lv_indev_t *indev = lv_indev_active();
    if (!indev) return;
    lv_point_t p;
    lv_indev_get_point(indev, &p);
    if (code == LV_EVENT_PRESSED) {
        s_press_at = p;
        s_press_x0 = lv_obj_get_x(s_pager);
        lv_anim_delete(s_pager, pager_x_cb);
        slide_mode(true);                 /* 手指一按就进滑动模式，跟手那段才不掉帧 */
    } else if (code == LV_EVENT_PRESSING) {
        int32_t dx = p.x - s_press_at.x;
        int32_t dy = p.y - s_press_at.y;
        /* 从顶上 40px 内往下拉超过 40px、而且主要是竖着拉：打开亮度面板 */
        if (s_press_at.y < 40 && dy > 40 && dy > LV_ABS(dx) * 2 && lv_obj_has_flag(s_bright, LV_OBJ_FLAG_HIDDEN)) {
            go_page(s_page, false);
            bright_open();
            return;
        }
        if (!lv_obj_has_flag(s_bright, LV_OBJ_FLAG_HIDDEN)) return;
        /* 主要是竖着拉（在第二屏滚时刻表）：页面别跟着手指的一点横向抖动左右晃 */
        if (LV_ABS(dy) > LV_ABS(dx) && lv_obj_get_x(s_pager) == s_press_x0) return;
        int32_t x = s_press_x0 + dx;
        if (x > 0) x /= 3;                          /* 到头了：阻尼，提示没有更多屏 */
        if (x < -W) x = -W + (x + W) / 3;
        lv_obj_set_x(s_pager, x);
    } else if (code == LV_EVENT_RELEASED || code == LV_EVENT_PRESS_LOST) {
        int32_t dx = p.x - s_press_at.x;
        int32_t dy = p.y - s_press_at.y;
        if (!lv_obj_has_flag(s_bright, LV_OBJ_FLAG_HIDDEN)) return;
        /* 轻点时钟（A 屏状态带 / B 屏大时钟）：也打开亮度面板 */
        if (code == LV_EVENT_RELEASED && LV_ABS(dx) < 8 && LV_ABS(dy) < 8 && s_press_at.y < (s_page ? 90 : 74) && !s_card_id[0]) {
            go_page(s_page, false);
            bright_open();
            return;
        }
        /* 松手直接切过去，不做滑动动画。
         *
         * 整屏每动一次都要重画 76800 个像素再发给屏，实测一帧 50ms——200ms 的动画
         * 只画得出 3 帧，看到的是跳，不是滑。而一帧到位反倒干净：亮度面板就是
         * show() 出来的，同样一帧 50ms，看着却是"啪一下出来了"。
         * 卡顿是动画暴露出来的，不是动画造成的；这块屏配 PSRAM 画布，
         * 整屏动画的地板就在 40~50ms 一帧，换缓冲位置、提优先级、改成搬位图都试过，
         * 减不掉这个数（详见 drv_display.c 里 pclk 那段注释）。*/
        if (dx <= -SWIPE_PAGE_PX && s_page == 0) go_page(1, false);
        else if (dx >= SWIPE_PAGE_PX && s_page == 1) go_page(0, false);
        else go_page(s_page, false);
    }
}

/* ── 回执纸条：左右划掉 ───────────────────────────────────────── */

static void rebuild_stack(void);
typedef enum { D_DONE, D_FAILED, D_RUNNING } detail_state_t;
static void open_detail(detail_state_t st, const char *status, const char *tool, const char *at,
                        const char *title, const char *evidence);
static void message_common(const char *title, const char *sub, int pct, const char *note, bool sleep_style);
static void toast(const char *text, bool ok);

static void reset_slot_gestures(void)
{
    for (int i = 0; i < STACK_SLOTS; ++i) {
        s_slot_gesture_id[i][0] = '\0';
        if (!s_slot[i]) continue;
        lv_anim_delete(s_slot[i], pager_x_cb);
        lv_obj_set_x(s_slot[i], 8);
        lv_obj_set_style_opa(s_slot[i], LV_OPA_COVER, 0);
    }
}

static void slot_out_ready(lv_anim_t *a)
{
    lv_obj_t *slot = a->var;
    int i = (int)(intptr_t)lv_obj_get_user_data(slot);
    int r = -1;
    for (int k = 0; k < s_receipt_count; ++k)
        if (s_slot_gesture_id[i][0] && strcmp(s_receipts[k].id, s_slot_gesture_id[i]) == 0) { r = k; break; }
    if (r >= 0 && s_action_handler && s_action_handler(s_receipts[r].id, "dismiss")) {
        memmove(&s_receipts[r], &s_receipts[r + 1], sizeof(ui_receipt_t) * (size_t)(s_receipt_count - r - 1));
        --s_receipt_count;
    } else if (r >= 0) {
        toast("同步繁忙，请再试一次", false);
    }
    lv_obj_set_x(slot, 8);
    lv_obj_set_style_opa(slot, LV_OPA_COVER, 0);
    rebuild_stack();
}

static void slot_anim_x(lv_obj_t *slot, int32_t to, bool dismiss)
{
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, slot);
    lv_anim_set_exec_cb(&a, pager_x_cb);
    lv_anim_set_values(&a, lv_obj_get_x(slot), to);
    lv_anim_set_duration(&a, dismiss ? 160 : 140);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_out);
    if (dismiss) lv_anim_set_completed_cb(&a, slot_out_ready);
    lv_anim_start(&a);
}

static void slot_event(lv_event_t *e)
{
    lv_obj_t *slot = lv_event_get_target(e);
    int i = (int)(intptr_t)lv_obj_get_user_data(slot);
    if (s_slot_receipt[i] < 0) return;
    lv_event_code_t code = lv_event_get_code(e);
    lv_indev_t *indev = lv_indev_active();
    if (!indev) return;
    lv_point_t p;
    lv_indev_get_point(indev, &p);
    if (code == LV_EVENT_PRESSED) {
        s_press_at = p;
        lv_anim_delete(slot, pager_x_cb);
        ui_copy_utf8(s_slot_gesture_id[i], sizeof(s_slot_gesture_id[i]), s_receipts[s_slot_receipt[i]].id);
    } else if (code == LV_EVENT_PRESSING) {
        if (!s_slot_gesture_id[i][0]) return;
        int32_t dx = p.x - s_press_at.x;
        lv_obj_set_x(slot, 8 + dx);
        int32_t fade = LV_ABS(dx) * 2;
        lv_obj_set_style_opa(slot, (lv_opa_t)(fade > 160 ? 95 : 255 - fade), 0);
    } else if (code == LV_EVENT_RELEASED || code == LV_EVENT_PRESS_LOST) {
        if (!s_slot_gesture_id[i][0]) return;
        int32_t dx = p.x - s_press_at.x;
        if (code == LV_EVENT_RELEASED && LV_ABS(dx) >= SWIPE_DISMISS_PX && LV_ABS(dx) > LV_ABS(p.y - s_press_at.y)) {
            slot_anim_x(slot, dx > 0 ? W + 10 : -W - 10, true); return;
        }
        slot_anim_x(slot, 8, false);
        lv_obj_set_style_opa(slot, LV_OPA_COVER, 0);
        /* 没划动就是点了一下：打开详情，而不是什么都不发生 */
        if (code == LV_EVENT_RELEASED && LV_ABS(dx) < 8 && LV_ABS(p.y - s_press_at.y) < 8) {
            const ui_receipt_t *r = &s_receipts[s_slot_receipt[i]];
            open_detail(r->failed ? D_FAILED : D_DONE, r->failed ? "执行失败" : done_word(r->tool),
                        r->tool, r->at, r->title, r->evidence);
        }
    }
}

/* ── 提示条 ───────────────────────────────────────────────────── */

static void toast_hide(lv_timer_t *timer)
{
    LV_UNUSED(timer);
    show(s_toast, false);
    s_toast_timer = NULL;
}

static void toast(const char *text, bool ok)
{
    lv_obj_set_style_border_color(s_toast, lv_color_hex(ok ? C_ACT : C_BAD), 0);
    lv_obj_set_style_text_color(s_toast_label, lv_color_hex(ok ? C_ACT : C_BAD), 0);
    lv_label_set_text(s_toast_label, text);
    show(s_toast, true);
    lv_obj_move_foreground(s_toast);
    if (s_toast_timer) lv_timer_delete(s_toast_timer);
    s_toast_timer = lv_timer_create(toast_hide, 2000, NULL);
    lv_timer_set_repeat_count(s_toast_timer, 1);
}

/* ── 按钮 ─────────────────────────────────────────────────────── */

static void set_busy(bool busy)
{
    s_busy = busy;
    if (busy) {
        lv_obj_add_state(s_btn_cancel, LV_STATE_DISABLED);
        lv_obj_add_state(s_btn_confirm, LV_STATE_DISABLED);
        lv_label_set_text(s_btn_confirm_label, "处理中");
    } else {
        lv_obj_remove_state(s_btn_cancel, LV_STATE_DISABLED);
        lv_obj_remove_state(s_btn_confirm, LV_STATE_DISABLED);
        lv_label_set_text(s_btn_confirm_label, "确认");
    }
}

static void button_clicked(lv_event_t *e)
{
    if (s_busy || !s_card_id[0] || !s_action_handler) return;
    const char *verb = lv_event_get_user_data(e);
    if (s_action_handler(s_card_id, verb)) set_busy(true);
    else toast("操作繁忙，请再试一次", false);
}

static lv_obj_t *button(lv_obj_t *parent, int x, int w, const char *text, bool primary, const char *verb, lv_obj_t **text_out)
{
    lv_obj_t *b = lv_button_create(parent);
    lv_obj_set_pos(b, x, 264);
    lv_obj_set_size(b, w, 44);
    lv_obj_set_style_radius(b, S_BTN_R, 0);
    lv_obj_set_style_shadow_width(b, 0, 0);
    lv_obj_set_style_bg_opa(b, LV_OPA_COVER, 0);
    lv_obj_set_style_opa(b, 110, LV_STATE_DISABLED);
    if (primary) {
        lv_obj_set_style_bg_color(b, lv_color_hex(C_ACT), 0);
        /* 按下变深是唯一的即时反馈——没有它，用户不知道屏幕收到没有 */
        lv_obj_set_style_bg_color(b, lv_color_hex(C_ACT_PRESS), LV_STATE_PRESSED);
    } else {
        lv_obj_set_style_bg_color(b, lv_color_hex(C_PAPER), 0);
        lv_obj_set_style_bg_color(b, lv_color_hex(C_CONSOLE), LV_STATE_PRESSED);
    }
    if (S_EDGE) {
        /* 有垫层的主题：按钮也是一张垫高的纸片，按下去垫层消失、整块往右下沉——像真的按下了纸 */
        paper_edge(b, C_RULE, primary ? C_ACT_PRESS : C_EDGE);
        lv_obj_set_style_border_width(b, 0, LV_STATE_PRESSED);
        lv_obj_set_style_translate_x(b, S_EDGE, LV_STATE_PRESSED);
        lv_obj_set_style_translate_y(b, S_EDGE, LV_STATE_PRESSED);
    } else if (!primary) {
        lv_obj_set_style_border_width(b, 2, 0);
        lv_obj_set_style_border_color(b, lv_color_hex(C_RULE_2), 0);
    }
    lv_obj_t *l = label(b, &font_cn_24, primary ? C_ON_ACT : C_INK_2);
    lv_label_set_text(l, text);
    lv_obj_center(l);
    lv_obj_add_event_cb(b, button_clicked, LV_EVENT_CLICKED, (void *)verb);
    lv_obj_add_flag(b, INTERACTIVE);
    if (text_out) *text_out = l;
    return b;
}

/* ── A 屏纸条区：按优先级排 3 个位置 ─────────────────────────────
 * 1. 电量低（没在充）  2. 离线且有待传  3. 回执（可划）  4. 没有回执时：今天的概况 */

static void fill_slot(int i, uint32_t bar, uint32_t meta_color, const char *meta, const char *time_text,
                      const char *title, const char *sub, int receipt)
{
    s_slot_receipt[i] = receipt;
    if (receipt >= 0) lv_obj_add_flag(s_slot[i], LV_OBJ_FLAG_CLICKABLE);
    else lv_obj_remove_flag(s_slot[i], LV_OBJ_FLAG_CLICKABLE);   /* 不能划的纸条：手势交给翻屏 */
    lv_obj_set_y(s_slot_sub[i], 50);
    lv_obj_set_style_bg_color(s_slot_bar[i], lv_color_hex(bar), 0);
    set_color(s_slot_meta[i], meta_color);
    set_text(s_slot_meta[i], meta);
    lv_obj_set_width(s_slot_meta[i], time_text && time_text[0] ? 132 : 192);
    lv_obj_set_height(s_slot_meta[i], 20);
    lv_label_set_long_mode(s_slot_meta[i], LV_LABEL_LONG_DOT);
    set_text(s_slot_time[i], time_text ? time_text : "");
    set_color(s_slot_time[i], C_INK_3);
    set_text(s_slot_title[i], title);
    set_text(s_slot_sub[i], sub ? sub : "");
    show(s_slot_sub[i], sub && sub[0]);
    strip_height(s_slot[i], s_slot_bar[i], sub && sub[0] ? 74 : 54);
    show(s_slot[i], true);
}

/* 录音行下面那一行：今天全天（云端统计）或本次开机（还没拉到）。
 * 以前这组数字放在一张纸条里、只在没有回执时出现——回执一刷新它就时有时无，第二行字还被裁掉一半。
 * 现在固定占一行；拉到过一次就一直显示最后的值，断网也不退回"本次开机"。*/
static void update_stats_line(void)
{
    const ui_status_t *st = &s_last;
    char buf[64], dur[24];
    /* 云端统计 5 分钟才拉一次：中间录的时长本机补上，数字不会一顿一顿地跳 */
    uint32_t sec = s_today.valid
        ? ui_recorded_since_snapshot(s_today.recorded_sec, s_today_recorded_baseline, st->recording_seconds)
        : st->recording_seconds;
    if (sec >= 3600) snprintf(dur, sizeof(dur), "%lu小时%lu分", (unsigned long)(sec / 3600), (unsigned long)(sec / 60 % 60));
    else snprintf(dur, sizeof(dur), "%lu分钟", (unsigned long)(sec / 60));
    if (s_today.valid) snprintf(buf, sizeof(buf), "今天录 %s・办 %lu 件", dur, (unsigned long)s_today.done);
    else snprintf(buf, sizeof(buf), "本次开机录了 %s", dur);
    set_text(s_stats, buf);
}

static void rebuild_stack(void)
{
    const ui_status_t *st = &s_last;
    bool low = st->battery_pct >= 0 && st->battery_pct < 15 && !st->charging;
    bool offline = !st->network;
    ui_stack_plan_t plan = ui_stack_plan(low || offline, s_receipt_count, S_EDGE ? S_CARD_BW : 0);
    reset_slot_gestures();
    update_stats_line();
    show(s_stats, true);
    for (int i = 0; i < STACK_SLOTS; ++i) {
        if (i >= plan.count) { s_slot_receipt[i] = -1; show(s_slot[i], false); continue; }
        lv_obj_set_style_text_font(s_slot_title[i], &font_cn_16, 0);
        lv_obj_set_height(s_slot_title[i], 24);
        int r = plan.slots[i].receipt;
        if (r < 0) {
            char title[64];
            if (low && offline) snprintf(title, sizeof(title), "余电%d%%・%lu段待传", st->battery_pct, (unsigned long)st->pending_uploads);
            else if (low) snprintf(title, sizeof(title), "余电%d%%，请充电", st->battery_pct);
            else snprintf(title, sizeof(title), "%lu段待传，联网后同步", (unsigned long)st->pending_uploads);
            fill_slot(i, low ? C_BAD : C_WARN, low ? C_BAD : C_WARN,
                      low && offline ? "低电・离线" : low ? "电量低" : "离线・本地缓存", NULL, title, NULL, -1);
        } else {
            const tool_look_t *lk = look_of(s_receipts[r].tool);
            char meta[64];
            snprintf(meta, sizeof(meta), "%s・%s", s_receipts[r].failed ? "执行失败" : lk->tool[0] == 'n' ? "已记下" : "已执行", lk->label);
            fill_slot(i, s_receipts[r].failed ? C_BAD : look_color(lk), s_receipts[r].failed ? C_BAD : look_ink(lk),
                  meta, s_receipts[r].at, s_receipts[r].title, NULL, r);
        }
        lv_obj_set_y(s_slot[i], plan.slots[i].y);
    }
    int more = s_receipt_count - plan.receipts;
    char hint[48];
    if (more > 0) snprintf(hint, sizeof(hint), "还有 %d 条，左滑看全部", more);
    else if (plan.count == 0) snprintf(hint, sizeof(hint), "有要确认的事会出现在这里");
    else hint[0] = '\0';
    set_text(s_hint, hint);
    lv_obj_set_y(s_hint, plan.count == 0 ? 196 : 272);
    show(s_hint, hint[0] != '\0');
}

/* ── A 屏：卡片 / 常态切换 ──────────────────────────────────────── */

static void apply_card_mode(void)
{
    bool card = s_card_id[0] != '\0';
    show(s_head, !card);
    show(s_recrow, !card);
    for (int i = 0; i < STACK_SLOTS; ++i) if (card) show(s_slot[i], false);
    if (card) { show(s_hint, false); show(s_stats, false); }
    show(s_mini, card);
    show(s_card, card);
    show(s_btn_cancel, card);
    show(s_btn_confirm, card);
    if (!card) rebuild_stack();
}

/* ── B 屏：时刻表 ─────────────────────────────────────────────── */

/* 以前只有"待确认"的行可点，已执行、已失败的行设成不可点——可这里明明写了"已执行的打开详情"，
 * 两段自相矛盾，第二屏点任务就一直没反应。现在每行都可点。 */
static void row_clicked(lv_event_t *e)
{
    /* 左右划翻页时手指是从行上起的，松手时行也会收到一次"点击"：划过的不算 */
    lv_indev_t *indev = lv_indev_active();
    if (indev) {
        lv_point_t p;
        lv_indev_get_point(indev, &p);
        if (LV_ABS(p.x - s_press_at.x) > 8 || LV_ABS(p.y - s_press_at.y) > 8) return;
    }
    lv_obj_t *row = lv_event_get_target(e);
    int i = (int)(intptr_t)lv_obj_get_user_data(row);
    if (i < 0 || i >= s_row_count) return;
    const ui_timeline_row_t *r = &s_rows[i];
    if (strcmp(r->status, "pending") == 0) { go_page(0, false); return; }  /* 待确认的：回 A 屏去签 */
    bool failed = strcmp(r->status, "failed") == 0, done = strcmp(r->status, "executed") == 0;
    open_detail(failed ? D_FAILED : done ? D_DONE : D_RUNNING, failed ? "执行失败" : done ? done_word(r->tool) : "执行中",
                r->tool, r->at, r->title, r->evidence);
}

static void rebuild_timeline(void)
{
    for (int i = 0; i < UI_MAX_TIMELINE; ++i) {
        if (i >= s_row_count) { show(s_b_row[i], false); continue; }
        const ui_timeline_row_t *r = &s_rows[i];
        const tool_look_t *lk = look_of(r->tool);
        bool pending = strcmp(r->status, "pending") == 0;
        bool failed = strcmp(r->status, "failed") == 0;
        set_text(s_b_at[i], r->at);
        set_text(s_b_kind[i], short_kind(r->tool));
        set_color(s_b_kind[i], failed ? C_BAD : pending ? C_EXT_INK : look_ink(lk));
        char title[160];
        snprintf(title, sizeof(title), "%s%s", r->title, failed ? "（失败）" : "");
        set_text(s_b_title[i], title);
        lv_obj_set_style_bg_opa(s_b_row[i], pending ? LV_OPA_COVER : LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(s_b_row[i], pending ? 2 : 0, 0);
        show(s_b_row[i], true);
    }
    show(s_b_empty, s_row_count == 0);
}

/* ── 每秒刷新 ─────────────────────────────────────────────────── */

static void battery_icon(int pct, bool charging)
{
    uint32_t c = charging ? C_HEAD_OK : (pct >= 0 && pct < 15) ? C_HEAD_BAD : C_HEAD_INK;
    lv_obj_set_style_border_color(s_bat_shell, lv_color_hex(c), 0);
    lv_obj_set_style_bg_color(s_bat_fill, lv_color_hex(c), 0);
    lv_obj_set_style_bg_color(s_bat_nub, lv_color_hex(c), 0);
    int w = pct < 0 ? 0 : (pct * 16 + 50) / 100;
    if (pct > 0 && w < 2) w = 2;
    if (lv_obj_get_width(s_bat_fill) != w) lv_obj_set_width(s_bat_fill, w);
}

static void status_tick(lv_timer_t *timer)
{
    /* 界面心跳：这个定时器跑在 LVGL 任务里，界面一冻住这条日志就停。
     * 串口控制台在 4G 上来之后经常不收命令，光看日志没法判断界面死没死，所以留着这条。*/
    static uint32_t beats;
    if (++beats % 10 == 1) ESP_LOGI(TAG, "界面心跳 #%lu（第 %lu 秒）", (unsigned long)beats, (unsigned long)(beats));
    LV_UNUSED(timer);
    ui_status_t st = { .battery_pct = -1 };
    if (s_status_provider) s_status_provider(&st);
    bool stack_dirty = st.network != s_last.network || st.charging != s_last.charging ||
                       st.pending_uploads != s_last.pending_uploads ||
                       (st.battery_pct < 15) != (s_last.battery_pct < 15) ||
                       st.paused != s_last.paused;
    bool stats_dirty = st.recording_seconds / 60 != s_last.recording_seconds / 60;
    s_last = st;

    char buf[48], hms[16];
    time_t now = time(NULL);
    struct tm tm;
    localtime_r(&now, &tm);
    if (st.time_valid) snprintf(buf, sizeof(buf), "%02d:%02d", tm.tm_hour, tm.tm_min);
    else snprintf(buf, sizeof(buf), "--:--");
    set_text(s_clock, buf);
    set_text(s_mini_clock, buf);
    set_text(s_b_clock, buf);

    static const char *WEEK[] = {"周日", "周一", "周二", "周三", "周四", "周五", "周六"};
    char date[32];
    if (st.time_valid) snprintf(date, sizeof(date), "%s %d月%d日", WEEK[tm.tm_wday], tm.tm_mon + 1, tm.tm_mday);
    else snprintf(date, sizeof(date), "等待联网对时");
    set_text(s_b_date, date);
    /* A 屏右上第二行：平时是日期；充电时换成充电状态——那一刻用户最想知道的就是这个 */
    if (st.charging) { set_text(s_date, st.charge_full ? "已充满" : "充电中"); set_color(s_date, C_HEAD_OK); }
    else { set_text(s_date, date); set_color(s_date, C_HEAD_INK_2); }

    if (st.battery_pct < 0) snprintf(buf, sizeof(buf), "--%%");
    else snprintf(buf, sizeof(buf), "%d%%", st.battery_pct);
    set_text(s_bat_pct, buf);
    set_color(s_bat_pct, st.charging ? C_HEAD_OK : (st.battery_pct >= 0 && st.battery_pct < 15) ? C_HEAD_BAD : C_HEAD_INK);
    battery_icon(st.battery_pct, st.charging);
    show(s_bolt, st.charging);
    /* 紧凑状态带和 B 屏没地方画电池图标：充电时在百分比前加 + */
    if (st.battery_pct < 0) snprintf(buf, sizeof(buf), "--%%");
    else snprintf(buf, sizeof(buf), "%s%d%%", st.charging ? "+" : "", st.battery_pct);
    set_text(s_mini_bat, buf);
    set_text(s_b_pill_bat, buf);
    set_color(s_b_pill_bat, st.charging ? C_RECD : C_INK);

    /* 录音行：录着是红点 + 走时；麦克风 2 秒没数据就是琥珀色"录音异常"，两种状态绝不能看混 */
    fmt_hms(hms, sizeof(hms), st.recording_seconds);
    /* 三种状态要分得清：在录 / 用户自己暂停了 / 麦克风没数据（异常） */
    set_text(s_rec_label, st.recording ? "录音中" : st.paused ? "已暂停" : "录音异常");
    set_color(s_rec_label, st.recording ? C_INK : st.paused ? C_INK_2 : C_WARN);
    set_text(s_rec_time, st.recording ? hms : st.paused ? "按录音键继续" : "无数据");
    set_color(s_rec_time, st.recording ? C_INK_2 : st.paused ? C_INK_3 : C_WARN);
    int rec_width = st.recording ? 75 : W - PAD - 98;
    if (lv_obj_get_style_width(s_rec_time, 0) != rec_width) lv_obj_set_width(s_rec_time, rec_width);
    show(s_meter, st.recording);
    uint32_t dot = st.recording ? C_REC : st.paused ? C_RULE_2 : C_EXT;
    lv_obj_set_style_bg_color(s_rec_dot, lv_color_hex(dot), 0);
    lv_obj_set_style_bg_color(s_mini_dot, lv_color_hex(dot), 0);
    lv_obj_set_style_bg_color(s_b_pill_dot, lv_color_hex(dot), 0);
    set_text(s_mini_time, st.recording ? hms : st.paused ? "已暂停" : "录音异常");
    snprintf(buf, sizeof(buf), "%s %s", st.recording ? "录音" : st.paused ? "已暂停" : "异常", st.recording ? hms : "");
    set_text(s_b_pill_time, buf);

    /* C 类卡片 15 分钟作废：设备上要能看到还剩多久 */
    if (s_expires_in >= 0 && s_card_id[0]) {
        if (s_expires_in > 0) --s_expires_in;
        fmt_expiry(buf, sizeof(buf), s_expires_in);
        set_text(s_card_expiry, buf);
    }
    if (stack_dirty && !s_card_id[0]) rebuild_stack();
    else if (stats_dirty && !s_card_id[0]) update_stats_line();

    /* 熄屏：有待确认的卡片、关机/升级这类全屏提示、亮度面板开着时都不熄。
     * 「已暂停录音」是长期停在那儿的提示，照常按设置的时间熄屏——不然暂停一晚上屏就亮一晚上。*/
    bool msg_open = !lv_obj_has_flag(s_msg, LV_OBJ_FLAG_HIDDEN);
    bool busy_screen = s_card_id[0] || (msg_open && s_msg_keeps_awake) || !lv_obj_has_flag(s_bright, LV_OBJ_FLAG_HIDDEN);
    if (!s_screen_off && s_screen_timeout && !busy_screen &&
        lv_display_get_inactive_time(NULL) >= (uint32_t)s_screen_timeout * 1000) {
        screen_off_now();
        ESP_LOGI(TAG, "%u 秒没碰，熄屏", s_screen_timeout);
    }
}

/* 电平条：每 100ms 把历史左移一格压入当前音量。只在 A 屏常态、看得见的时候画，
 * 一次只动右上角 51x18 的一小块。*/
static void level_tick(lv_timer_t *timer)
{
    LV_UNUSED(timer);
    if (s_page != 0 || s_card_id[0] || s_screen_off || s_last.paused) return;   /* 看不见就不画 */
    ui_status_t st = { .battery_pct = -1 };
    if (s_status_provider) s_status_provider(&st);
    memmove(s_level_hist, s_level_hist + 1, LEVEL_BARS - 1);
    s_level_hist[LEVEL_BARS - 1] = st.recording ? st.input_level : 0;
    for (int i = 0; i < LEVEL_BARS; ++i) {
        int h = 3 + (int)s_level_hist[i] * 15 / 100;     /* 3..18 px */
        if (lv_obj_get_height(s_level[i]) != h) {
            lv_obj_set_height(s_level[i], h);
            lv_obj_set_y(s_level[i], (18 - h) / 2);
        }
    }
}

/* ── 触摸 ─────────────────────────────────────────────────────── */

/* 点了会做事的地方（卡片按钮、回执纸条、时刻表行、详情页、整屏提醒、亮度面板）：双击熄屏不算它们，
 * 免得双击熄屏时顺手签了一张卡 */
static bool touch_hits_interactive(lv_point_t p)
{
    lv_obj_t *o = lv_indev_search_obj(lv_layer_top(), &p);
    if (!o) o = lv_indev_search_obj(lv_screen_active(), &p);
    for (; o; o = lv_obj_get_parent(o)) if (lv_obj_has_flag(o, INTERACTIVE)) return true;
    return false;
}

static void touch_read(lv_indev_t *indev, lv_indev_data_t *data)
{
    LV_UNUSED(indev);
    /* 熄屏时不再每 30ms 去问一次触摸芯片（I2C 读一次、CPU 醒一次，一秒 33 次）：等它按下时的中断；
     * 每 300ms 兜底问一次，万一中断没挂上也还能点亮 */
    static uint32_t off_poll_ms;
    /* 碰屏幕亮屏关着：熄屏期间触摸芯片深睡（约 5µA，不扫描），根本不去读它，只等按键 */
    if (s_screen_off && !s_tap_wake) { display_touch_sleep(true); data->state = LV_INDEV_STATE_RELEASED; return; }
    if (s_screen_off) {
        display_touch_sleep(false);          /* 熄屏中途把开关打开的情况 */
        uint32_t now = lv_tick_get();
        if (!display_touch_irq_take() && now - off_poll_ms < 300) { data->state = LV_INDEV_STATE_RELEASED; return; }
        off_poll_ms = now;
    }
    uint16_t x = 0, y = 0;
    bool pressed = display_touch_read(&x, &y);
    if (pressed && s_screen_off) { screen_on(); s_swallow_touch = true; }
    if (!pressed) s_swallow_touch = false;
    lv_point_t pt = { x < W ? x : W - 1, y < H ? y : H - 1 };

    /* 双击空白处熄屏：两下都是短按（<300ms、没怎么移动），间隔 <450ms、位置相近，而且都没点在会做事的地方。
     * 点亮屏幕的那一下（被吞掉的）不算第一下 */
    static bool was_down, moved, down_free;
    static uint32_t down_ms, last_tap_ms;
    static lv_point_t down_pt, last_tap_pt;
    bool down = pressed && !s_swallow_touch;
    uint32_t now = lv_tick_get();
    if (down && !was_down) { down_ms = now; down_pt = pt; moved = false; down_free = !touch_hits_interactive(pt); }
    else if (down && (LV_ABS(pt.x - down_pt.x) > 14 || LV_ABS(pt.y - down_pt.y) > 14)) moved = true;
    if (!down && was_down) {
        bool tap = !moved && now - down_ms < 300 && down_free;
        if (tap && s_dtap_off && last_tap_ms && now - last_tap_ms < 450
            && LV_ABS(down_pt.x - last_tap_pt.x) < 50 && LV_ABS(down_pt.y - last_tap_pt.y) < 50) {
            last_tap_ms = 0;
            ESP_LOGI(TAG, "双击空白处：熄屏");
            screen_off_now();
        } else if (tap) { last_tap_ms = now; last_tap_pt = down_pt; }
        else last_tap_ms = 0;
    }
    was_down = down;

    if (down) {
        data->point = pt;
        data->state = LV_INDEV_STATE_PRESSED;
    } else {
        data->state = LV_INDEV_STATE_RELEASED;
    }
}

/* ── 搭界面 ───────────────────────────────────────────────────── */

static void detail_clicked(lv_event_t *e)
{
    LV_UNUSED(e);
    ui_close_detail();
}

/* 分段计时：渲染（LVGL 把像素画进缓冲）和传输（SPI 发给屏）是串行的，
 * 分开看才知道该优化哪一头。用 esp_timer 而不是 lv_tick——FreeRTOS 一个 tick 就是
 * 10ms，拿它量 80ms 的帧只有一位有效数字。*/
static void render_start(lv_event_t *e) { LV_UNUSED(e); if (s_measuring) s_render_t0 = esp_timer_get_time(); }

static void render_done(lv_event_t *e)
{
    LV_UNUSED(e);
    if (s_measuring && s_render_t0) s_render_us += esp_timer_get_time() - s_render_t0;
}

static void frame_done(lv_event_t *e)
{
    LV_UNUSED(e);
    if (!s_measuring) return;
    int64_t now = esp_timer_get_time();
    if (s_render_t0) s_flush_us += now - s_render_t0;   /* 渲染+传输合计 */
    uint32_t ms = (uint32_t)((now - s_frame_t0) / 1000);
    if (s_frame_last) {
        uint32_t dt = ms - s_frame_last;
        if (dt > s_frame_worst_ms) s_frame_worst_ms = dt;
    }
    if (s_frames < 12) {
        s_frame_at[s_frames] = (uint16_t)ms;
        s_frame_cost[s_frames] = (uint16_t)((now - s_render_t0) / 1000);
    }
    s_frame_last = ms;
    s_frames++;
}

void ui_measure_start(void)
{
    s_frames = 0; s_frame_worst_ms = 0; s_frame_last = 0;
    s_render_us = 0; s_flush_us = 0; s_render_t0 = 0;
    s_frame_t0 = esp_timer_get_time();
    s_measuring = true;
}

void ui_measure_report(uint32_t *fps_x10, uint32_t *worst_ms, uint32_t *frames)
{
    s_measuring = false;
    uint32_t elapsed = (uint32_t)((esp_timer_get_time() - s_frame_t0) / 1000);
    *frames = s_frames;
    *worst_ms = s_frame_worst_ms;
    *fps_x10 = elapsed ? (s_frames * 10000u) / elapsed : 0;
}

/* 把这一轮每帧的"第几毫秒发生、花了多久"抄出来，最多 12 帧 */
uint32_t ui_measure_trace(uint16_t *at, uint16_t *cost, uint32_t max)
{
    uint32_t n = s_frames < max ? s_frames : max;
    if (n > 12) n = 12;
    for (uint32_t i = 0; i < n; ++i) { at[i] = s_frame_at[i]; cost[i] = s_frame_cost[i]; }
    return n;
}

void ui_measure_split(uint32_t *render_ms_x10, uint32_t *total_ms_x10)
{
    *render_ms_x10 = s_frames ? (uint32_t)(s_render_us * 10 / (int64_t)s_frames / 1000) : 0;
    *total_ms_x10 = s_frames ? (uint32_t)(s_flush_us * 10 / (int64_t)s_frames / 1000) : 0;
}

/* 整屏刷新：滑动时整屏都在动，一次渲染一次发送比拆成好几块划算；
 * 静止时反过来——秒数跳一下也重画整屏，白烧 CPU。所以按需切换。*/
static bool s_full_refresh;

void ui_set_full_refresh(bool on)
{
    if (!s_disp || on == s_full_refresh) return;   /* 切一次就整屏重画一遍，别白切 */
    /* 缓冲本来就是整屏大小，两种模式用的是同一块内存，所以只改模式就够了；
     * 用 lv_display_set_buffers 会顺带把 draw_buf 重新初始化一遍，滑动时每次翻页切两回，
     * 实测单帧要多花 30ms 以上。*/
    if (!lvgl_port_lock(200)) return;
    lv_display_set_render_mode(s_disp, on ? LV_DISPLAY_RENDER_MODE_FULL : LV_DISPLAY_RENDER_MODE_PARTIAL);
    s_full_refresh = on;      /* 真的切成功了才记下来：拿不到锁就早退的话，
                               * 记号和实际模式会永久对不上，之后每次切都被当成"已经是这个模式"跳过 */
    lvgl_port_unlock();
}

static void build_detail(lv_obj_t *scr)
{
    /* 详情页（刚办完弹出来、点纸条/时刻表行打开）：台面上一张回执。
     *   顶上：状态章（圆底 + 勾/叉）+「已执行」大字 + 钟点
     *   下面一张纸条：左边卡槽色条，类型小标签（飞书任务/笔记…），标题；有原话才加一段引文
     * 颜色、圆角、描边、剪纸垫层全按当前主题取，换主题自动跟着变。
     * 内容长度不定（标题最多 40 字、原话 60 字），纵向流式布局，整页能上下滚。*/
    s_detail = fill(scr, 0, 0, W, H, C_CONSOLE, 0);
    lv_obj_add_flag(s_detail, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(s_detail, detail_clicked, LV_EVENT_CLICKED, NULL);
    lv_obj_add_flag(s_detail, INTERACTIVE);
    lv_obj_set_flex_flow(s_detail, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_hor(s_detail, PAD, 0);
    lv_obj_set_style_pad_top(s_detail, 18, 0);
    lv_obj_set_style_pad_row(s_detail, 14, 0);
    lv_obj_set_style_pad_bottom(s_detail, 34, 0);       /* 给底部那行提示留位 */
    lv_obj_add_flag(s_detail, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_scroll_dir(s_detail, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(s_detail, LV_SCROLLBAR_MODE_AUTO);

    /* 状态行 */
    lv_obj_t *head = box(s_detail, 0, 0, W - PAD * 2, 34);
    s_detail_badge = fill(head, 0, 2, 30, 30, C_RECD, LV_RADIUS_CIRCLE);
    s_detail_badge_sym = label(s_detail_badge, &lv_font_montserrat_14, C_ON_ACT);
    lv_obj_center(s_detail_badge_sym);
    s_detail_meta = label(head, &font_cn_24, C_INK);
    lv_obj_align(s_detail_meta, LV_ALIGN_LEFT_MID, 40, 0);
    s_detail_time = label(head, &font_cn_16, C_INK_3);
    lv_obj_align(s_detail_time, LV_ALIGN_RIGHT_MID, 0, 0);

    /* 回执纸条 */
    s_detail_card = fill(s_detail, 0, 0, W - PAD * 2, 10, C_PAPER, S_CARD_R);
    paper_edge(s_detail_card, C_RULE, C_EDGE);
    lv_obj_set_height(s_detail_card, LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(s_detail_card, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_left(s_detail_card, 18, 0);
    lv_obj_set_style_pad_right(s_detail_card, 12, 0);
    lv_obj_set_style_pad_ver(s_detail_card, 12, 0);
    lv_obj_set_style_pad_row(s_detail_card, 8, 0);
    /* 卡槽色条：不参与排版，高度在打开时按纸条实际高度算 */
    s_detail_bar = fill(s_detail_card, 0, 0, 5, 10, C_OWN, 2);
    lv_obj_add_flag(s_detail_bar, LV_OBJ_FLAG_IGNORE_LAYOUT);

    s_detail_chip = label(s_detail_card, &font_cn_16, C_OWN_INK);
    lv_obj_set_style_border_width(s_detail_chip, 1, 0);
    lv_obj_set_style_radius(s_detail_chip, S_CHIP_R, 0);
    lv_obj_set_style_pad_hor(s_detail_chip, 6, 0);
    lv_obj_set_style_pad_ver(s_detail_chip, 1, 0);

    s_detail_title = label(s_detail_card, &font_cn_24, C_INK);
    lv_obj_set_width(s_detail_title, lv_pct(100));
    lv_label_set_long_mode(s_detail_title, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_line_space(s_detail_title, 4, 0);

    /* 原话：左边一道细竖线的引文，没有就整段不显示 */
    s_detail_quote = box(s_detail_card, 0, 0, lv_pct(100), 10);
    lv_obj_set_height(s_detail_quote, LV_SIZE_CONTENT);
    lv_obj_set_style_border_width(s_detail_quote, 3, 0);
    lv_obj_set_style_border_side(s_detail_quote, LV_BORDER_SIDE_LEFT, 0);
    lv_obj_set_style_border_color(s_detail_quote, lv_color_hex(C_RULE_2), 0);
    lv_obj_set_style_pad_left(s_detail_quote, 8, 0);
    lv_obj_set_style_margin_top(s_detail_quote, 4, 0);
    s_detail_body = label(s_detail_quote, &font_cn_16, C_INK_2);
    lv_obj_set_width(s_detail_body, lv_pct(100));
    lv_label_set_long_mode(s_detail_body, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_line_space(s_detail_body, 3, 0);

    /* 底部提示钉在屏幕上，不跟着内容滚 */
    s_detail_back = label(scr, &font_cn_16, C_INK_3);
    lv_obj_set_width(s_detail_back, W);
    lv_obj_set_style_text_align(s_detail_back, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_pos(s_detail_back, 0, 296);
    set_text(s_detail_back, "点一下或按返回键关闭");
    show(s_detail, false);
    show(s_detail_back, false);
}

/** 打开详情页。status 是「已执行 / 已记下 / 执行失败 / 刚办完 / 执行中」这类两三个字；
 *  title 会自动换行，放得下服务端发过来的 40 个字；没有原话就不显示引文 */
static void open_detail(detail_state_t st, const char *status, const char *tool, const char *at,
                        const char *title, const char *evidence)
{
    const tool_look_t *lk = look_of(tool);
    uint32_t badge = st == D_FAILED ? C_BAD : st == D_RUNNING ? C_WARN : C_RECD;
    lv_obj_set_style_bg_color(s_detail_badge, lv_color_hex(badge), 0);
    lv_label_set_text(s_detail_badge_sym, st == D_FAILED ? LV_SYMBOL_CLOSE : st == D_RUNNING ? LV_SYMBOL_REFRESH : LV_SYMBOL_OK);
    set_text(s_detail_meta, status);
    set_color(s_detail_meta, st == D_FAILED ? C_BAD : C_INK);
    set_text(s_detail_time, at ? at : "");
    set_text(s_detail_chip, lk->label);
    set_color(s_detail_chip, look_ink(lk));
    lv_obj_set_style_border_color(s_detail_chip, lv_color_hex(look_color(lk)), 0);
    lv_obj_set_style_bg_color(s_detail_bar, lv_color_hex(look_color(lk)), 0);
    set_text(s_detail_title, title ? title : "");
    bool quote = evidence && evidence[0];
    if (quote) {
        char body[200];
        snprintf(body, sizeof(body), "“%s”", evidence);
        set_text(s_detail_body, body);
    }
    show(s_detail_quote, quote);
    lv_obj_scroll_to_y(s_detail, 0, LV_ANIM_OFF);
    show(s_detail, true);
    show(s_detail_back, true);
    lv_obj_move_foreground(s_detail);
    lv_obj_move_foreground(s_detail_back);
    lv_obj_update_layout(s_detail_card);
    int32_t h = lv_obj_get_height(s_detail_card);
    lv_obj_set_pos(s_detail_bar, -17, 4 - 12);           /* 相对内容区：抵掉左 18、上 12 的内边距 */
    lv_obj_set_height(s_detail_bar, h - 8 - S_CARD_BW * 2);
    screen_on();
}

static void build_page_a(lv_obj_t *a)
{
    /* 展开状态带：44px 时钟 + 电量 + 日期（充电时换成充电状态） */
    s_head = fill(a, 0, 0, W, 74, C_HEAD, 0);
    s_clock = label(s_head, &font_num_44, C_CLOCK);
    lv_obj_set_pos(s_clock, PAD, 12);
    s_bat_pct = label(s_head, &font_cn_16, C_HEAD_INK);
    lv_obj_align(s_bat_pct, LV_ALIGN_TOP_RIGHT, -PAD, 11);
    s_bat_shell = box(s_head, W - PAD - 40 - 26, 14, 22, 12);
    lv_obj_set_style_border_width(s_bat_shell, 2, 0);
    lv_obj_set_style_radius(s_bat_shell, 3, 0);
    lv_obj_set_style_border_color(s_bat_shell, lv_color_hex(C_HEAD_INK), 0);
    s_bat_fill = fill(s_bat_shell, 1, 1, 16, 6, C_HEAD_INK, 1);
    lv_obj_set_pos(s_bat_fill, 1, 1);
    s_bat_nub = fill(s_head, W - PAD - 40 - 4, 17, 2, 6, C_HEAD_INK, 1);
    s_bolt = label(s_head, &lv_font_montserrat_14, C_HEAD_OK);
    lv_label_set_text(s_bolt, LV_SYMBOL_CHARGE);
    lv_obj_set_pos(s_bolt, W - PAD - 40 - 26 - 14, 12);
    s_date = label(s_head, &font_cn_16, C_HEAD_INK_2);
    lv_obj_align(s_date, LV_ALIGN_TOP_RIGHT, -PAD, 40);
    hairline(a, 74);

    /* 录音行 */
    s_recrow = box(a, 0, 75, W, 37);
    s_rec_dot = fill(s_recrow, PAD, 13, 10, 10, C_REC, LV_RADIUS_CIRCLE);
    s_rec_label = label(s_recrow, &font_cn_16, C_INK);
    lv_obj_set_pos(s_rec_label, PAD + 16, 8);
    s_rec_time = label(s_recrow, &font_cn_16, C_INK_2);
    lv_obj_set_pos(s_rec_time, PAD + 16 + 70, 8);     /* 给"录音异常"四个字留位 */
    lv_obj_set_size(s_rec_time, 75, 20);
    lv_label_set_long_mode(s_rec_time, LV_LABEL_LONG_DOT);
    s_meter = box(s_recrow, W - PAD - (LEVEL_BARS * 6 - 3), 9, LEVEL_BARS * 6 - 3, 18);
    for (int i = 0; i < LEVEL_BARS; ++i) s_level[i] = fill(s_meter, i * 6, 7, 3, 3, C_ACT, 2);
    hairline(s_recrow, 36);

    s_stats = label(a, &font_cn_16, C_INK_2);
    lv_obj_set_pos(s_stats, PAD, 118);
    lv_obj_set_size(s_stats, W - 2 * PAD, 22);
    lv_label_set_long_mode(s_stats, LV_LABEL_LONG_DOT);

    /* 纸条区 3 个位置 */
    for (int i = 0; i < STACK_SLOTS; ++i) {
        s_slot[i] = strip(a, 122, 54, &s_slot_bar[i]);
        lv_obj_add_flag(s_slot[i], LV_OBJ_FLAG_CLICKABLE);
        lv_obj_set_user_data(s_slot[i], (void *)(intptr_t)i);
        lv_obj_add_event_cb(s_slot[i], slot_event, LV_EVENT_ALL, NULL);
        lv_obj_add_flag(s_slot[i], INTERACTIVE);
        s_slot_meta[i] = label(s_slot[i], &font_cn_16, C_INK_2);
        lv_obj_set_pos(s_slot_meta[i], 16, 6);
        s_slot_time[i] = label(s_slot[i], &font_cn_16, C_INK_3);
        lv_obj_align(s_slot_time[i], LV_ALIGN_TOP_RIGHT, -10, 6);
        s_slot_title[i] = label(s_slot[i], &font_cn_16, C_INK);
        lv_obj_set_pos(s_slot_title[i], 16, 28);
        lv_obj_set_size(s_slot_title[i], W - 16 - 16 - 10, 24);   /* 定高才会"…"，否则折行 */
        lv_label_set_long_mode(s_slot_title[i], LV_LABEL_LONG_DOT);
        s_slot_sub[i] = label(s_slot[i], &font_cn_16, C_INK_2);
        lv_obj_set_pos(s_slot_sub[i], 16, 50);
        lv_obj_set_size(s_slot_sub[i], W - 16 - 16 - 10, 22);
        lv_label_set_long_mode(s_slot_sub[i], LV_LABEL_LONG_DOT);
        s_slot_receipt[i] = -1;
        show(s_slot[i], false);
    }
    s_hint = label(a, &font_cn_16, C_INK_3);
    lv_obj_set_width(s_hint, W);
    lv_obj_set_style_text_align(s_hint, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_pos(s_hint, 0, 272);

    /* 紧凑状态带（有卡片时）：卡片要地方，时钟缩到 24px，录音点和走时照样在 */
    s_mini = fill(a, 0, 0, W, 46, C_HEAD, 0);
    s_mini_clock = label(s_mini, &font_cn_24, C_CLOCK);
    lv_obj_set_pos(s_mini_clock, PAD, 9);
    s_mini_dot = fill(s_mini, 84, 18, 10, 10, C_REC, LV_RADIUS_CIRCLE);
    s_mini_time = label(s_mini, &font_cn_16, C_HEAD_INK_2);
    lv_obj_set_pos(s_mini_time, 100, 13);
    s_mini_bat = label(s_mini, &font_cn_16, C_HEAD_INK);
    lv_obj_align(s_mini_bat, LV_ALIGN_TOP_RIGHT, -PAD, 13);
    hairline(s_mini, 45);
    show(s_mini, false);

    /* 待确认卡片 */
    s_card = strip(a, 56, 198, &s_card_bar);
    s_card_chip = label(s_card, &font_cn_16, C_EXT_INK);
    lv_obj_set_pos(s_card_chip, 14, 8);
    lv_obj_set_style_bg_opa(s_card_chip, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(s_card_chip, lv_color_hex(C_EXT_TINT), 0);
    lv_obj_set_style_radius(s_card_chip, S_CHIP_R, 0);
    lv_obj_set_style_pad_hor(s_card_chip, 6, 0);
    s_card_count = label(s_card, &font_cn_16, C_INK_3);
    lv_obj_align(s_card_count, LV_ALIGN_TOP_RIGHT, -10, 8);
    /* 标题自动换行——截成"…"的话，用户根本看不全要确认什么 */
    s_card_title_l = label(s_card, &font_cn_24, C_INK);
    lv_obj_set_pos(s_card_title_l, 16, 36);
    lv_obj_set_size(s_card_title_l, W - 16 - 16 - 12, 70);   /* 恰好两行 24px（行高 34 + 行距 2），矮了只剩一行 */
    lv_label_set_long_mode(s_card_title_l, LV_LABEL_LONG_DOT);   /* 两行放不下就"…"，全文在网页和飞书上看 */
    lv_obj_set_style_text_line_space(s_card_title_l, 2, 0);
    /* 原话证据：没有它，用户无法判断是 AI 听错了还是自己说错了 */
    s_card_evidence = label(s_card, &font_cn_16, C_INK_2);
    lv_obj_set_pos(s_card_evidence, 16, 110);
    lv_obj_set_size(s_card_evidence, W - 16 - 16 - 12, 44);
    lv_label_set_long_mode(s_card_evidence, LV_LABEL_LONG_DOT);
    /* 原话只靠引号和缩进区分，不加彩色竖线：纸条左边已经有一条卡槽色，再加一条就乱了 */
    lv_obj_set_style_pad_left(s_card_evidence, 4, 0);
    s_card_expiry = label(s_card, &font_cn_16, C_WARN);
    lv_obj_set_pos(s_card_expiry, 16, 166);
    lv_obj_set_width(s_card_expiry, W - 16 - 16 - 12);          /* 和标题、原话同宽：万一放不下也是"…"，不是硬截一半 */
    lv_label_set_long_mode(s_card_expiry, LV_LABEL_LONG_DOT);
    show(s_card, false);

    s_btn_cancel  = button(a, 8, 88, "取消", false, "cancel", NULL);
    s_btn_confirm = button(a, 104, W - 104 - 8, "确认", true, "confirm", &s_btn_confirm_label);
    show(s_btn_cancel, false);
    show(s_btn_confirm, false);
}

static void build_page_b(lv_obj_t *b)
{
    s_b_clock = label(b, &font_num_44, C_BIG_CLOCK);
    lv_obj_set_width(s_b_clock, W);
    lv_obj_set_style_text_align(s_b_clock, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_pos(s_b_clock, 0, 16);
    s_b_date = label(b, &font_cn_16, C_INK_2);
    lv_obj_set_width(s_b_date, W);
    lv_obj_set_style_text_align(s_b_date, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_pos(s_b_date, 0, 66);

    lv_obj_t *pill = fill(b, PAD, 96, W - PAD * 2, 30, C_PAPER, S_CARD_R);
    s_b_pill_dot = fill(pill, 10, 10, 10, 10, C_REC, LV_RADIUS_CIRCLE);
    s_b_pill_time = label(pill, &font_cn_16, C_INK);
    lv_obj_set_pos(s_b_pill_time, 26, 5);
    s_b_pill_bat = label(pill, &font_cn_16, C_INK);
    lv_obj_align(s_b_pill_bat, LV_ALIGN_TOP_RIGHT, -10, 5);
    fill(b, PAD, 138, W - PAD * 2, 1, C_RULE, 0);

    /* 可滚动的时刻表：今天办十几件事时，以前只看得见 6 行、也没法往下翻 */
    lv_obj_t *list = fill(b, 0, 144, W, 300 - 144, C_CONSOLE, 0);
    lv_obj_add_flag(list, LV_OBJ_FLAG_EVENT_BUBBLE);
    lv_obj_add_flag(b, LV_OBJ_FLAG_EVENT_BUBBLE);
    lv_obj_add_flag(list, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_scroll_dir(list, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(list, LV_SCROLLBAR_MODE_AUTO);
    for (int i = 0; i < UI_MAX_TIMELINE; ++i) {
        s_b_row[i] = fill(list, 8, 2 + i * 27, W - 16, 26, C_EXT_TINT, S_CHIP_R);
        lv_obj_set_user_data(s_b_row[i], (void *)(intptr_t)i);
        lv_obj_set_style_bg_opa(s_b_row[i], LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_color(s_b_row[i], lv_color_hex(C_EXT), 0);
        /* 每一行都能点开详情；按下/拖动事件继续往上传给翻页（行→列表→第二屏→翻页容器），
         * 否则从行上开始的左右划会被行截走，翻不了页 */
        lv_obj_add_flag(s_b_row[i], LV_OBJ_FLAG_CLICKABLE);
        lv_obj_add_flag(s_b_row[i], LV_OBJ_FLAG_EVENT_BUBBLE);
        lv_obj_add_event_cb(s_b_row[i], row_clicked, LV_EVENT_CLICKED, NULL);
        lv_obj_add_flag(s_b_row[i], INTERACTIVE);
        s_b_at[i] = label(s_b_row[i], &font_cn_16, C_INK_2);
        lv_obj_set_pos(s_b_at[i], 4, 3);
        s_b_kind[i] = label(s_b_row[i], &font_cn_16, C_OWN);
        lv_obj_set_pos(s_b_kind[i], 54, 3);
        s_b_title[i] = label(s_b_row[i], &font_cn_16, C_INK);
        lv_obj_set_pos(s_b_title[i], 94, 3);
        lv_obj_set_size(s_b_title[i], W - 16 - 94 - 4, 22);
        lv_label_set_long_mode(s_b_title[i], LV_LABEL_LONG_DOT);
        show(s_b_row[i], false);
    }
    s_b_empty = label(b, &font_cn_16, C_INK_3);
    lv_label_set_text(s_b_empty, "今天还没有要办的事");
    lv_obj_set_width(s_b_empty, W);
    lv_obj_set_style_text_align(s_b_empty, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_pos(s_b_empty, 0, 170);
}

/* 标志：圆环里两道竖线（录音/声波意象），和网页控制台同一个 */
/* 到点提醒点一下屏幕就收下：不用去找是哪个键。其他全屏提示（关机、升级）点了不理 */
static void msg_clicked(lv_event_t *e)
{
    LV_UNUSED(e);
    if (!s_msg_is_reminder || !s_action_handler) return;
    if (!s_action_handler("", "ack_reminder")) { toast("操作繁忙，请再试一次", false); return; }
    s_msg_is_reminder = false;
    show(s_msg, false);                     /* 先收起，网上的确认在后台报 */
}

static void build_message(lv_obj_t *scr)
{
    s_msg = fill(scr, 0, 0, W, H, C_PAPER, 0);
    lv_obj_add_flag(s_msg, LV_OBJ_FLAG_CLICKABLE);   /* 挡住下面的触摸 */
    lv_obj_add_event_cb(s_msg, msg_clicked, LV_EVENT_CLICKED, NULL);
    lv_obj_add_flag(s_msg, INTERACTIVE);
    s_msg_mark = box(s_msg, (W - 36) / 2, 76, 36, 36);
    lv_obj_set_style_radius(s_msg_mark, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_width(s_msg_mark, 3, 0);
    lv_obj_set_style_border_color(s_msg_mark, lv_color_hex(C_INK), 0);
    s_msg_bars[0] = fill(s_msg_mark, 11, 9, 3, 12, C_INK, 2);
    s_msg_bars[1] = fill(s_msg_mark, 18, 7, 3, 16, C_INK, 2);
    s_msg_title = label(s_msg, &font_cn_24, C_INK);
    lv_obj_set_width(s_msg_title, W - PAD * 2);
    lv_obj_set_style_text_align(s_msg_title, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(s_msg_title, LV_LABEL_LONG_WRAP);
    lv_obj_set_pos(s_msg_title, PAD, 126);
    s_msg_bar = fill(s_msg, 40, 176, W - 80, 6, C_RULE, 3);
    s_msg_bar_fill = fill(s_msg_bar, 0, 0, 0, 6, C_ACT, 3);
    s_msg_sub = label(s_msg, &font_cn_16, C_INK_2);
    lv_obj_set_width(s_msg_sub, W - PAD * 2);
    lv_obj_set_style_text_align(s_msg_sub, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(s_msg_sub, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_line_space(s_msg_sub, 4, 0);
    lv_obj_set_pos(s_msg_sub, PAD, 170);
    s_msg_note = label(s_msg, &font_cn_16, C_EXT);
    lv_obj_set_width(s_msg_note, W - PAD * 2);
    lv_obj_set_style_text_align(s_msg_note, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(s_msg_note, LV_LABEL_LONG_WRAP);
    lv_obj_set_pos(s_msg_note, PAD, 244);
    s_msg_ver = label(s_msg, &font_cn_16, C_INK_3);
    lv_obj_set_width(s_msg_ver, W);
    lv_obj_set_style_text_align(s_msg_ver, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_pos(s_msg_ver, 0, 290);
    lv_label_set_text(s_msg_ver, esp_app_get_description()->version);
    show(s_msg, false);
}

static void build(void)
{
    lv_obj_t *scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, lv_color_hex(C_CONSOLE), 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_remove_flag(scr, LV_OBJ_FLAG_SCROLLABLE);

    /* 两屏并排放在一个 480 宽的容器里，翻屏就是把它左右挪 240 */
    s_pager = box(scr, 0, 0, W * 2, H);
    lv_obj_add_flag(s_pager, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(s_pager, pager_event, LV_EVENT_ALL, NULL);
    lv_obj_t *a = box(s_pager, 0, 0, W, H);
    lv_obj_t *b = box(s_pager, W, 0, W, H);
    build_page_a(a);
    build_page_b(b);

    build_detail(scr);

    /* 页码：两个点，当前页拉长 */
    s_dot[0] = fill(scr, 106, 312, 16, 6, C_INK, 3);
    s_dot[1] = fill(scr, 106 + 16 + 6, 312, 6, 6, C_RULE_2, 3);

    s_work = fill(scr, PAD, 266, W - PAD * 2, 34, C_PAPER, S_BTN_R);
    lv_obj_set_style_border_width(s_work, 2, 0);
    lv_obj_set_style_border_color(s_work, lv_color_hex(C_ACT), 0);
    s_work_label = label(s_work, &font_cn_16, C_ACT);
    lv_obj_align(s_work_label, LV_ALIGN_LEFT_MID, 12, 0);
    show(s_work, s_work_on);
    if (s_work_on) s_work_timer = lv_timer_create(work_dots, 500, NULL);   /* 换主题重建时接着动 */

    s_toast = fill(scr, PAD, 214, W - PAD * 2, 38, C_PAPER, S_CARD_R);
    lv_obj_set_style_border_width(s_toast, 2, 0);
    s_toast_label = label(s_toast, &font_cn_16, C_ACT);
    lv_obj_center(s_toast_label);
    show(s_toast, false);

    build_brightness(scr);
    build_message(scr);

    go_page(0, false);
    s_last.battery_pct = -1;
    s_status_timer = lv_timer_create(status_tick, 1000, NULL);
    s_level_timer = lv_timer_create(level_tick, 100, NULL);
    status_tick(NULL);
    rebuild_stack();
}

esp_err_t ui_init(ui_status_provider_t status, ui_action_handler_t action)
{
    s_status_provider = status;
    s_action_handler = action;
    if (!display_panel() || !display_io()) return ESP_ERR_INVALID_STATE;

    lvgl_port_cfg_t port = ESP_LVGL_PORT_INIT_CONFIG();
    /* 界面跑在联网所在的 CPU1、低优先级：CPU0 留给采集和 Opus 编码 */
    port.task_priority = 3;
    port.task_affinity = 1;
    port.task_stack = 8192;
    ESP_RETURN_ON_ERROR(lvgl_port_init(&port), TAG, "lvgl port");

    const lvgl_port_display_cfg_t disp_cfg = {
        .io_handle = display_io(),
        .panel_handle = display_panel(),
        /* 整屏双缓冲，但不开 full_refresh。
         * 缓冲给整屏：滑动时整屏都脏，一次渲染一次发送，不会再出现一条条横向错位。
         * full_refresh 开着的话，秒数跳一下也要重画整屏 240x320 再发 153KB——
         * 实测 LVGL 任务长期吃掉一个核的 61%，整机发卡。关掉后只重画脏的那一小块。*/
        .buffer_size = W * H,
        .double_buffer = true,
        .hres = W,
        .vres = H,
        .monochrome = false,
        .color_format = LV_COLOR_FORMAT_RGB565,
        .rotation = { .swap_xy = false, .mirror_x = false, .mirror_y = false },
        /* 画布放 PSRAM：内部 RAM 要留给 TLS 和驱动——实测画布放内部 RAM 时空闲内存一度只剩 17KB。
         * buff_dma + buff_spiram + 64 字节对齐（CONFIG_LV_DRAW_BUF_ALIGN）：S3 的 SPI DMA 能直接读 PSRAM，
         * 不用每发一块都在内部 RAM 里借地方中转（借不到就会丢一块画面）。*/
        .flags = { .buff_dma = true, .buff_spiram = true, .swap_bytes = true },
    };
    lv_display_t *disp = lvgl_port_add_disp(&disp_cfg);
    if (!disp) return ESP_FAIL;
    s_disp = disp;
    lv_display_add_event_cb(disp, frame_done, LV_EVENT_REFR_READY, NULL);
    lv_display_add_event_cb(disp, render_start, LV_EVENT_RENDER_START, NULL);
    lv_display_add_event_cb(disp, render_done, LV_EVENT_RENDER_READY, NULL);

    if (!lvgl_port_lock(0)) return ESP_FAIL;
    lv_indev_t *indev = lv_indev_create();
    lv_indev_set_type(indev, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(indev, touch_read);
    lv_indev_set_display(indev, disp);
    build();
    s_built = true;
    lvgl_port_unlock();
    ESP_LOGI(TAG, "界面就绪（主题 %s）", s_theme.id);
    return ESP_OK;
}

/* ── 对外接口（都在别的任务里调，先拿锁）──────────────────────── */

bool ui_screen_off(void) { return s_screen_off; }

/* 调试用：把第一条回执按"点了一下"那样打开，串口 demo detail 调它。
 * 触摸没法从串口模拟，但这条路径和真手指点下去走的是同一个 open_detail。*/
void ui_demo_detail(void)
{
    if (!lvgl_port_lock(500)) return;
    if (s_receipt_count > 0) {
        const ui_receipt_t *r = &s_receipts[0];
        open_detail(r->failed ? D_FAILED : D_DONE, r->failed ? "执行失败" : done_word(r->tool),
                    r->tool, r->at, r->title, r->evidence);
    } else {
        open_detail(D_DONE, "已执行", "feishu.task.create", "13:52",
                    "示例：这是一个很长的任务标题用来检查在详情页里能不能完整换行显示出来",
                    "明天上午十点给张总打个电话确认一下合同的事");
    }
    lvgl_port_unlock();
}

bool ui_detail_open(void)
{
    return s_detail && !lv_obj_has_flag(s_detail, LV_OBJ_FLAG_HIDDEN);
}

/* 到点提醒：整屏一张卡，等按确认。和"要不要办"的卡片不同——这张不是让你拍板，
 * 是怕你错过；所以默认一直留着，直到人真的按了确认。*/
void ui_show_reminder(const char *title, const char *body, const char *at)
{
    char sub[300];
    snprintf(sub, sizeof(sub), "%s%s%s", at && at[0] ? at : "", body && body[0] ? "\n" : "", body ? body : "");
    if (!lvgl_port_lock(1000)) return;
    s_msg_keeps_awake = true;                 /* 提醒要亮着，别到点了屏幕还是黑的 */
    message_common(title, sub, -1, "点屏幕或按确认键，知道了", false);
    s_msg_is_reminder = true;
    lvgl_port_unlock();
}

/* 刚办完一件事：把它的详情直接弹出来（和在首页点那张纸条看到的一样） */
void ui_show_done(const ui_receipt_t *r)
{
    if (!r || !lvgl_port_lock(1000)) return;
    go_page(0, false);
    open_detail(r->failed ? D_FAILED : D_DONE, r->failed ? "执行失败" : done_word(r->tool), r->tool, r->at, r->title, r->evidence);
    screen_on();
    lvgl_port_unlock();
}

void ui_close_detail(void)
{
    if (!lvgl_port_lock(200)) return;
    if (s_detail) { show(s_detail, false); show(s_detail_back, false); }
    lvgl_port_unlock();
}


void ui_show_card(const char *id, const char *tool, const char *title, const char *detail,
                  const char *evidence, int32_t expires_in_sec, uint32_t total)
{
    LV_UNUSED(detail);
    if (!lvgl_port_lock(1000)) return;
    if (total == 0 || !id) {
        if (s_card_id[0] && !s_busy) {
            s_card_id[0] = '\0';
            s_expires_in = -1;
            apply_card_mode();
        }
        lvgl_port_unlock();
        return;
    }
    char count[16];
    snprintf(count, sizeof(count), total > 1 ? "1 / %lu" : "", (unsigned long)total);
    set_text(s_card_count, count);
    bool same = strcmp(s_card_id, id) == 0;
    if (same && !s_busy && strcmp(s_card_title, title ? title : "") == 0 &&
        strcmp(s_card_tool, tool ? tool : "") == 0) {
        s_expires_in = expires_in_sec;
        lvgl_port_unlock();
        return;
    }
    if (!s_busy) {
        strlcpy(s_card_id, id, sizeof(s_card_id));
        strlcpy(s_card_tool, tool ? tool : "", sizeof(s_card_tool));
        ui_copy_utf8(s_card_title, sizeof(s_card_title), title);
        const tool_look_t *lk = look_of(tool);
        char chip[40];
        snprintf(chip, sizeof(chip), "%s・%s", lk->tier, lk->label);
        lv_label_set_text(s_card_chip, chip);
        bool ext = lk->kind == K_EXT;
        lv_obj_set_style_bg_color(s_card_chip, lv_color_hex(ext ? C_EXT_TINT : C_CONSOLE), 0);
        lv_obj_set_style_text_color(s_card_chip, lv_color_hex(look_ink(lk)), 0);
        lv_obj_set_style_bg_color(s_card_bar, lv_color_hex(look_color(lk)), 0);
        if (S_EDGE) lv_obj_set_style_outline_color(s_card, lv_color_hex(ext ? C_EXT : C_RULE), 0);
        else lv_obj_set_style_border_color(s_card, lv_color_hex(ext ? C_EXT : C_RULE), 0);
        lv_label_set_text(s_card_title_l, s_card_title);
        if (evidence && evidence[0]) {
            lv_label_set_text_fmt(s_card_evidence, "“%s”", evidence);
            show(s_card_evidence, true);
        } else {
            show(s_card_evidence, false);
        }
        s_expires_in = expires_in_sec;
        if (s_expires_in >= 0) {
            char expiry[48];
            fmt_expiry(expiry, sizeof(expiry), s_expires_in);
            lv_label_set_text(s_card_expiry, expiry);
            show(s_card_expiry, true);
        } else {
            show(s_card_expiry, false);
        }
        apply_card_mode();
        if (!same) {
            if (s_page != 0) go_page(0, false);
            screen_on();
        }
    }
    lvgl_port_unlock();
}

void ui_set_feed(const ui_receipt_t *receipts, int receipt_count,
                 const ui_timeline_row_t *rows, int row_count, const ui_today_t *today)
{
    if (!lvgl_port_lock(1000)) return;
    reset_slot_gestures();
    if (!receipts || receipt_count < 0) receipt_count = 0;
    if (!rows || row_count < 0) row_count = 0;
    s_receipt_count = receipt_count > UI_MAX_RECEIPTS ? UI_MAX_RECEIPTS : receipt_count;
    if (s_receipt_count > 0) memcpy(s_receipts, receipts, sizeof(ui_receipt_t) * (size_t)s_receipt_count);
    s_row_count = row_count > UI_MAX_TIMELINE ? UI_MAX_TIMELINE : row_count;
    if (s_row_count > 0) memcpy(s_rows, rows, sizeof(ui_timeline_row_t) * (size_t)s_row_count);
    /* 这次没带统计就留着上次的，不退回"本次开机" */
    if (today && today->valid) {
        ui_status_t current = s_last;
        if (s_status_provider) s_status_provider(&current);
        s_today = *today;
        s_today_recorded_baseline = current.recording_seconds;
    }
    if (!s_card_id[0]) rebuild_stack();
    rebuild_timeline();
    lvgl_port_unlock();
}

void ui_action_done(bool ok, const char *message)
{
    if (!lvgl_port_lock(1000)) return;
    set_busy(false);
    if (ok) {
        s_card_id[0] = '\0';   /* 让下一次拉取到的卡片（可能是下一张）能正常显示 */
        s_expires_in = -1;
        apply_card_mode();
    }
    toast(message, ok);
    lvgl_port_unlock();
}

/* 屏上短暂提示一句（比如「已分段」），过一会儿自己消失 */
static void work_dots(lv_timer_t *timer)
{
    LV_UNUSED(timer);
    static const char *frames[] = { "正在处理刚才说的话", "正在处理刚才说的话・", "正在处理刚才说的话・・", "正在处理刚才说的话・・・" };
    lv_label_set_text(s_work_label, frames[s_work_tick++ % 4]);
}

void ui_set_working(bool on)
{
    if (!lvgl_port_lock(1000)) return;
    s_work_on = on;
    if (s_work_timer) { lv_timer_delete(s_work_timer); s_work_timer = NULL; }
    if (s_work) {
        show(s_work, on);
        if (on) {
            s_work_tick = 0;
            work_dots(NULL);
            lv_obj_move_foreground(s_work);
            s_work_timer = lv_timer_create(work_dots, 500, NULL);
        }
    }
    lvgl_port_unlock();
}

void ui_toast(const char *text)
{
    if (!lvgl_port_lock(1000)) return;
    toast(text, true);
    lvgl_port_unlock();
}

void ui_begin_action(void)
{
    if (!lvgl_port_lock(1000)) return;
    if (s_card_id[0]) set_busy(true);
    lvgl_port_unlock();
}

static void message_look(bool night)
{
    uint32_t bg = night ? C_NIGHT : C_PAPER, ink = night ? C_NIGHT_INK : C_INK;
    lv_obj_set_style_bg_color(s_msg, lv_color_hex(bg), 0);
    lv_obj_set_style_border_color(s_msg_mark, lv_color_hex(ink), 0);
    lv_obj_set_style_bg_color(s_msg_bars[0], lv_color_hex(ink), 0);
    lv_obj_set_style_bg_color(s_msg_bars[1], lv_color_hex(ink), 0);
    lv_obj_set_style_text_color(s_msg_title, lv_color_hex(ink), 0);
    lv_obj_set_style_text_color(s_msg_sub, lv_color_hex(night ? C_RULE_2 : C_INK_2), 0);
}

static void message_common(const char *title, const char *sub, int pct, const char *note, bool night)
{
    s_msg_is_reminder = false;              /* 只有 ui_show_reminder 会在之后把它置回 true */
    if (!title) {
        /* 关掉提示（比如「在听」松手）时从现在重新计熄屏时间：按住那段没碰屏幕，
         * 不重计的话一松手就已经「超时」立刻黑了（用户实测） */
        if (!lv_obj_has_flag(s_msg, LV_OBJ_FLAG_HIDDEN) && !s_screen_off) lv_display_trigger_activity(NULL);
        show(s_msg, false);
        return;
    }
    message_look(night);
    lv_label_set_text(s_msg_title, title);
    lv_label_set_text(s_msg_sub, sub ? sub : "");
    bool bar = pct >= 0;
    show(s_msg_bar, bar);
    if (bar) lv_obj_set_width(s_msg_bar_fill, (W - 80) * (pct > 100 ? 100 : pct) / 100);
    /* Budget the full overlay; a long reminder must never push its acknowledge
     * instruction below the physical screen. Ellipsis makes the limit explicit. */
    lv_obj_set_y(s_msg_mark, bar ? 76 : 24);
    lv_obj_set_y(s_msg_title, bar ? 126 : 74);
    lv_obj_set_height(s_msg_title, bar ? 36 : 70);
    lv_label_set_long_mode(s_msg_title, LV_LABEL_LONG_DOT);
    lv_obj_set_y(s_msg_sub, bar ? 194 : 154);
    lv_obj_set_height(s_msg_sub, bar ? 76 : 112);
    lv_label_set_long_mode(s_msg_sub, LV_LABEL_LONG_DOT);
    lv_label_set_text(s_msg_note, note ? note : "");
    show(s_msg_note, note != NULL);
    if (note) {
        lv_obj_set_y(s_msg_note, 278);
        lv_obj_set_height(s_msg_note, 40);
        lv_label_set_long_mode(s_msg_note, LV_LABEL_LONG_DOT);
    }
    show(s_msg_ver, bar);                    /* 版本号只在开机/升级时有用 */
    show(s_msg, true);
    lv_obj_move_foreground(s_msg);
    screen_on();
}

void ui_show_message(const char *title, const char *sub)
{
    if (!lvgl_port_lock(1000)) return;
    s_msg_keeps_awake = true;
    message_common(title, sub, -1, NULL, false);
    lvgl_port_unlock();
}

/** 和 ui_show_message 一样，但这条提示不阻止熄屏（暂停录音、在听这种长期/短期都算） */
void ui_show_note(const char *title, const char *sub)
{
    if (!lvgl_port_lock(1000)) return;
    message_common(title, sub, -1, NULL, false);
    s_msg_keeps_awake = false;
    lvgl_port_unlock();
}

void ui_show_progress(const char *title, const char *sub, int pct)
{
    if (!lvgl_port_lock(1000)) return;
    s_msg_keeps_awake = true;
    message_common(title, sub, pct < 0 ? 0 : pct, NULL, false);
    lvgl_port_unlock();
}

/* 升级固件期间停掉界面刷新。写 flash 时屏幕那次 SPI 传输会失败（2026-10-04 日志：
 * spi transmit color failed），LVGL 就一直等"这一帧发完了"、空转吃满一个核，屏幕停在 10% 不动。
 * 停之前留 400ms 让当前这一屏（升级提示）先画完、发出去。*/
void ui_freeze(bool freeze)
{
    if (freeze) { vTaskDelay(pdMS_TO_TICKS(400)); lvgl_port_stop(); }
    else lvgl_port_resume();
}

void ui_show_sleep(const char *title, const char *sub, const char *note)
{
    if (!lvgl_port_lock(1000)) return;
    message_common(title, sub, -1, note, true);
    lvgl_port_unlock();
}

bool ui_screenshot(void (*write)(const void *row, size_t len))
{
    if (!lvgl_port_lock(2000)) return false;
    lv_draw_buf_t *buf = lv_snapshot_take(lv_screen_active(), LV_COLOR_FORMAT_RGB565);
    lvgl_port_unlock();
    if (!buf) return false;
    for (uint32_t y = 0; y < buf->header.h; ++y) write(buf->data + y * buf->header.stride, buf->header.w * 2);
    lv_draw_buf_destroy(buf);
    return true;
}

/* 真关机前调。拿住 LVGL 的锁不再放：屏已经进睡眠了，别让它再往屏上刷一帧
 * （刷了也看不见，还会把刚熄掉的屏唤醒）。拿不到锁也照样关屏——关机不能被界面卡住。*/
void ui_prepare_sleep(void)
{
    lvgl_port_lock(500);
    display_power_down();
}

_Static_assert(sizeof(ui_palette_t) == UI_THEME_COLORS * sizeof(uint32_t), "调色板里只能放 uint32 颜色");

bool ui_theme_parse(const char *id, const char *csv, const int *shape, int shape_count, ui_theme_t *out)
{
    if (!id || !id[0] || !csv || !shape || shape_count != UI_THEME_SHAPES || !out) return false;
    ui_theme_t t = {0};
    strlcpy(t.id, id, sizeof(t.id));
    uint32_t *dst = (uint32_t *)&t.c;
    const char *p = csv;
    for (int i = 0; i < UI_THEME_COLORS; ++i) {
        char *end = NULL;
        unsigned long v = strtoul(p, &end, 16);
        if (end - p != 6) return false;                 /* 每个颜色正好 6 位十六进制 */
        dst[i] = (uint32_t)v;
        p = end;
        if (i < UI_THEME_COLORS - 1) { if (*p != ',') return false; ++p; }
    }
    if (*p) return false;                               /* 多一个少一个都不认：顺序一错全屏颜色都会错位 */
    for (int i = 0; i < UI_THEME_SHAPES; ++i) if (shape[i] < 0 || shape[i] > 40) return false;
    t.s = (ui_shape_t){ .card_r = (uint8_t)shape[0], .card_bw = (uint8_t)shape[1], .edge = (uint8_t)shape[2],
                        .btn_r = (uint8_t)shape[3], .chip_r = (uint8_t)shape[4] };
    *out = t;
    return true;
}

const char *ui_theme_id(void) { return s_theme.id; }

/* 换主题：整套界面按新配色原地重建。
 * 界面上的数据（回执、时刻表、今日统计、当前在哪一屏）本来就单独存着，控件只是显示层，
 * 重建完照样画回去，录音不受影响。待确认卡片和到点提醒的内容只存在控件里，这里清掉记号，
 * 由调用方让它们从服务器再推一次（几秒内）。*/
void ui_apply_theme(const ui_theme_t *t)
{
    if (!s_built) { s_theme = *t; return; }
    if (!lvgl_port_lock(1000)) return;
    s_theme = *t;
    if (s_status_timer) { lv_timer_delete(s_status_timer); s_status_timer = NULL; }
    if (s_level_timer) { lv_timer_delete(s_level_timer); s_level_timer = NULL; }
    if (s_toast_timer) { lv_timer_delete(s_toast_timer); s_toast_timer = NULL; }
    if (s_work_timer) { lv_timer_delete(s_work_timer); s_work_timer = NULL; }
    if (s_bright_timer) { lv_timer_delete(s_bright_timer); s_bright_timer = NULL; }
    int page = s_page;
    lv_obj_clean(lv_screen_active());
    s_card_id[0] = '\0';
    s_busy = false;
    s_expires_in = -1;
    s_msg_is_reminder = false;
    build();
    go_page(page, false);
    rebuild_timeline();
    lvgl_port_unlock();
    ESP_LOGI(TAG, "主题已换成 %s", s_theme.id);
}

void ui_goto_page(int page)
{
    if (!lvgl_port_lock(1000)) return;
    go_page(page ? 1 : 0, false);
    lvgl_port_unlock();
}

/* 带动画翻页：手指滑动走的是 pager_event，这个只给自测用——
 * 不带动画的 ui_goto_page 是瞬间跳过去的，拿它量帧率只会量到一帧。*/
void ui_goto_page_animated(int page)
{
    if (!lvgl_port_lock(1000)) return;
    go_page(page ? 1 : 0, true);
    lvgl_port_unlock();
}

void ui_set_brightness(uint8_t percent, ui_brightness_saver_t saver)
{
    if (!lvgl_port_lock(1000)) return;
    s_brightness = percent < BRIGHT_MIN ? BRIGHT_MIN : percent > 100 ? 100 : percent;
    s_brightness_saver = saver;
    if (!s_screen_off) display_backlight(s_brightness);
    lvgl_port_unlock();
}

/* ── 耗电测量用 ── */
void ui_set_wake_inhibit(bool on) { s_wake_inhibit = on; }

void ui_sleep_now(void)
{
    if (!lvgl_port_lock(1000)) return;
    if (!s_screen_off) screen_off_now();
    lvgl_port_unlock();
}

/* 面板进/出睡眠（SLPIN/SLPOUT）。平时熄屏只关背光，面板本身还在工作 */
void ui_panel_sleep(bool on)
{
    if (!lvgl_port_lock(1000)) return;
    esp_lcd_panel_disp_sleep(display_panel(), on);
    lvgl_port_unlock();
}

void ui_set_tap_wake(bool on) { s_tap_wake = on; }
void ui_set_double_tap_off(bool on) { s_dtap_off = on; }

void ui_set_screen_timeout(uint16_t seconds)
{
    s_screen_timeout = seconds;
}

bool ui_wake(void)
{
    if (!lvgl_port_lock(1000)) return false;
    bool was_off = s_screen_off;
    screen_on();
    lv_display_trigger_activity(NULL);
    lvgl_port_unlock();
    return was_off;
}

void ui_open_brightness(void)
{
    if (!lvgl_port_lock(1000)) return;
    screen_on();
    bright_open();
    lvgl_port_unlock();
}

#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

/* 设备屏幕界面（LVGL，竖屏 240x320）。
 *
 * 两屏，左右划切换（两个小圆点指示在哪一屏）：
 *   A 回执流（默认）：顶上状态带（时钟、录音、电平、电量），下面一叠纸条——
 *     待确认的卡片带确认/取消；执行完的回执左右划掉；没事时显示今天的概况。
 *   B 时刻表：大时钟 + 今天按时间倒排的一行行事项，待确认的那行黄色置顶，点它回 A 去签。
 * 划在回执纸条上＝划掉这条；划在其他地方＝翻屏。
 *
 * 设计依据 docs/20 §2.3–2.5、§10：录音状态始终可见且不可伪造；确认/取消在处理中锁定。
 * 配色与网页控制台同一套（cloud/web/DESIGN.md）：灰底白纸条，卡槽颜色只表示风险等级。*/

typedef struct {
    bool recording;            /* 最近 2 秒麦克风确实有数据进来——不是"应该在录" */
    uint32_t recording_seconds; /* 本次开机有效写入音频的累计秒数，暂停/分段不归零 */
    bool network;              /* 4G 已联网 */
    bool time_valid;           /* 已对时，可以显示钟点 */
    int battery_pct;           /* <0 表示读不到 */
    bool charging;             /* 推断值：电压跳变 + 电量计速率 */
    bool charge_full;
    bool paused;               /* 用户按录音键暂停了；界面上要和"录音异常"分清楚 */
    uint32_t pending_uploads;
    /* 最近一小段麦克风音量 0~100，用来画电平条。它和 recording 一样来自真实
     * 采样数据：没有声音进来时条自然会平，用户一眼能看出麦克风是不是死了。*/
    uint8_t input_level;
} ui_status_t;

/* 执行回执：服务端执行完的动作，推到 A 屏，用户左右划掉 */
typedef struct {
    char id[40];
    char tool[40];
    char title[128];           /* 服务端发 40 个字：列表上显示两行，点开的详情页能放下全部 */
    char evidence[200];        /* 当时的原话（60 字以内），点开才看得到 */
    char at[8];                /* "14:30" 北京时间 */
    bool failed;
} ui_receipt_t;

/* B 屏时刻表的一行 */
typedef struct {
    char tool[40];
    char title[128];
    char evidence[200];
    char at[8];
    char status[12];           /* pending / executed / failed / confirmed / executing */
} ui_timeline_row_t;

typedef struct {
    bool valid;
    uint32_t recorded_sec;
    uint32_t sentences;
    uint32_t done;
} ui_today_t;

#define UI_MAX_RECEIPTS 4
#define UI_MAX_TIMELINE 10

/* 在 LVGL 任务里每秒调一次，必须很快返回（只读内存里的状态，不做 I/O）。*/
typedef void (*ui_status_provider_t)(ui_status_t *out);
/* 用户点了卡片按钮 / 划掉了回执。在 LVGL 任务里调用，必须很快返回——
 * 把真正的网络请求交给别的任务。verb 为 "confirm"、"cancel" 或 "dismiss"。
 * 返回 true 表示后台已接收；false 时界面保留原状态，用户可重试。
 * confirm/cancel 做完要调 ui_action_done()；dismiss 的重试由后台负责。*/
typedef bool (*ui_action_handler_t)(const char *id, const char *verb);

esp_err_t ui_init(ui_status_provider_t status, ui_action_handler_t action);

/* 更新队首卡片（线程安全）。total==0 表示没有待确认卡片。
 * 同一张卡(id 相同)重复调用不会打断正在进行的操作。
 * evidence 是原话片段，可为 NULL；用户要靠它判断 AI 有没有听错。
 * expires_in_sec <0 表示不过期（A/B 类），>=0 则显示倒计时（C 类 15 分钟作废）。*/
void ui_show_card(const char *id, const char *tool, const char *title, const char *detail,
                  const char *evidence, int32_t expires_in_sec, uint32_t total);

/* 回执、时刻表、今日概况（线程安全）。 */
void ui_set_feed(const ui_receipt_t *receipts, int receipt_count,
                 const ui_timeline_row_t *rows, int row_count, const ui_today_t *today);

/* 结束"处理中"状态并短暂提示结果（线程安全）。*/
void ui_action_done(bool ok, const char *message);

/* 实体键触发确认/取消时先调它，让按钮同样进入"处理中"锁定（线程安全）。*/
void ui_begin_action(void);

/* 屏上短暂提示一句，过一会儿自己消失（线程安全）*/
void ui_toast(const char *text);
/* 按住说完松手后的「正在处理刚才说的话」小条：on 挂上（点点点在动），off 收起。不影响熄屏 */
void ui_set_working(bool on);

/* 全屏提示（关机、升级等），白底 + 标志。sub 可为 NULL，可含换行。传 NULL 标题则回到正常界面。*/
void ui_show_message(const char *title, const char *sub);
/** 到点提醒：整屏一张卡，按确认键收下 */
void ui_show_reminder(const char *title, const char *body, const char *at);

/** 不阻止熄屏的全屏提示（暂停录音、在听） */
void ui_show_note(const char *title, const char *sub);

/** 详情页开着没有：按键要先用来关掉它，而不是去签放卡片 */
bool ui_detail_open(void);
/** 调试：用第一条回执打开详情页（串口 demo detail） */
void ui_demo_detail(void);
/** 关掉详情页（返回键、或者屏幕上点一下） */
void ui_close_detail(void);
/* 刚办完一件事：亮屏并弹出它的详情卡片 */
void ui_show_done(const ui_receipt_t *r);
/* 同上，带进度条（开机自检、升级）。pct 0~100。*/
void ui_show_progress(const char *title, const char *sub, int pct);
/* 升级固件期间停掉/恢复界面刷新（写 flash 时屏幕传输会失败，LVGL 会空转卡死） */
void ui_freeze(bool freeze);
/* 软关机画面：深色底（之后会熄屏），note 用琥珀色写耗电提醒，可为 NULL。*/
void ui_show_sleep(const char *title, const char *sub, const char *note);

/* 把当前屏幕真实渲染出来的画面（RGB565，逐行）交给 write 输出。调试用：
 * 串口 screenshot 命令靠它回传画面，界面好不好看以实拍为准，不靠想象。*/
bool ui_screenshot(void (*write)(const void *row, size_t len));
/* 调试：切到第 page 屏（0＝A，1＝B） */
/* ── 主题：后台选、服务器推，设备只存当前这一套（约 130 字节，换了就覆盖）──
 * 推过来的是"配方"——30 种颜色 + 5 个形状数——不是图片，所以占不了空间，也不用联网才能显示。
 * 颜色顺序就是下面结构体字段的顺序，服务端 cloud/src/themes.ts 的 THEME_ROLES 必须一致。*/
typedef struct {
    uint32_t console, paper, rule, rule2, ink, ink2, ink3, act, act_press, on_act, rec,
             ext, ext_tint, ext_ink, own, own_ink, recd, phy, warn, bad, night, night_ink,
             head, head_ink, head_ink2, head_ok, head_bad, clock, big_clock, edge;
} ui_palette_t;
#define UI_THEME_COLORS 30
typedef struct { uint8_t card_r, card_bw, edge, btn_r, chip_r; } ui_shape_t;
#define UI_THEME_SHAPES 5
typedef struct { char id[16]; ui_palette_t c; ui_shape_t s; } ui_theme_t;

/* 把服务器发来的颜色串（"E9EDEC,FFFFFF,…" 正好 30 个）和形状数组解析成主题；格式不对返回 false */
bool ui_theme_parse(const char *id, const char *colors_csv, const int *shape, int shape_count, ui_theme_t *out);
/* 开机前调：只记下，建界面时就用它；之后调：整套界面按新主题原地重建（不重启、不断录音） */
void ui_apply_theme(const ui_theme_t *theme);
const char *ui_theme_id(void);

void ui_goto_page(int page);
void ui_prepare_sleep(void);      /* 真关机前：停止刷屏，屏熄灭并睡眠 */
/* 耗电测量用：禁止点亮屏幕 / 立刻熄屏 / 面板睡眠 */
void ui_set_wake_inhibit(bool on);
/* 亮屏(true)/熄屏(false) 时回调，在界面任务里调，别在里面拿界面锁 */
void ui_set_screen_listener(void (*cb)(bool on));
void ui_sleep_now(void);
void ui_panel_sleep(bool on);

/* ── 亮度与熄屏 ──
 * 亮度面板：从屏幕顶部往下拉，或点一下时钟。竖条上下拖，几秒不碰自动收起。
 * 熄屏：多久不碰就关背光（录音照常）；双击空白处立刻熄。碰屏幕亮屏打开时，熄屏后第一下触摸只负责点亮，不会误按到确认。*/
typedef void (*ui_brightness_saver_t)(uint8_t percent);
void ui_set_brightness(uint8_t percent, ui_brightness_saver_t saver);
void ui_set_screen_timeout(uint16_t seconds);     /* 0＝不熄屏 */
/* 熄屏时碰屏幕能不能点亮：false＝只有按键能亮（熄屏时触摸芯片深睡，更省电、口袋里不会误亮）。
 * 亮着时双击空白处熄屏，两种都有 */
void ui_set_tap_wake(bool on);
void ui_set_double_tap_off(bool on);   /* 亮着时双击空白处熄屏，默认开 */
/* 按键或新卡片时调用；返回调用前屏幕是不是熄着（是的话调用方应当吞掉这次按键）*/
bool ui_wake(void);
/** 滑动/动画期间开整屏刷新，停下来关掉：滑动要连贯，静止要省 CPU */
void ui_set_full_refresh(bool on);
/** 帧率自测：开始计、读结果（fps 放大 10 倍返回，避免浮点） */
void ui_measure_start(void);
void ui_measure_report(uint32_t *fps_x10, uint32_t *worst_ms, uint32_t *frames);
void ui_measure_split(uint32_t *render_ms_x10, uint32_t *total_ms_x10);
uint32_t ui_measure_trace(uint16_t *at, uint16_t *cost, uint32_t max);
uint32_t ui_anim_steps(void);
void ui_goto_page_animated(int page);

/** 屏幕是不是已经熄了。熄屏时后台可以放慢轮询 */
bool ui_screen_off(void);
/* 调试：直接打开亮度面板 */
void ui_open_brightness(void);

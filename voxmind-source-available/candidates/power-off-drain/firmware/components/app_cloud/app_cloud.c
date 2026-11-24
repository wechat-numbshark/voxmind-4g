#include "app_cloud.h"

#include <ctype.h>
#include <math.h>
#include <dirent.h>
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <sys/time.h>
#include <unistd.h>

#include "board.h"
#include "driver/gpio.h"
#include "esp_timer.h"
#include "esp_pm.h"
#include "cJSON.h"
#include "codec_opus.h"
#include "drv_audio.h"
#include "drv_feedback.h"
#include "drv_display.h"
#include "drv_modem.h"
#include "drv_power.h"
#include "drv_input.h"
#include "drv_storage.h"
#include "ui.h"
#include "esp_check.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_modem_api.h"
#include "esp_netif_ppp.h"
#include "esp_task_wdt.h"
#include "esp_netif_sntp.h"
#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"
#include "esp_vfs_fat.h"
#include "mbedtls/base64.h"
#include "mbedtls/sha256.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "esp_system.h"
#include "esp_sleep.h"
#include "esp_app_desc.h"
#include "esp_attr.h"
#include "ota.h"
#include "voice_cmd.h"
#include "runtime_protocol.h"
#include "command_runtime.h"
#include "runtime_diagnostics.h"
#include "battery_logic.h"

#define NET_READY_BIT BIT0
#define MODEM_FAST_BAUD 460800
#define PENDING_ROOT STORAGE_MOUNT_POINT "/pending"
#define REJECTED_ROOT STORAGE_MOUNT_POINT "/rejected"
#define IO_BUFFER_BYTES 4096
#define CAPTURE_BUFFER_SECONDS 8

static const char *TAG = "cloud_app";
static EventGroupHandle_t s_network_events;
static void modem_sleep_update(void);   /* 4G 模组休眠，定义见下方「4G 模组休眠」 */
/* 4G 模组休眠：先关。2026-10-04 实测开着休眠跑了 11 分钟后模组彻底不理人（DTR 拉低也叫不醒、AT 全超时），
 * 设备以为还在线，10 小时没传上一块（2384 块积压在卡里），只有重启能救。省的 20~27mA 不值这个风险，
 * 查清再开。代码留着，串口 msleep on 可以手动试。*/
#define MODEM_SLEEP_DEFAULT 0
static volatile bool s_ota_running;     /* 正在下载固件：界面定格、联网自检不管 */
static volatile int64_t s_net_ok_us;     /* 最近一次真的连到服务器（拿到任何 HTTP 状态码）的时刻 */
static volatile bool s_time_ok;         /* SNTP 对过时 */
static esp_netif_t *s_ppp_netif;
static bool s_tried_fast_uart;
static bool fast_uart_allowed(void);
static void save_fast_uart_allowed(bool ok);
static esp_modem_dce_t *s_dce;
static char s_current_session[37];
static char s_device_key[129];
static bool s_display_ready;
static TaskHandle_t s_main_task;
static TaskHandle_t s_action_task;
static TaskHandle_t s_upload_task;

static void wake_actions(void) { if (s_action_task) xTaskNotifyGive(s_action_task); }
static void wake_uploads(void) { if (s_upload_task) xTaskNotifyGive(s_upload_task); }
/* 上传任务当前卡在哪一步、卡了多久——诊断任务每 30 秒报一次。*/
static const char *volatile s_upload_stage = "启动";
static volatile TickType_t s_upload_stage_tick;

static void upload_stage(const char *stage)
{
    s_upload_stage = stage;
    s_upload_stage_tick = xTaskGetTickCount();
}

static const char *parse_sequence(const char *name, unsigned *sequence);

/* 采集与落盘解耦（docs/20 §4.2 "音频采集绝不能被上传阻塞"）：采集任务只做
 * "读麦→混成单声道→塞进 PSRAM 环形缓冲"，录音循环从缓冲里取数据编码落盘。
 * 实测 20260919：原来 I2S DMA 只有 90ms 缓冲、读麦和落盘在同一个循环里，块边界
 * 上的 fsync/rename/open 加上上传/扫描抢 SD 卡，一慢就溢出丢音频——每个 5 秒块
 * 实际耗时 5.05~5.4 秒，约 6% 的声音被悄悄丢掉。现在 SD 卡卡顿 8 秒以内都不丢，
 * 真丢了也会被计数、由诊断报出来，而不是悄无声息。*/
static StreamBufferHandle_t s_pcm_stream;
static volatile bool s_paused;              /* 用户按录音键暂停了录音 */
/* 正在屏上等你确认的那条到点提醒。空＝没有。
 * 提醒和"要不要办"的卡片是两回事：卡片问你要不要做，提醒只是怕你错过。*/
static char s_reminder_id[40];
static TickType_t s_reminder_hide_at;       /* 自动消失模式下什么时候收起来；0＝一直留着 */
static volatile uint32_t s_captured_samples;
static volatile uint32_t s_dropped_samples;
/* 屏幕电平条用的音量 0~100。攻击快、衰减慢，否则条会抖得看不清。*/
static volatile uint8_t s_input_level;
static int16_t s_audio_stereo[IO_BUFFER_BYTES / sizeof(int16_t)];     /* 仅采集任务用 */
static int16_t s_audio_mono[IO_BUFFER_BYTES / (sizeof(int16_t) * 2)]; /* 仅采集任务用 */
static int16_t s_chunk_pcm[IO_BUFFER_BYTES / sizeof(int16_t)];        /* 仅录音循环用 */

static volatile uint32_t s_pending_chunks;  /* 卡上待传块数，开机整理时统计，之后增减 */
static volatile uint32_t s_recorded_seconds; /* 本次开机实际编码过的声音，不含暂停 */
static uint32_t s_recorded_remainder;       /* 仅录音任务写，不跨任务读取 64 位采样数 */
static volatile int s_battery_pct = -1;     /* 诊断任务每 30 秒刷新一次，界面只读缓存不做 I2C */
static volatile bool s_charging;

/* ── 电池：关机掉电实测、电量计重置、平滑显示、低电量保护（docs/31、docs/32）──
 *
 * 关机前把电量、电压、时间记进 RTC 内存（深睡眠不丢，断电才丢）。电量计 MAX17048 关机期间
 * 一直通着电、一直在算，开机时读它一下就知道"关了 X 小时掉了 Y%"，换算成关机电流随心跳上报。
 * 不用串电流表，每次关机都自动有数据。电池在关机期间被放空的话，RTC 和电量计都会断电重置，
 * 这时上报 diedWhileOff。*/
#define BATTERY_MAH 1050
#define OFF_REC_MAGIC 0x0FFD7A1Au
typedef struct { uint32_t magic; int64_t at_s; int32_t mv; int32_t soc_x100; uint32_t modem_cut; uint32_t check; } off_record_t;
static RTC_NOINIT_ATTR off_record_t s_off_rec;
static char s_power_boot_json[200];          /* 本次开机算出来的关机掉电，整次开机都随心跳带上 */
static volatile bool s_gauge_needs_qs;       /* 电量计刚被重置过，等拔了电再按电压重估一次 */
static volatile bool s_gauge_reset_boot;
static volatile int s_battery_mv = -1;
static volatile float s_battery_crate;
static volatile int s_usb_present = -1;      /* 改线 B 后可直接读；-1 不知道 */
static uint32_t off_rec_check(const off_record_t *r)
{
    return r->magic ^ (uint32_t)r->at_s ^ (uint32_t)(r->at_s >> 32) ^ (uint32_t)r->mv * 2654435761u ^
           (uint32_t)r->soc_x100 * 40503u ^ r->modem_cut;
}
static volatile bool s_charge_full;

/* ── 软关机与定时开关机 ──────────────────────────────────────────
 * 软关机是一个单独的开机模式：进入时先把当前这段录音存好，在 RTC 内存里记一个
 * 标记再重启；重启后看到标记，就只开麦克风和离线指令识别，不录音、不开 4G、不上传，
 * 屏幕熄灭。听到「小沃，开机」、按一下录音键、或到了定时开机时间，就清掉标记
 * 再重启一次回到正常录音。
 * 为什么不在运行中途关掉 4G 再重新拨号：PPP 连接是开机时一次性建起来的，中途拆掉
 * 重建容易留下状态不一致；而「开机」本来就该是一次干净的启动，还天然开一段新的
 * 录音会话，时间线不会错位。RTC_NOINIT 内存在软件重启后保留、上电时是随机值，
 * 所以用一个 32 位魔数判断，不会误进软关机。*/
#define SOFT_OFF_MAGIC 0x50F70FF5u
/* 软关机画面上的耗电提醒：用户选软关机时后台已经提示过，这里再说一次 */
#define SOFT_OFF_NOTE "仍在听唤醒词，比真关机耗电"
static RTC_NOINIT_ATTR uint32_t s_soft_off_flag;

#define MAX_WAKE_PHRASES 4
typedef struct {
    bool schedule_enabled;
    bool schedule_soft;        /* 到点是软关机还是真关机 */
    int16_t off_min, on_min;   /* 北京时间，一天中的第几分钟 */
    uint8_t phrase_count;
    char phrases[MAX_WAKE_PHRASES][40];   /* 离线识别用的拼音指令串，如 "xiao wo kai ji" */
    char wake_word[32];                   /* 唤醒词原文，只用来在屏幕上提示 */
    uint8_t led_mode;                     /* led_mode_t；存进 NVS，没联网时也按管理员设的档来 */
    uint16_t screen_off_sec;              /* 多久不碰熄屏，0＝不熄 */
    bool wake_on_card;                    /* 有事要你确认时点亮屏幕 */
    uint16_t chunk_sec;                   /* 一块录多少秒。块越长，每块 1.2KB 的协议开销摊得越薄，
                                           * 代价是转写晚出来、掉电最多丢这么多秒。一次录音中途不变 */
    uint16_t audio_bitrate;               /* 音质：码率 */
    uint8_t audio_complexity;             /* 音质：编码复杂度。调低＝省 CPU、更流畅，但压缩率差一点 */
    bool wake_on_done;                    /* 事情办完（回执）时点亮屏幕 */
    bool power_key_soft;                  /* 长按录音键：false＝真关机（默认），true＝软关机 */
    bool tap_wake;                        /* 熄屏时碰屏幕能点亮（默认）；false＝只有按键能亮，触摸芯片熄屏深睡 */
    bool dtap_off;                        /* 亮着时双击空白处熄屏 */
} device_cfg_t;
static device_cfg_t s_cfg = {
    .off_min = 23 * 60, .on_min = 7 * 60, .phrase_count = 2,
    .phrases = { "xiao wo kai ji", "xiao wo xiao wo kai ji" },
    .wake_word = "小沃小沃",
    .screen_off_sec = 20,
    .wake_on_card = true, .wake_on_done = false, .tap_wake = true, .dtap_off = true,
    .chunk_sec = CONFIG_VOXMIND_CHUNK_SECONDS,
    .audio_bitrate = CONFIG_VOXMIND_OPUS_BITRATE, .audio_complexity = CONFIG_VOXMIND_OPUS_COMPLEXITY,
};

static void load_device_cfg(void)
{
    nvs_handle_t nvs;
    if (nvs_open("voxmind", NVS_READONLY, &nvs) != ESP_OK) return;
    /* 新版本只在结构体末尾加字段：旧固件存的短一截，读进来后缺的字段保持默认值，
     * 这样升级固件不会把用户的定时开关机、唤醒词等设置丢掉 */
    device_cfg_t stored = s_cfg;
    size_t size = 0;
    if (nvs_get_blob(nvs, "device_cfg", NULL, &size) == ESP_OK && size > 0 && size <= sizeof(stored) &&
        nvs_get_blob(nvs, "device_cfg", &stored, &size) == ESP_OK &&
        stored.phrase_count > 0 && stored.phrase_count <= MAX_WAKE_PHRASES) s_cfg = stored;
    nvs_close(nvs);
}

static void save_device_cfg(void)
{
    nvs_handle_t nvs;
    if (nvs_open("voxmind", NVS_READWRITE, &nvs) != ESP_OK) return;
    nvs_set_blob(nvs, "device_cfg", &s_cfg, sizeof(s_cfg));
    nvs_commit(nvs);
    nvs_close(nvs);
}

static int16_t parse_hhmm(const char *s, int16_t fallback)
{
    int h, m;
    return s && sscanf(s, "%d:%d", &h, &m) == 2 && h >= 0 && h < 24 && m >= 0 && m < 60 ? (int16_t)(h * 60 + m) : fallback;
}

/* 心跳响应里带的配置（唤醒词拼音、定时开关机）。变了才写 NVS，断网时照旧按存下的执行 */
static void apply_device_config(const cJSON *config)
{
    if (!cJSON_IsObject(config)) return;
    device_cfg_t next = s_cfg;
    const cJSON *sch = cJSON_GetObjectItem(config, "schedule");
    if (cJSON_IsObject(sch)) {
        next.schedule_enabled = cJSON_IsTrue(cJSON_GetObjectItem(sch, "enabled"));
        const char *mode = cJSON_GetStringValue(cJSON_GetObjectItem(sch, "mode"));
        next.schedule_soft = mode && strcmp(mode, "soft") == 0;
        next.off_min = parse_hhmm(cJSON_GetStringValue(cJSON_GetObjectItem(sch, "offAt")), next.off_min);
        next.on_min = parse_hhmm(cJSON_GetStringValue(cJSON_GetObjectItem(sch, "onAt")), next.on_min);
    }
    const cJSON *off = cJSON_GetObjectItem(config, "screenOffSec");
    if (cJSON_IsNumber(off) && off->valuedouble >= 0 && off->valuedouble <= 3600) next.screen_off_sec = (uint16_t)off->valuedouble;
    const cJSON *chunk = cJSON_GetObjectItem(config, "chunkSec");
    if (cJSON_IsNumber(chunk) && chunk->valuedouble >= 5 && chunk->valuedouble <= 30) next.chunk_sec = (uint16_t)chunk->valuedouble;
    const cJSON *rate = cJSON_GetObjectItem(config, "audioBitrate");
    if (cJSON_IsNumber(rate) && rate->valuedouble >= 8000 && rate->valuedouble <= 64000) next.audio_bitrate = (uint16_t)rate->valuedouble;
    const cJSON *cx = cJSON_GetObjectItem(config, "audioComplexity");
    if (cJSON_IsNumber(cx) && cx->valuedouble >= 0 && cx->valuedouble <= 10) next.audio_complexity = (uint8_t)cx->valuedouble;
    const cJSON *wake_card = cJSON_GetObjectItem(config, "wakeOnCard");
    if (cJSON_IsBool(wake_card)) next.wake_on_card = cJSON_IsTrue(wake_card);
    const cJSON *wake_done = cJSON_GetObjectItem(config, "wakeOnDone");
    if (cJSON_IsBool(wake_done)) next.wake_on_done = cJSON_IsTrue(wake_done);
    const cJSON *tap = cJSON_GetObjectItem(config, "wakeOnTap");
    if (cJSON_IsBool(tap)) next.tap_wake = cJSON_IsTrue(tap);
    const cJSON *dtap = cJSON_GetObjectItem(config, "doubleTapOff");
    if (cJSON_IsBool(dtap)) next.dtap_off = cJSON_IsTrue(dtap);
    const char *power_key = cJSON_GetStringValue(cJSON_GetObjectItem(config, "powerKey"));
    if (power_key) next.power_key_soft = strcmp(power_key, "soft") == 0;
    const char *led = cJSON_GetStringValue(cJSON_GetObjectItem(config, "ledMode"));
    if (led) next.led_mode = strcmp(led, "off") == 0 ? LED_MODE_OFF
                           : strcmp(led, "dark_while_recording") == 0 ? LED_MODE_DARK_WHILE_RECORDING : LED_MODE_DESIGNED;
    const char *word = cJSON_GetStringValue(cJSON_GetObjectItem(config, "wakeWord"));
    if (word && word[0]) strlcpy(next.wake_word, word, sizeof(next.wake_word));
    const cJSON *on = cJSON_GetObjectItem(cJSON_GetObjectItem(config, "wakePhrases"), "on");
    if (cJSON_IsArray(on) && cJSON_GetArraySize(on) > 0) {
        next.phrase_count = 0;
        const cJSON *item;
        cJSON_ArrayForEach(item, on) {
            const char *phrase = cJSON_GetStringValue(item);
            if (phrase && next.phrase_count < MAX_WAKE_PHRASES)
                strlcpy(next.phrases[next.phrase_count++], phrase, sizeof(next.phrases[0]));
        }
    }
    if (memcmp(&next, &s_cfg, sizeof(next)) != 0) {
        s_cfg = next;
        save_device_cfg();
        led_set_mode((led_mode_t)s_cfg.led_mode);
        if (s_display_ready) { ui_set_screen_timeout(s_cfg.screen_off_sec); ui_set_tap_wake(s_cfg.tap_wake); ui_set_double_tap_off(s_cfg.dtap_off); }
        ESP_LOGI(TAG, "设备配置已更新：定时开关机=%d %02d:%02d→%02d:%02d %s，唤醒指令 %d 条，长按录音键＝%s",
                 s_cfg.schedule_enabled, s_cfg.off_min / 60, s_cfg.off_min % 60, s_cfg.on_min / 60, s_cfg.on_min % 60,
                 s_cfg.schedule_soft ? "软关机" : "真关机", s_cfg.phrase_count, s_cfg.power_key_soft ? "软关机" : "真关机");
    }
}

static int minute_of_day(void)
{
    time_t now = time(NULL);
    struct tm tm;
    localtime_r(&now, &tm);
    return tm.tm_hour * 60 + tm.tm_min;
}

/* 分钟钟面上从 prev 走到 now，是否跨过了 target。只看"跨过"而不看"在不在区间里"：
 * 用户在关机时段内手动开机，不会被立刻关掉，要等到明天的关机时间才再关。*/
static bool crossed(int prev, int now, int target)
{
    int step = (now - prev + 1440) % 1440;
    int dist = (target - prev + 1440) % 1440;
    return step > 0 && dist > 0 && dist <= step;
}

/* 从现在到下一次 target 分钟还有多少秒 */
static int64_t seconds_until(int target_min)
{
    time_t now = time(NULL);
    struct tm tm;
    localtime_r(&now, &tm);
    int64_t now_s = tm.tm_hour * 3600 + tm.tm_min * 60 + tm.tm_sec;
    int64_t delta = (int64_t)target_min * 60 - now_s;
    return delta <= 0 ? delta + 86400 : delta;
}

/* verb 原来只有 10 字节，"ack_reminder"（12 个字）被 strlcpy 截成 "ack_remin"，
 * 对不上"收下提醒"的分支，掉进确认卡片的通用分支，发出 /v1/device-actions//ack_remin，
 * 服务器 404，屏上显示「操作失败」——提醒也就从来没被确认过，服务器一直重推。
 * 下面的静态断言保证以后再加长命令名时编译期就报错，不会再静默截断。*/
typedef struct { char id[40]; char verb[16]; } ui_cmd_t;
_Static_assert(sizeof("ack_reminder") <= sizeof(((ui_cmd_t *)0)->verb), "ui_cmd_t.verb 装不下 ack_reminder");
static QueueHandle_t s_ui_cmds;
static char s_visible_card[40];              /* 屏幕上正显示的卡片，实体键用 */
static volatile bool s_shutdown_requested;   /* 录音循环看到它就录完当前块收尾退出 */
static volatile TickType_t s_soft_screen_until;   /* 软关机时屏幕亮到什么时候 */
static SemaphoreHandle_t s_recorder_stopped;

/* 界面每秒读一次状态：只读内存，不做任何 I/O。录音状态取自"最近 2 秒麦克风
 * 确实有新采样进来"，而不是"我们以为在录"——docs/20 §10 要求录音指示不可伪造。*/
static void ui_status(ui_status_t *out)
{
    runtime_diag_heartbeat(DIAG_UI); /* LVGL progress, even with the backlight off. */
    static uint32_t last_captured;
    static TickType_t last_change;
    TickType_t now = xTaskGetTickCount();
    uint32_t captured = s_captured_samples;
    if (captured != last_captured || !last_change) { last_captured = captured; last_change = now; }
    out->recording = captured > 0 && !s_paused && (now - last_change) < pdMS_TO_TICKS(2000);
    out->paused = s_paused;
    out->recording_seconds = s_recorded_seconds;
    out->network = s_network_events && (xEventGroupGetBits(s_network_events) & NET_READY_BIT);
    out->time_valid = time(NULL) > 1700000000;
    out->battery_pct = s_battery_pct;
    out->charging = s_charging;
    out->charge_full = s_charge_full;
    out->pending_uploads = s_pending_chunks;
    out->input_level = s_input_level;
}

/* ── 充电推断 + 指示灯 ─────────────────────────────────────────────
 *
 * 板子上 CHG_PGOOD 没接到 MCU，读不到"是否插着电"，只能推断。以前只看电量计的
 * CRATE（充放电速率），它是按 SOC 变化算的，插上电要好几分钟才转正——屏幕上的
 * 充电标志总是慢半拍。
 *
 * 更快的信号是电池电压：充电器一接上，充电电流流过电池内阻，端电压立刻抬高
 * 几十 mV；一拔掉立刻掉回去。每 2 秒采一次，拿"最近 3 次的中位数"和"6~10 秒前
 * 的中位数"比，跳变超过 35mV、且新电平保持住，就认定插拔。4G 发射的瞬时大电流
 * 也会把电压拉低几十 mV，但那是一两百毫秒的尖峰，中位数和"保持住"两道滤掉它。
 * CRATE 留作兜底：跳变漏判时，几分钟后 CRATE 也会把状态纠正过来。*/
#define VSTEP_MV 60          /* 实测：4G 连上/断开这种负载变化能造成 30~40mV 的台阶，充电器要比它大 */
#define VHIST 6
#define LOCK_MS 60000        /* 一次判定之后 60 秒内不许反向翻转，防止来回跳 */

static int median3(int a, int b, int c)
{
    return a > b ? (b > c ? b : (a > c ? c : a)) : (a > c ? a : (b > c ? c : b));
}

static void infer_charging(const power_status_t *b, bool net)
{
    static int hist[VHIST];      /* mV，hist[0] 最新 */
    static int filled;
    static int crate_votes;
    static bool last_net;
    static TickType_t quiet_until, locked_until;
    TickType_t now_tick = xTaskGetTickCount();
    memmove(hist + 1, hist, sizeof(int) * (VHIST - 1));
    hist[0] = (int)(b->voltage_v * 1000.0f + 0.5f);
    if (filled < VHIST) ++filled;
    /* 联网状态刚变过（4G 附着/掉线是这台设备最大的负载变化）：这段时间的电压台阶不算数 */
    if (net != last_net) { last_net = net; quiet_until = now_tick + pdMS_TO_TICKS(20000); filled = 1; }

    bool charging = s_charging;
    const char *why = NULL;
    bool locked = (int32_t)(locked_until - now_tick) > 0;
    if (filled == VHIST && (int32_t)(quiet_until - now_tick) <= 0) {
        int now = median3(hist[0], hist[1], hist[2]);
        int before = median3(hist[3], hist[4], hist[5]);
        int step = now - before;
        /* 校准用：记下所有明显的台阶，插拔一次就知道充电器台阶和负载台阶各有多大 */
        if (step >= 15 || step <= -15) ESP_LOGI(TAG, "电压台阶 %+dmV（%d→%d），CRATE %.1f%%/h", step, before, now, b->crate_pct_h);
        if (step >= VSTEP_MV && !charging)       { charging = true;  why = "电压跳升"; }
        else if (-step >= VSTEP_MV && charging)  { charging = false; why = "电压跳降"; }
    }
    /* CRATE 兜底：它滞后几分钟但不会被尖峰骗。连续 5 次（约 10 秒）同号、且幅度够大才采信，
     * 并且刚由电压判定过的 60 秒内不许它推翻 */
    crate_votes = b->crate_pct_h > 3.0f ? (crate_votes > 0 ? crate_votes + 1 : 1)
                : b->crate_pct_h < -3.0f ? (crate_votes < 0 ? crate_votes - 1 : -1) : 0;
    /* 快充满时充电器转恒压、电流很小，设备自己的耗电比它还大，CRATE 会在 -8~+6%/h 来回跳：
     * 2026-10-03 插着线 20 分钟电量 91→94.5%，后台却一直显示"没在充"。所以电压停在恒压段
     * （≥4.15V）时不采信 CRATE 的"在放"；拔线后哪怕电池满，带着负载也落在 4.07V 左右（同日实测），
     * 而且拔线那一下会有上百 mV 的跳降，上面的电压判据先抓住。*/
    int vmin = hist[0];
    for (int i = 1; i < filled; ++i) if (hist[i] < vmin) vmin = hist[i];
    bool cv_hold = filled == VHIST && vmin >= 4160;
    if (!why && !locked && (crate_votes >= 5 || cv_hold) && !charging) { charging = true; why = crate_votes >= 5 ? "电量计显示在充" : "电压停在充电恒压段"; }
    if (!why && !locked && crate_votes <= -5 && charging && hist[0] < 4150) { charging = false; why = "电量计显示在放"; }
    /* 充满后充电芯片停充，电压不再抬、CRATE 归零；插着线、电压稳在 4.15V 以上算"已充满" */
    s_charge_full = charging && b->soc_pct >= 99.0f && hist[0] >= 4150;

    if (why) {
        ESP_LOGI(TAG, "充电状态 → %s（%s，%dmV，CRATE %.1f%%/h）", charging ? "充电中" : "未充电", why, hist[0], b->crate_pct_h);
        s_charging = charging;
        locked_until = now_tick + pdMS_TO_TICKS(LOCK_MS);
        filled = 1;              /* 判定之后重新攒窗口，同一个台阶不会被数两次 */
    }
    s_battery_pct = (int)(b->soc_pct + 0.5f);
}

static void power_off(const char *reason, bool soft);

/* 反方向的变化持续 3 分钟（90 次 × 2 秒）才采信，见 battery_logic.h */
static int smooth_battery_pct(int raw, bool charging, bool reset)
{
    static battery_smooth_t st = BATTERY_SMOOTH_INIT;
    return battery_smooth(&st, raw, charging, reset, 90);
}

/* 每 2 秒一次，跟在 infer_charging 后面 */
static void battery_after_read(const power_status_t *b)
{
    static unsigned discharging_n, low_n;
    int usb = power_usb_present();
    s_usb_present = usb;
    if (usb >= 0 && (bool)usb != s_charging) {
        ESP_LOGI(TAG, "充电状态 → %s（/PGOOD 直读）", usb ? "充电中" : "未充电");
        s_charging = usb;
    }
    int mv = (int)(b->voltage_v * 1000.0f + 0.5f);
    s_battery_mv = mv;
    s_battery_crate = b->crate_pct_h;

    /* 电量计刚上过电：它的数是上电那一刻凭电压猜的。那一刻通常插着充电器（电池被放空后，
     * 一般要插电才能把电池保护板唤醒），电压被抬高，估出来偏高，之后就"掉得飞快"。
     * 等确定没插电、而且电量计自己也显示在放电满 1 分钟，再按此刻的电压重估一次。*/
    discharging_n = !s_charging && b->crate_pct_h < 0.0f ? discharging_n + 1 : 0;
    if (s_gauge_needs_qs && !s_charging &&
        (usb == 0 || (usb < 0 && discharging_n >= 30 && esp_timer_get_time() > 180LL * 1000000))) {
        float before = b->soc_pct;
        if (power_quick_start() == ESP_OK) {
            s_gauge_needs_qs = false;
            vTaskDelay(pdMS_TO_TICKS(1200));        /* 重估要大约 1 秒才出新数 */
            power_status_t again;
            if (power_read(&again) == ESP_OK) {
                ESP_LOGW(TAG, "电量计重估：%.1f%% → %.1f%%（%dmV）", before, again.soc_pct, mv);
                s_battery_pct = smooth_battery_pct((int)(again.soc_pct + 0.5f), s_charging, true);
            }
        }
    } else {
        s_battery_pct = smooth_battery_pct((int)(b->soc_pct + 0.5f), s_charging, false);
    }

    /* 低电量保护：带载电压低于 3.40V 持续 1 分钟就自己关机。不关的话会一路放到电池保护板
     * 切断，每次都是深度过放，电池会越来越不耐用；电量计也会跟着断电重置，电量又不准了。
     * 做了改线 A 的板子关机后模组也断电，电池能一直留在这个电量。*/
    low_n = !s_charging && usb != 1 && mv > 2500 && mv < 3400 ? low_n + 1 : 0;
    if (low_n == 30) {
        ESP_LOGW(TAG, "电压 %dmV 持续 1 分钟低于 3.40V，自动关机保护电池", mv);
        if (s_display_ready) ui_show_message("电量耗尽", "已自动关机，请充电");
        vTaskDelay(pdMS_TO_TICKS(2500));
        power_off("电量耗尽", false);
    }
}

/* 开机时：看电量计有没有被重置过，以及上次关机之后掉了多少电 */
static void power_boot_check(void)
{
    bool reset = false;
    if (power_gauge_was_reset(&reset) == ESP_OK && reset) {
        s_gauge_reset_boot = true;
        s_gauge_needs_qs = true;
        power_clear_reset_flag();
        ESP_LOGW(TAG, "电量计刚上过电（电池被放空或拔过），电量先按电压估，等拔电后重估");
    }
    off_record_t r = s_off_rec;
    s_off_rec.magic = 0;
    bool from_sleep = esp_reset_reason() == ESP_RST_DEEPSLEEP;
    if (r.magic != OFF_REC_MAGIC || r.check != off_rec_check(&r)) {
        /* 记录没了：RTC 断过电。不是从深睡醒来（POWERON）且电量计也重置了，基本就是关机期间被放空了 */
        if (!from_sleep && reset)
            snprintf(s_power_boot_json, sizeof(s_power_boot_json), "\"offDrain\":{\"diedWhileOff\":true},");
        return;
    }
    power_status_t b;
    struct timeval tv;
    gettimeofday(&tv, NULL);
    double hours = (double)(tv.tv_sec - r.at_s) / 3600.0;
    if (power_read(&b) != ESP_OK || hours <= 0.0 || hours > 24.0 * 120) return;
    float soc_from = r.soc_x100 / 100.0f;
    /* 关不到 1 小时的，电量计的分辨率不够算电流，只报原始数（estMa=-1）*/
    double est_ma = battery_off_drain_ma(soc_from, b.soc_pct, hours, BATTERY_MAH);
    int mv_now = (int)(b.voltage_v * 1000.0f + 0.5f);
    snprintf(s_power_boot_json, sizeof(s_power_boot_json),
             "\"offDrain\":{\"hours\":%.2f,\"socFrom\":%.1f,\"socTo\":%.1f,\"mvFrom\":%ld,\"mvTo\":%d,"
             "\"estMa\":%.2f,\"modemCut\":%s,\"gaugeReset\":%s},",
             hours, soc_from, b.soc_pct, (long)r.mv, mv_now, est_ma, r.modem_cut ? "true" : "false", reset ? "true" : "false");
    ESP_LOGW(TAG, "上次关机 %.1f 小时：电量 %.1f%% → %.1f%%，电压 %ldmV → %dmV，折合关机电流约 %.2f mA（模组%s断电）",
             hours, soc_from, b.soc_pct, (long)r.mv, mv_now, est_ma, r.modem_cut ? "已" : "未");
}

/* 真关机前：把此刻的电量记进 RTC，开机时算关机掉电用 */
static void power_record_before_off(bool modem_cut)
{
    power_status_t b;
    if (power_read(&b) != ESP_OK) return;
    struct timeval tv;
    gettimeofday(&tv, NULL);
    off_record_t r = { .magic = OFF_REC_MAGIC, .at_s = tv.tv_sec, .mv = (int32_t)(b.voltage_v * 1000.0f + 0.5f),
                       .soc_x100 = (int32_t)(b.soc_pct * 100.0f), .modem_cut = modem_cut };
    r.check = off_rec_check(&r);
    s_off_rec = r;
}

/* 心跳里的电池详情。没有改线时 usb 字段是 null */
static int power_json(char *out, size_t cap)
{
    if (s_battery_mv < 0) { if (cap) out[0] = 0; return 0; }
    const char *usb = s_usb_present < 0 ? "null" : s_usb_present ? "true" : "false";
    return snprintf(out, cap, ",\"power\":{%s\"mv\":%d,\"crate\":%.1f,\"usb\":%s,\"gaugeReset\":%s,\"modemSwitch\":%s}",
                    s_power_boot_json, s_battery_mv, s_battery_crate, usb, s_gauge_reset_boot ? "true" : "false",
                    modem_supply_switch_works() ? "true" : "false");
}

/* 指示灯显示什么，由这里根据实际状态统一算：按优先级，要人处理的最先。*/
static led_pattern_t led_for_state(bool recording)
{
    bool net = s_network_events && (xEventGroupGetBits(s_network_events) & NET_READY_BIT);
    if (s_visible_card[0]) return LED_PENDING;                    /* 有事等你确认 */
    if (s_paused) return LED_OFF;                                 /* 暂停是用户自己选的，不是异常；灭灯也省电 */
    if (!recording) return LED_OFFLINE_CACHE;                     /* 麦克风没数据：异常，要看得见 */
    if (!net && s_pending_chunks > 0) return LED_OFFLINE_CACHE;   /* 离线，录音存在本地 */
    if (s_charging) return LED_CHARGING;
    return LED_RECORDING;
}

static void power_led_task(void *arg)
{
    uint32_t captured_prev = s_captured_samples;
    TickType_t last_sample_change = xTaskGetTickCount();
    for (unsigned tick = 0;; ++tick) {
        uint32_t captured = s_captured_samples;
        TickType_t now = xTaskGetTickCount();
        if (captured != captured_prev) { captured_prev = captured; last_sample_change = now; }
        bool recording = now - last_sample_change < pdMS_TO_TICKS(2000);
        if (tick % 4 == 0) {
            power_status_t battery;
            bool net = s_network_events && (xEventGroupGetBits(s_network_events) & NET_READY_BIT);
            if (power_read(&battery) == ESP_OK) {
                infer_charging(&battery, net);
                battery_after_read(&battery);
            }
        }
        led_set(led_for_state(recording));
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}

/* 在 LVGL 任务里被调用，只把请求丢进队列，真正的 HTTP 交给卡片任务做。*/
/* 已接受的回执删除在内存中保留到服务端确认；断网重试不会让旧回执重新冒出来。 */
#define MAX_PENDING_DISMISS 16
typedef struct { char id[40]; TickType_t retry_at; uint8_t tries; } pending_dismiss_t;
static pending_dismiss_t s_pending_dismiss[MAX_PENDING_DISMISS];
static portMUX_TYPE s_dismiss_mux = portMUX_INITIALIZER_UNLOCKED;

static bool dismissal_pending(const char *id)
{
    bool found = false;
    portENTER_CRITICAL(&s_dismiss_mux);
    for (unsigned i = 0; i < MAX_PENDING_DISMISS; ++i)
        if (strcmp(s_pending_dismiss[i].id, id) == 0) { found = true; break; }
    portEXIT_CRITICAL(&s_dismiss_mux);
    return found;
}

static bool ui_action_requested(const char *action_id, const char *verb)
{
    if (!action_id || !verb || !s_ui_cmds) return false;
    ui_cmd_t cmd = {0};
    if (strlen(action_id) >= sizeof(cmd.id) || strlen(verb) >= sizeof(cmd.verb)) return false;
    strlcpy(cmd.id, action_id, sizeof(cmd.id));
    strlcpy(cmd.verb, verb, sizeof(cmd.verb));
    if (strcmp(verb, "dismiss") == 0) {
        if (!action_id[0]) return false;
        bool accepted = false;
        int empty = -1;
        portENTER_CRITICAL(&s_dismiss_mux);
        for (unsigned i = 0; i < MAX_PENDING_DISMISS; ++i) {
            if (strcmp(s_pending_dismiss[i].id, action_id) == 0) { accepted = true; break; }
            if (!s_pending_dismiss[i].id[0] && empty < 0) empty = (int)i;
        }
        if (!accepted && empty >= 0) {
            strlcpy(s_pending_dismiss[empty].id, action_id, sizeof(s_pending_dismiss[empty].id));
            s_pending_dismiss[empty].retry_at = 0;
            s_pending_dismiss[empty].tries = 0;
            accepted = true;
        }
        portEXIT_CRITICAL(&s_dismiss_mux);
        /* 队列仅用于提前唤醒；即使满了，已登记的删除仍会在下一轮处理。 */
        if (accepted) { (void)xQueueSend(s_ui_cmds, &cmd, 0); wake_actions(); }
        else ESP_LOGW(TAG, "待同步回执已满，保留当前回执");
        return accepted;
    }
    bool accepted = xQueueSend(s_ui_cmds, &cmd, 0) == pdTRUE;
    if (accepted) wake_actions();
    if (!accepted) ESP_LOGW(TAG, "操作队列已满，未接受 %s", verb);
    return accepted;
}
static volatile unsigned s_recording_seq;   /* 当前会话正在录的块号 */
/* 这次录音用的块长。一次会话里不能变：块起点是按 seq×块长 算的，中途改了时间轴就错位。
 * 所以在新会话开始时才把后台改过的值取过来。*/
static uint16_t s_active_chunk_sec = CONFIG_VOXMIND_CHUNK_SECONDS;
static volatile TickType_t s_chunk_start_tick;  /* 当前这一块是什么时候开始录的，用来算"按住说话"的偏移 */
/* 「按住说话」：录音一直不停，长按只是给这一段打标记，只有被标记的话才送去抽意图。
 * 标记范围＝按住期间 + 松开后 8 秒，这样"按住说"和"按一下再说"两种习惯都管用。*/
/* 松手后多录 1.5 秒：够把最后一个字录完。以前是 8 秒（为了"按一下再说"的习惯），
 * 但那样松手后要白等 8 秒才能上传处理；用户的用法是按住说、松手就该处理（2026-10-02）。*/
#define TALK_TAIL_MS 1500
#define PAUSED_TALK_TAIL_MS TALK_TAIL_MS
/* 松手后屏上挂「处理中」，等服务器说这一句处理完了（出卡片/办完了/没听出要办的事）再收。
 * 用会话+开始毫秒认出是哪一次；最多等 90 秒，转写排队太久就先收起，结果出来照样会弹 */
static char s_work_session[40];
static uint32_t s_work_start_ms;
static TickType_t s_work_deadline;
static void work_end(const char *toast)
{
    if (!s_work_deadline) return;
    s_work_deadline = 0;
    if (s_display_ready) { ui_set_working(false); if (toast) ui_toast(toast); }
}
/* session 在松手那一刻记下：以前是发送时才取当前会话，暂停时按住会新开一段录音，取错了就对不上 */
typedef struct { uint32_t start_ms, end_ms; char session[40]; uint8_t tries; } talk_mark_t;
static QueueHandle_t s_talk_marks;
/* Immutable time windows; uploader alone owns consumption, no shared mutable session string. */
static QueueHandle_t s_priority_marks;
static uint32_t recording_offset_ms(void);
static volatile TickType_t s_talk_down_tick;
static volatile uint32_t s_talk_start_ms;
static volatile bool s_talk_paused;            /* 这次按住时录音是暂停着的 */
static volatile TickType_t s_talk_until_tick;  /* 按住说话：录到什么时候（松手 + 1.5 秒） */
static volatile bool s_talk_flush;             /* 按住说完：当前这块录到松手 +1.5 秒就收尾，马上上传，不等凑满一块 */
/* 当前这块在本次录音里的起点。块长现在会变（按住说完会提前收尾），
 * 不能再用"块号 × 块长"推起点，否则后面所有块的时间轴都会错位。*/
static volatile uint32_t s_chunk_offset_ms;
/* 一段录音（云端一个会话）从什么时候开始。分段只有两种：开机、按中间的返回键。
 * 暂停再继续不分段——时间轴按真实钟点接上，中间暂停的那段就是空着的（2026-10-07 用户要求）*/
static volatile TickType_t s_session_start_tick;
static volatile bool s_split_requested;         /* 按了返回键：当前这块就地收尾，接下来是新的一段 */
static uint32_t session_wall_ms(void) { return (uint32_t)((xTaskGetTickCount() - s_session_start_tick) * portTICK_PERIOD_MS); }
static QueueHandle_t s_btn_events;              /* 按键事件队列：串口调试命令往里塞，模拟按键 */
static volatile uint32_t s_poll_override_ms;    /* 耗电测量：临时改轮询间隔，0＝照常 */

/* 暂停时按住确认键：只录按住的这几句。
 * 以前暂停时麦克风的数据直接扔掉，屏上照样显示"在听"、照样把标记报给服务器——服务器拿着标记
 * 却没有对应的音频，命令就这么无声地丢了（2026-10-02 实测：说了"今天下午两点确认下那个计划"
 * 没有任何反应）。暂停是不想录周围的谈话，按住说话是用户主动下的命令，两件事不冲突。*/
static bool talk_window_open(void)
{
    if (s_talk_down_tick) return true;
    TickType_t until = s_talk_until_tick;
    return until && (int32_t)(until - xTaskGetTickCount()) > 0;
}
static bool recorder_paused(void) { return s_paused && !talk_window_open(); }

/* ── CPU 频率策略 ───────────────────────────────────────────────
 * 以前配置里开了电源管理，代码却从没调 esp_pm_configure，CPU 一直 240MHz 满速。
 * 2026-10-02 实测：
 *   - 黑屏暂停时 240→80MHz 省约 33mA
 *   - 录音编码在 80MHz 跟不上：录音任务占 96%，缓冲涨满、8 秒里丢了 7.4 秒音频
 *   - 160MHz 时录音任务 66%、不丢；240MHz 时 43~52%
 * 所以：亮屏 240（界面跟手）、黑屏录音 160（编码留三成余量）、黑屏暂停 80。
 * ESP-IDF 的调频是靠锁的、不会看负载自己升，所以录音和亮屏时都得拿着锁，频率上限按情况切。*/
static esp_pm_lock_handle_t s_pm_lock;
static SemaphoreHandle_t s_pm_mutex;
static int s_pm_mode = -1;

/* 串口实验用（不存盘、不改后台设置）：录音时 CPU 上限、编码复杂度。-1/0 = 不覆盖 */
static volatile int s_rec_mhz_override;
static volatile int s_opus_cx_override = -1;
static volatile bool s_pm_force;
/* 录音时实际在用的编码复杂度（换编码器时更新）；编码跟不上时置位，本次会话里录音改用 160MHz */
static volatile uint8_t s_active_cx = CONFIG_VOXMIND_OPUS_COMPLEXITY;
static volatile bool s_rec_boost;

/* 黑屏录音用多少 MHz。2026-10-03 串口实测（录音任务占单核%）：
 *   160MHz：复杂度 5 → 56%，2 → 37%，0 → 26~31%
 *   80MHz：复杂度 0 → 41%、不丢音频；复杂度 5 → 跟不上，看门狗重启
 * 同一段中文（干净/加噪声）复杂度 0 和 5 压出来，Qwen3-ASR 识别结果逐字相同。
 * 所以复杂度 0 时录音降到 80MHz；其它复杂度、或编码积压过（s_rec_boost）仍用 160。*/
static int rec_mhz(void)
{
    if (s_rec_mhz_override) return s_rec_mhz_override;
    return s_active_cx == 0 && !s_rec_boost ? 80 : 160;
}

static void pm_update(void)
{
    if (!s_pm_lock) return;
    xSemaphoreTake(s_pm_mutex, portMAX_DELAY);
    bool screen = s_display_ready && !ui_screen_off();
    int mode = screen ? 2 : !recorder_paused() ? 1 : 0;
    static int s_pm_rec = -1;
    if (mode == 1 && rec_mhz() != s_pm_rec) s_pm_force = true;
    if (mode != s_pm_mode || s_pm_force) {
        if (mode == 1) s_pm_rec = rec_mhz();
        s_pm_force = false;
        int rec = rec_mhz();
        esp_pm_config_t cfg = { .max_freq_mhz = mode == 2 ? 240 : mode == 1 ? rec : 160, .min_freq_mhz = 80, .light_sleep_enable = false };
        esp_pm_configure(&cfg);
        if (mode > 0 && s_pm_mode <= 0) esp_pm_lock_acquire(s_pm_lock);
        if (mode == 0 && s_pm_mode > 0) esp_pm_lock_release(s_pm_lock);
        ESP_LOGI(TAG, "CPU 频率：%s %dMHz", mode == 2 ? "亮屏" : mode == 1 ? "黑屏录音" : "黑屏暂停", mode == 2 ? 240 : mode == 1 ? rec : 80);
        s_pm_mode = mode;
    }
    xSemaphoreGive(s_pm_mutex);
}

static void pm_init(void)
{
    s_pm_mutex = xSemaphoreCreateMutex();
    if (esp_pm_lock_create(ESP_PM_CPU_FREQ_MAX, 0, "voxmind", &s_pm_lock) != ESP_OK) s_pm_lock = NULL;
}

static void on_screen_change(bool on) { (void)on; pm_update(); }

/* 每块的真实起点和时长记在会话目录的 index.txt（一行 "块号 起点ms 时长ms"）。上传可能在
 * 很久以后（断网积压、重启后补传），那时候内存里早就没有这些数了。*/
#define CHUNK_INDEX "index.txt"
static void chunk_timing_save(const char *session_dir, unsigned seq, uint32_t start_ms, uint32_t dur_ms)
{
    char path[200];
    snprintf(path, sizeof(path), "%s/" CHUNK_INDEX, session_dir);
    FILE *f = fopen(path, "a");
    if (!f) return;
    fprintf(f, "%u %lu %lu\n", seq, (unsigned long)start_ms, (unsigned long)dur_ms);
    fflush(f);
    fsync(fileno(f));
    fclose(f);
}

/* 找不到（老固件录的、断电抢救回来的半截块）就退回"块号 × 块长" */
static void chunk_timing_load(const char *session_id, unsigned seq, uint32_t *start_ms, uint32_t *dur_ms)
{
    *dur_ms = (uint32_t)s_active_chunk_sec * 1000U;
    *start_ms = seq * *dur_ms;
    char path[200];
    snprintf(path, sizeof(path), "%s/%s/" CHUNK_INDEX, PENDING_ROOT, session_id);
    FILE *f = fopen(path, "r");
    if (!f) return;
    unsigned s; unsigned long st, du;
    while (fscanf(f, "%u %lu %lu", &s, &st, &du) == 3) {
        if (s == seq && du > 0) { *start_ms = (uint32_t)st; *dur_ms = (uint32_t)du; break; }
    }
    fclose(f);
}


/* 会话目录里再记一份 meta.txt：开机号、开始时刻。云端会话往往是很久以后补传时才建
 * （断网积压、重启后），那时再取「当前开机号」「现在几点」就错了——2026-10-04 一夜积压的 10 小时
 * 录音，补传时全被当成中午开始的。网页「按开机」视图靠开机号把一次开机里暂停前后的几段拼起来。*/
#define SESSION_META "meta.txt"
static char s_boot_id[13];
static bool clock_valid(void) { return time(NULL) > 1767225600; }   /* 2026-01-01 之后才算对过时 */
static void session_meta_save(const char *session_dir)
{
    char path[200];
    snprintf(path, sizeof(path), "%s/" SESSION_META, session_dir);
    FILE *f = fopen(path, "w");
    if (!f) return;
    struct timeval tv;
    gettimeofday(&tv, NULL);
    long long epoch_ms = clock_valid() ? (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000 : 0;
    fprintf(f, "%s %lld %lld\n", s_boot_id, (long long)esp_timer_get_time(), epoch_ms);
    fflush(f);
    fsync(fileno(f));
    fclose(f);
}
/* 读出这个会话的开机号和开始时刻（ISO，UTC）。算不出开始时刻就留空，让云端用收到的时间 */
static void session_meta_load(const char *session_id, char boot[13], char started[32])
{
    boot[0] = started[0] = '\0';
    char path[200];
    snprintf(path, sizeof(path), "%s/%s/" SESSION_META, PENDING_ROOT, session_id);
    FILE *f = fopen(path, "r");
    if (!f) return;
    char b[16] = ""; long long start_us = 0, epoch_ms = 0;
    int n = fscanf(f, "%15s %lld %lld", b, &start_us, &epoch_ms);
    fclose(f);
    if (n < 1) return;
    strlcpy(boot, b, 13);
    if (n == 3 && epoch_ms == 0 && strcmp(b, s_boot_id) == 0 && clock_valid()) {
        /* 开机时还没对时：同一次开机里补传的话，用「现在 - 已过去的时间」倒推 */
        struct timeval tv;
        gettimeofday(&tv, NULL);
        epoch_ms = (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000 - (esp_timer_get_time() - start_us) / 1000;
    }
    if (epoch_ms > 0) {
        time_t sec = (time_t)(epoch_ms / 1000);
        struct tm tm;
        gmtime_r(&sec, &tm);
        char ymd[24];
        strftime(ymd, sizeof(ymd), "%Y-%m-%dT%H:%M:%S", &tm);
        snprintf(started, 32, "%.19s.%03dZ", ymd, (int)(epoch_ms % 1000));
    }
}

/* 麦克风开关只由采集任务自己做：录音主任务只改这个标记。
 * 2026-10-02 实测：暂停时从录音主任务直接调 audio_stop()，整机被看门狗重启——两个任务都在 CPU0，
 * 采集任务优先级最高、读麦克风时锁着通道，读完刚放开就立刻又锁上，低优先级的主任务永远抢不到锁，
 * 卡满 5 秒没喂狗。谁读麦克风就由谁开关，就不存在抢锁。*/
static volatile bool s_mic_wanted = true;

static void capture_task(void *arg)
{
    bool running = true;
    for (;;) {
        if (!s_mic_wanted) {
            if (running) { audio_stop(); running = false; }
            vTaskDelay(pdMS_TO_TICKS(20));      /* 按住确认键时 20ms 内就能重新打开 */
            continue;
        }
        if (!running) { audio_start(); running = true; }
        size_t bytes = 0;
        esp_err_t err = audio_read(s_audio_stereo, sizeof(s_audio_stereo), &bytes, 1000);
        /* 麦克风被停掉时（耗电测量最后一段）读取会立刻报错：歇一下再试，别在最高优先级上空转 */
        if (err != ESP_OK) { vTaskDelay(pdMS_TO_TICKS(100)); continue; }
        if (bytes == 0) continue;
        size_t frames = bytes / (sizeof(int16_t) * 2);
        for (size_t i = 0; i < frames; ++i)
            s_audio_mono[i] = (int16_t)(((int32_t)s_audio_stereo[i * 2] + s_audio_stereo[i * 2 + 1]) / 2);
        s_captured_samples += frames;

        /* 顺手算一下这一小段的峰值音量给屏幕用。开方是为了让正常说话落在
         * 条的中段——线性映射的话人声只能推动最下面一两格，看着像没在录。*/
        int32_t peak = 0;
        for (size_t i = 0; i < frames; ++i) {
            int32_t v = s_audio_mono[i] < 0 ? -s_audio_mono[i] : s_audio_mono[i];
            if (v > peak) peak = v;
        }
        uint8_t level = (uint8_t)(sqrtf((float)peak / 12000.0f) * 100.0f);
        if (level > 100) level = 100;
        uint8_t prev = s_input_level;
        s_input_level = level > prev ? level : (uint8_t)(prev - (prev - level) / 3);

        size_t want = frames * sizeof(int16_t);
        /* 只按整个采样点写入：半个采样点写进去会让后面所有数据错位成噪声 */
        size_t room = xStreamBufferSpacesAvailable(s_pcm_stream) & ~(size_t)1;
        size_t n = want < room ? want : room;
        if (n) xStreamBufferSend(s_pcm_stream, s_audio_mono, n, 0);
        if (n < want) s_dropped_samples += (uint32_t)((want - n) / sizeof(int16_t));
    }
}

typedef voxmind_http_response_t http_response_t;

static esp_err_t http_event(esp_http_client_event_t *event)
{
    if (event->event_id != HTTP_EVENT_ON_DATA || !event->user_data || event->data_len <= 0) return ESP_OK;
    http_response_t *response = event->user_data;
    return voxmind_response_append(response, event->data, (size_t)event->data_len)
        ? ESP_OK : ESP_ERR_INVALID_SIZE;
}

static void ppp_ip_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (id == IP_EVENT_PPP_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)data;
        xEventGroupSetBits(s_network_events, NET_READY_BIT);
        ESP_LOGI(TAG, "4G 已联网，开始补传，IP=" IPSTR, IP2STR(&event->ip_info.ip));
        modem_sleep_update();
    } else if (id == IP_EVENT_PPP_LOST_IP) {
        xEventGroupClearBits(s_network_events, NET_READY_BIT);
        ESP_LOGW(TAG, "4G 掉线");
        modem_sleep_update();          /* 掉线后重拨是我们主动发数据：先叫醒、不许睡 */
    }
}

static void ppp_status_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    ESP_LOGI(TAG, "PPP 状态变化 event=%" PRId32, id);
}

/* 按 SIM 卡的 IMSI 前缀自动识别运营商、选对应默认 APN，不用用户手动配置。
 * 中国 MCC=460，紧跟的 2 位 MNC 决定运营商（三大运营商 PLMN 分配表，2026-09-18
 * 核实）：
 *   移动 46000/02/04/07/08/13 → cmnet
 *   联通 46001/06/09/10       → 3gnet
 *   电信 46003/05/11/12       → ctnet
 * 查不到 IMSI 或前缀不认识时，退回 Kconfig 里配的默认值（不阻塞拨号）。*/
static const char *detect_apn(char *resp, size_t resp_len)
{
    /* 实测 20260918：模组刚开机完成（哪怕 AT 探测已经拿到过 OK）时，UART
     * 波特率自适应/内部服务栈有时还没完全稳定，AT+CIMI 会收到乱码而不是
     * 超时或 ERROR——一次失败不代表真的读不到 IMSI，重试几次再认命。*/
    esp_err_t cimi_err = ESP_FAIL;
    for (int i = 0; i < 4; ++i) {
        cimi_err = modem_at("AT+CIMI", "OK", resp, resp_len, 3000);
        if (cimi_err == ESP_OK) break;
        vTaskDelay(pdMS_TO_TICKS(800));
    }
    if (cimi_err != ESP_OK) {
        ESP_LOGW(TAG, "读取 IMSI 失败，APN 用默认值 %s", CONFIG_VOXMIND_APN);
        return CONFIG_VOXMIND_APN;
    }
    /* AT+CIMI 直接回传数字串(无 "+CIMI:" 前缀)，中间可能夹着 \r\n 和 "OK"；
     * 找第一段连续 ≥5 位数字，前 5 位就是 MCC+MNC。*/
    char mccmnc[6] = {0};
    for (const char *p = resp; *p; ++p) {
        if (!isdigit((unsigned char)*p)) continue;
        size_t n = 0;
        while (p[n] && isdigit((unsigned char)p[n]) && n < 5) ++n;
        if (n == 5) { memcpy(mccmnc, p, 5); break; }
        p += n;
        if (!*p) break;
    }
    if (!mccmnc[0]) {
        ESP_LOGW(TAG, "IMSI 格式没解析出来，APN 用默认值 %s: %.60s", CONFIG_VOXMIND_APN, resp);
        return CONFIG_VOXMIND_APN;
    }
    static const struct { const char *mccmnc; const char *apn; const char *carrier; } table[] = {
        {"46000", "cmnet", "中国移动"}, {"46002", "cmnet", "中国移动"},
        {"46004", "cmnet", "中国移动"}, {"46007", "cmnet", "中国移动"},
        {"46008", "cmnet", "中国移动"}, {"46013", "cmnet", "中国移动"},
        {"46001", "3gnet", "中国联通"}, {"46006", "3gnet", "中国联通"},
        {"46009", "3gnet", "中国联通"}, {"46010", "3gnet", "中国联通"},
        {"46003", "ctnet", "中国电信"}, {"46005", "ctnet", "中国电信"},
        {"46011", "ctnet", "中国电信"}, {"46012", "ctnet", "中国电信"},
    };
    for (size_t i = 0; i < sizeof(table) / sizeof(table[0]); ++i) {
        if (strncmp(mccmnc, table[i].mccmnc, 5) == 0) {
            ESP_LOGI(TAG, "IMSI前缀=%s → %s，APN=%s", mccmnc, table[i].carrier, table[i].apn);
            return table[i].apn;
        }
    }
    ESP_LOGW(TAG, "IMSI前缀=%s 不在已知运营商表里，APN 用默认值 %s", mccmnc, CONFIG_VOXMIND_APN);
    return CONFIG_VOXMIND_APN;
}

/* ML307C-GC 不在 esp_modem 命名支持的模组列表里（官方只列了 SIM800/BG96/SIM7600），
 * 但它遵循标准 3GPP AT 指令集，走 esp_modem_new() 的"通用模组"路径完全够用——
 * 这就是为什么下面调用的是 esp_modem_new() 而不是 esp_modem_new_dev()。
 *
 * 拨号前的 SIM/APN/注网检查复用现成的 drv_modem 原始 AT 通道；
 * 检查通过后 modem_release_uart_for_ppp() 交出串口，
 * 再由 esp_modem 的 DTE 在同一物理串口上接管，进入 PPP 数据模式。*/
static void time_synced(struct timeval *tv)
{
    ESP_LOGI(TAG, "SNTP 对时成功，开始上传");
    s_time_ok = true;
    modem_sleep_update();
}

static esp_err_t network_init(void)
{
    s_network_events = xEventGroupCreate();
    if (!s_network_events) return ESP_ERR_NO_MEM;
    ESP_RETURN_ON_ERROR(esp_netif_init(), TAG, "esp_netif_init");
    esp_err_t loop = esp_event_loop_create_default();
    if (loop != ESP_OK && loop != ESP_ERR_INVALID_STATE) return loop;
    ESP_RETURN_ON_ERROR(esp_event_handler_register(IP_EVENT, IP_EVENT_PPP_GOT_IP, ppp_ip_event, NULL), TAG, "ip got");
    ESP_RETURN_ON_ERROR(esp_event_handler_register(IP_EVENT, IP_EVENT_PPP_LOST_IP, ppp_ip_event, NULL), TAG, "ip lost");
    ESP_RETURN_ON_ERROR(esp_event_handler_register(NETIF_PPP_STATUS, ESP_EVENT_ANY_ID, ppp_status_event, NULL), TAG, "ppp status");

    ESP_RETURN_ON_ERROR(modem_init(), TAG, "modem_init");
    /* 实测 20260917：4G 冷启动第一次开机超时是真实可能发生的（模组自身启动
     * 抖动，或 PWRKEY 时序偶发没接住），【不能让它变成硬失败】——录音是这台
     * 设备唯一不可放弃的功能，联网失败只应该退回"本地录，稍后再联"，
     * 绝不能直接 abort() 整机重启死循环（旧版本这里用 ESP_RETURN_ON_ERROR
     * 直接把错误捅给调用方的 ESP_ERROR_CHECK，等于让一次开机抖动干掉整机）。*/
    esp_err_t power_err = ESP_FAIL;
    for (int attempt = 1; attempt <= 3; ++attempt) {
        power_err = modem_power_on(20000);
        if (power_err == ESP_OK) break;
        ESP_LOGW(TAG, "4G 开机第 %d/3 次尝试失败，强制关机后重试", attempt);
        modem_force_reset();
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
    if (power_err != ESP_OK) return power_err;

    /* 串口提速：升级慢的唯一瓶颈。上次试过没拨上号的话，这次老老实实用 115200。*/
    s_tried_fast_uart = false;
    if (fast_uart_allowed()) {
        if (modem_set_uart_baud(MODEM_FAST_BAUD) == ESP_OK) s_tried_fast_uart = true;
    } else {
        ESP_LOGW(TAG, "高速串口连续两次没拨上号，这次用 115200（成功拨号一次后清零）");
        /* 模组记得上次的 460800，开机探测是在高速上对上的：主动降回来，不然"用 115200"只是一句空话 */
        if (modem_uart_baud() != 115200) modem_set_uart_baud(115200);
    }
    vTaskDelay(pdMS_TO_TICKS(1500)); /* 开机刚完成，给 UART/AT 服务栈一点稳定时间 */

    char resp[160];
    modem_at("ATE0", "OK", NULL, 0, 1000); /* 关模组回显，免得干扰后面的匹配 */
    esp_err_t cpin_err = ESP_FAIL;
    for (int i = 0; i < 3; ++i) {
        cpin_err = modem_at("AT+CPIN?", "READY", resp, sizeof(resp), 3000);
        if (cpin_err == ESP_OK) break;
        vTaskDelay(pdMS_TO_TICKS(800));
    }
    if (cpin_err != ESP_OK)
        ESP_LOGW(TAG, "SIM 状态异常，继续尝试拨号: %.100s", resp);

    const char *apn = detect_apn(resp, sizeof(resp));
    char apn_cmd[64];
    snprintf(apn_cmd, sizeof(apn_cmd), "AT+CGDCONT=1,\"IP\",\"%s\"", apn);
    if (modem_at(apn_cmd, "OK", NULL, 0, 3000) != ESP_OK)
        ESP_LOGW(TAG, "设置 APN=%s 失败，继续尝试拨号", apn);
    bool registered = false;
    for (int i = 0; i < 15 && !registered; ++i) {
        if (modem_at("AT+CGREG?", "+CGREG: 0,1", resp, sizeof(resp), 2000) == ESP_OK ||
            modem_at("AT+CGREG?", "+CGREG: 0,5", resp, sizeof(resp), 2000) == ESP_OK) {
            registered = true; break;
        }
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
    if (!registered) ESP_LOGW(TAG, "30 秒内未确认注网成功，仍尝试拨号（可能天线/SIM 有问题）");

    /* 打开模组休眠（DTR 这时还是低，模组醒着；联网+对时后才放高让它睡）*/
    modem_at("AT&D0", "OK", NULL, 0, 1000);
    if (modem_at(MODEM_SLEEP_DEFAULT ? "AT+MLPMCFG=\"sleepmode\",2,0" : "AT+MLPMCFG=\"sleepmode\",0,0", "OK", NULL, 0, 2000) != ESP_OK)
        ESP_LOGW(TAG, "设置模组休眠失败，按不休眠跑");
    ESP_RETURN_ON_ERROR(modem_release_uart_for_ppp(), TAG, "release uart");

    esp_netif_config_t ppp_cfg = ESP_NETIF_DEFAULT_PPP();
    s_ppp_netif = esp_netif_new(&ppp_cfg);
    if (!s_ppp_netif) return ESP_ERR_NO_MEM;

    esp_modem_dte_config_t dte_config = ESP_MODEM_DTE_DEFAULT_CONFIG();
    dte_config.uart_config.baud_rate = modem_uart_baud();        /* 和上面提速后的一致 */
    /* 提速之后单位时间进来的字节多了好几倍，接收缓冲跟着放大，别在 CPU 忙的时候丢字节 */
    dte_config.uart_config.rx_buffer_size = 8192;
    dte_config.uart_config.tx_buffer_size = 2048;
    dte_config.uart_config.tx_io_num = PIN_MODEM_TX;
    dte_config.uart_config.rx_io_num = PIN_MODEM_RX;
    dte_config.uart_config.rts_io_num = -1;
    dte_config.uart_config.cts_io_num = -1;
    dte_config.uart_config.flow_control = ESP_MODEM_FLOW_CONTROL_NONE;

    esp_modem_dce_config_t dce_config = ESP_MODEM_DCE_DEFAULT_CONFIG(apn);
    s_dce = esp_modem_new(&dte_config, &dce_config, s_ppp_netif);
    if (!s_dce) return ESP_FAIL;

    ESP_RETURN_ON_ERROR(esp_modem_set_mode(s_dce, ESP_MODEM_MODE_DATA), TAG, "ppp dial");
    ESP_LOGI(TAG, "PPP 拨号命令已下发，等待 IP_EVENT_PPP_GOT_IP");

    /* 上传要等对时成功(TLS 证书校验依赖正确时间)，对时失败=整机永远传不上去。
     * 实测 20260918 有一次开机单独用 pool.ntp.org 始终没对上；换成国内多个源。*/
    esp_sntp_config_t sntp = ESP_NETIF_SNTP_DEFAULT_CONFIG_MULTIPLE(3,
        ESP_SNTP_SERVER_LIST("ntp.aliyun.com", "ntp.tencent.com", "cn.pool.ntp.org"));
    sntp.sync_cb = time_synced;
    return esp_netif_sntp_init(&sntp);
}

static void network_task(void *arg)
{
    esp_err_t err = network_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "本次开机联网失败(%s)，退回纯本地录音；重启设备可再次尝试",
                 esp_err_to_name(err));
        vTaskDelete(NULL);
        return;
    }
    /* 提速过就盯着：两分钟还没拿到 IP，说明这根线在高速下不可靠（板子上没有硬件流控）。
     * 记一笔，重启回到 115200——宁可升级慢，也不能把联网搞丢。*/
    if (s_tried_fast_uart) {
        EventBits_t bits = xEventGroupWaitBits(s_network_events, NET_READY_BIT, pdFALSE, pdTRUE, pdMS_TO_TICKS(120000));
        if (!(bits & NET_READY_BIT)) {
            ESP_LOGE(TAG, "高速串口两分钟没拨上号，退回 115200 并重启");
            runtime_diag_stop(DIAG_STOP_UART);
            save_fast_uart_allowed(false);   /* 失败计数 +1 */
            modem_force_reset();
            vTaskDelay(pdMS_TO_TICKS(1000));
            esp_restart();
        }
        ESP_LOGI(TAG, "高速串口拨号成功，升级下载会快很多");
        save_fast_uart_allowed(true);
    }
    vTaskDelete(NULL);
}

/* 高速串口是否还允许尝试。存 NVS 的是连续失败次数：
 * 以前失败一次就永远停在 115200（2026-10-03 发现一直是 115200，升级 4MB 要 10 分钟），
 * 可那次没拨上号也可能只是注网慢，跟波特率无关。现在连续失败两次才放弃，拨通一次就清零。*/
static uint8_t fast_uart_fails(void)
{
    uint8_t v = 0;
    nvs_handle_t nvs;
    if (nvs_open("voxmind", NVS_READONLY, &nvs) == ESP_OK) { nvs_get_u8(nvs, "uart_fails", &v); nvs_close(nvs); }
    return v;
}
static bool fast_uart_allowed(void) { return fast_uart_fails() < 2; }
static void save_fast_uart_allowed(bool ok)
{
    nvs_handle_t nvs;
    if (nvs_open("voxmind", NVS_READWRITE, &nvs) != ESP_OK) return;
    uint8_t fails = ok ? 0 : (uint8_t)(fast_uart_fails() + 1);
    nvs_set_u8(nvs, "uart_fails", fails);
    nvs_commit(nvs);
    nvs_close(nvs);
}

static void make_uuid(char output[37])
{
    uint8_t bytes[16];
    esp_fill_random(bytes, sizeof(bytes));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    snprintf(output, 37,
             "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
             bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
             bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]);
}

/* 每 30 秒一行运行状态 + 这 30 秒里各任务吃了多少 CPU。跑在录音所在的 CPU0，
 * 哪怕 CPU1 被联网任务占死也照样能报出来；8 小时耐力测试就靠它发现泄漏和霸核。*/
static void diag_task(void *arg)
{
    enum { MAX_TASKS = 40 };
    static TaskStatus_t now[MAX_TASKS];
    static struct { TaskHandle_t handle; configRUN_TIME_COUNTER_TYPE runtime; } prev[MAX_TASKS];
    static UBaseType_t prev_count;
    configRUN_TIME_COUNTER_TYPE prev_total = 0;
    uint32_t prev_captured = 0;
    TickType_t prev_tick = 0;
    unsigned cycle = 0;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(30000));
        /* 回滚保险：刚升上来的版本 10 分钟内一次心跳都没通，就重启——引导程序会退回上一版。
         * 以前只有"升级后起不来"才会回滚，"起得来但联不上网"会一直卡在新版本上，只能插线救 */
        /* 联网自检：自以为在线（拿到过 IP）却 5 分钟没连上过服务器，就重启——开机流程会重新探测、叫醒模组、重拨。
         * 2026-10-04 模组卡死后 4G=1 一直挂着、DNS 全失败，10 小时没恢复，重启一下就好了。录音都在卡里，不丢 */
        bool net_up = s_network_events && (xEventGroupGetBits(s_network_events) & NET_READY_BIT);
        if (net_up && !s_ota_running && s_net_ok_us && esp_timer_get_time() - s_net_ok_us > 5LL * 60 * 1000000) {
            ESP_LOGE(TAG, "已联网却 5 分钟连不上服务器，重启恢复网络");
            runtime_diag_stop(DIAG_STOP_NETWORK);
            /* ESP32 重启不会让模组断电：卡死的模组重启后还是卡死。改线 A 的板子先给它断一次电 */
            if (modem_supply_cut()) vTaskDelay(pdMS_TO_TICKS(1000));
            vTaskDelay(pdMS_TO_TICKS(200));
            esp_restart();
        }
        if (ota_pending_verify() && esp_timer_get_time() > 10LL * 60 * 1000000) {
            ESP_LOGE(TAG, "新固件 10 分钟没联上服务器，重启回到上一版");
            runtime_diag_stop(DIAG_STOP_ROLLBACK);
            vTaskDelay(pdMS_TO_TICKS(200));
            esp_restart();
        }
        configRUN_TIME_COUNTER_TYPE total = 0;
        char health[RUNTIME_DIAG_JSON_BYTES];
        if (runtime_diag_json(health, sizeof(health))) ESP_LOGI(TAG, "运行留痕 %s", health);
        UBaseType_t count = uxTaskGetSystemState(now, MAX_TASKS, &total);
        bool net = s_network_events && (xEventGroupGetBits(s_network_events) & NET_READY_BIT);
        uint32_t captured = s_captured_samples;
        uint32_t dropped = s_dropped_samples;
        TickType_t now_tick = xTaskGetTickCount();
        /* 采样率实测值：应当稳定在 16000；明显偏离说明时钟配置有问题 */
        unsigned rate = prev_tick ? (unsigned)((uint64_t)(captured - prev_captured) * configTICK_RATE_HZ / (now_tick - prev_tick)) : 0;
        prev_captured = captured;
        prev_tick = now_tick;
        size_t buffered = s_pcm_stream ? xStreamBufferBytesAvailable(s_pcm_stream) : 0;
        ESP_LOGI(TAG, "诊断: 录音 采样率=%u/s 累计丢失=%lums 缓冲=%ums 栈余量=%u | 4G=%d 已对时=%d 待传=%lu块 上传阶段=%s(%lus) | 内部RAM=%u(最低%u) PSRAM=%u",
                 rate, (unsigned long)(dropped * 1000ULL / AUDIO_SAMPLE_RATE),
                 (unsigned)(buffered * 1000 / (AUDIO_SAMPLE_RATE * sizeof(int16_t))),
                 s_main_task ? (unsigned)(uxTaskGetStackHighWaterMark(s_main_task) * sizeof(StackType_t)) : 0,
                 net, time(NULL) > 1700000000, (unsigned long)s_pending_chunks, s_upload_stage,
                 (unsigned long)((now_tick - s_upload_stage_tick) / configTICK_RATE_HZ),
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
        if (++cycle % 10 == 1) {
            uint64_t sd_total = 0, sd_free = 0;
            if (esp_vfs_fat_info(STORAGE_MOUNT_POINT, &sd_total, &sd_free) == ESP_OK)
                ESP_LOGI(TAG, "诊断: SD 剩余 %llu/%llu MB，约可再录 %llu 小时",
                         sd_free >> 20, sd_total >> 20,
                         sd_free / ((uint64_t)CONFIG_VOXMIND_OPUS_BITRATE / 8 * 3600));
        }
        configRUN_TIME_COUNTER_TYPE window = total - prev_total;
        if (prev_total && window) {
            char line[256];
            size_t used = 0;
            for (UBaseType_t i = 0; i < count; ++i) {
                configRUN_TIME_COUNTER_TYPE before = 0;
                for (UBaseType_t j = 0; j < prev_count; ++j) {
                    if (prev[j].handle == now[i].xHandle) { before = prev[j].runtime; break; }
                }
                unsigned pct = (unsigned)((uint64_t)(now[i].ulRunTimeCounter - before) * 100 / window);
                if (pct >= 3 && used < sizeof(line) - 32)
                    used += snprintf(line + used, sizeof(line) - used, " %s=%u%%", now[i].pcTaskName, pct);
            }
            ESP_LOGI(TAG, "诊断: 近30秒CPU(单核%%):%s", used ? line : " 无");
        }
        for (UBaseType_t i = 0; i < count; ++i) {
            prev[i].handle = now[i].xHandle;
            prev[i].runtime = now[i].ulRunTimeCounter;
        }
        prev_count = count;
        prev_total = total;
    }
}

static bool network_ready(void)
{
    return s_network_events && (xEventGroupGetBits(s_network_events) & NET_READY_BIT) && time(NULL) > 1700000000;
}

static esp_http_client_handle_t http_client(const char *url, http_response_t *response)
{
    esp_http_client_config_t config = {
        .url = url,
        .event_handler = http_event,
        .user_data = response,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .timeout_ms = 20000,
        .buffer_size = 1024,
        .buffer_size_tx = 4096,
    };
    return esp_http_client_init(&config);
}

/* 每个联网任务各自持有一条长连接复用。S3 没有 ECC 硬件加速，一次 TLS 握手
 * 要吃掉几秒 CPU；以前每个 5 秒音频块、每次 1.2 秒一轮的卡片轮询都新握手一次，
 * CPU、电量和 4G 流量的大头都花在握手上（实测还把 CPU1 连续占满 5 秒以上）。*/
typedef struct {
    esp_http_client_handle_t handle;
    http_response_t response;
} api_conn_t;

static api_conn_t s_upload_conn;
static api_conn_t s_action_conn;

static void api_close(api_conn_t *conn)
{
    if (conn->handle) {
        esp_http_client_cleanup(conn->handle);
        conn->handle = NULL;
    }
}

static void set_or_delete_header(esp_http_client_handle_t handle, const char *key, const char *value)
{
    if (value) esp_http_client_set_header(handle, key, value);
    else esp_http_client_delete_header(handle, key);
}

/* 返回 HTTP 状态码；传输层失败返回 -1。连接失效（比如 4G 运营商 NAT 把空闲
 * 连接回收了）时自动重建一次。*/
/* ── 4G 模组休眠 ────────────────────────────────────────────────
 * ML307C 出厂 sleepmode=0，从来不睡。开机时设成 AT+MLPMCFG="sleepmode",2,0 + AT&D0：
 * DTR 高＝允许睡、DTR 低＝叫醒（&D0 让 DTR 只管休眠，不再被当成挂断）。睡着时它收不到我们发的
 * 串口数据，所以每次联网请求前拉低 DTR、做完再放高；下行数据会自己把它叫醒。
 * 只在「已联网且已对时」时才允许睡：拨号、重拨、对时都是我们主动发数据，睡着会丢。
 * 2026-10-03 拔线实测：黑屏录音 106~112 → 80~93mA，暂停 67~79 → 40~50mA；休眠期间 33 块录音一块不落。*/
static volatile bool s_modem_sleep;          /* 当前是否允许模组睡（DTR 空闲时放高） */
static volatile bool s_modem_sleep_off;      /* 实验/串口临时禁用 */
static int s_dtr_users;
static portMUX_TYPE s_dtr_mux = portMUX_INITIALIZER_UNLOCKED;
static void dtr_apply(void)
{
    portENTER_CRITICAL(&s_dtr_mux);
    int level = s_modem_sleep && s_dtr_users == 0 ? 1 : 0;
    portEXIT_CRITICAL(&s_dtr_mux);
    gpio_set_level(PIN_MODEM_DTR, level);
}
static void modem_sleep_update(void)
{
    bool net = s_network_events && (xEventGroupGetBits(s_network_events) & NET_READY_BIT);
    bool want = MODEM_SLEEP_DEFAULT && !s_modem_sleep_off && net && s_time_ok;
    if (want != s_modem_sleep) { s_modem_sleep = want; ESP_LOGI(TAG, "4G 模组%s", want ? "空闲时休眠" : "保持唤醒"); }
    dtr_apply();
}
static void modem_wake_begin(void)
{
    portENTER_CRITICAL(&s_dtr_mux);
    bool first = s_dtr_users++ == 0;
    portEXIT_CRITICAL(&s_dtr_mux);
    if (first && s_modem_sleep) { gpio_set_level(PIN_MODEM_DTR, 0); vTaskDelay(pdMS_TO_TICKS(60)); }
}
static void modem_wake_end(void)
{
    portENTER_CRITICAL(&s_dtr_mux);
    --s_dtr_users;
    portEXIT_CRITICAL(&s_dtr_mux);
    dtr_apply();
}

static int api_request(api_conn_t *conn, esp_http_client_method_t method, const char *path,
                       const char *content_type, const char *body, size_t body_len,
                       const char *sha256, const char *duration_ms, const char *start_ms)
{
    char url[320];
    snprintf(url, sizeof(url), "%s%s", CONFIG_VOXMIND_API_BASE_URL, path);
    if (!conn->response.data) {
        conn->response.data = heap_caps_malloc(VOXMIND_HTTP_RESPONSE_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (!conn->response.data) conn->response.data = malloc(VOXMIND_HTTP_RESPONSE_BYTES);
        if (!conn->response.data) { ESP_LOGE(TAG, "HTTP响应缓冲分配失败"); return -1; }
        conn->response.capacity = VOXMIND_HTTP_RESPONSE_BYTES;
    }
    /* A lost confirmation response can follow a successful physical action. */
    bool confirm = method == HTTP_METHOD_POST && strstr(path, "/confirm") != NULL;
    for (int attempt = 0; attempt < (confirm ? 1 : 2); ++attempt) {
        if (!conn->handle) {
            conn->handle = http_client(url, &conn->response);
            if (!conn->handle) return -1;
            esp_http_client_set_header(conn->handle, "x-device-key", s_device_key);
            esp_http_client_set_header(conn->handle, "x-voxmind-protocol", "2");
        } else {
            esp_http_client_set_url(conn->handle, url);
        }
        voxmind_response_reset(&conn->response);
        esp_http_client_set_method(conn->handle, method);
        set_or_delete_header(conn->handle, "content-type", content_type);
        set_or_delete_header(conn->handle, "x-content-sha256", sha256);
        set_or_delete_header(conn->handle, "x-duration-ms", duration_ms);
        set_or_delete_header(conn->handle, "x-start-ms", start_ms);
        esp_http_client_set_post_field(conn->handle, body, (int)body_len);
        int64_t request_started = esp_timer_get_time();
        runtime_diag_note(DIAG_HTTP_BEGIN, conn == &s_upload_conn ? 1 : 2);
        modem_wake_begin();
        esp_err_t err = esp_http_client_perform(conn->handle);
        modem_wake_end();
        int elapsed_ms = (int)((esp_timer_get_time() - request_started) / 1000);
        runtime_diag_note(DIAG_HTTP_END, err == ESP_OK ? esp_http_client_get_status_code(conn->handle) : -1);
        if (body_len || elapsed_ms > 3000)
            ESP_LOGI(TAG, "HTTP计时 channel=%s method=%d bytes=%u elapsed_ms=%d status=%d attempt=%d",
                conn == &s_upload_conn ? "audio" : "action", (int)method, (unsigned)body_len,
                elapsed_ms, err == ESP_OK ? esp_http_client_get_status_code(conn->handle) : -1, attempt + 1);
        if (conn->response.overflow) {
            ESP_LOGW(TAG, "响应超出%u字节，保留上一份有效状态", (unsigned)conn->response.capacity - 1);
            api_close(conn);
            return -2;
        }
        if (err == ESP_OK) { s_net_ok_us = esp_timer_get_time(); return esp_http_client_get_status_code(conn->handle); }
        ESP_LOGW(TAG, "请求 %s 传输失败(%s)，重建连接", path, esp_err_to_name(err));
        api_close(conn);
    }
    return -1;
}

static char s_ensured_session[37];

static bool ensure_cloud_session(const char *session_id)
{
    if (strcmp(s_ensured_session, session_id) == 0) return true;
    char json[320], boot[13], started[32], extra[96] = "";
    session_meta_load(session_id, boot, started);
    if (boot[0]) snprintf(extra, sizeof(extra), ",\"bootId\":\"%s\"", boot);
    if (started[0]) snprintf(extra + strlen(extra), sizeof(extra) - strlen(extra), ",\"startedAt\":\"%s\"", started);
    snprintf(json, sizeof(json), "{\"sessionId\":\"%s\",\"deviceId\":\"%s\",\"userId\":\"owner\"%s}", session_id, CONFIG_VOXMIND_DEVICE_ID, extra);
    int status = api_request(&s_upload_conn, HTTP_METHOD_POST, "/v1/device-sessions", "application/json",
                             json, strlen(json), NULL, NULL, NULL);
    if (status != 200 && status != 201) {
        ESP_LOGW(TAG, "创建云会话失败 http=%d %.120s", status, s_upload_conn.response.data);
        return false;
    }
    strlcpy(s_ensured_session, session_id, sizeof(s_ensured_session));
    return true;
}

static bool read_file(const char *path, uint8_t **out, size_t *out_size)
{
    FILE *file = fopen(path, "rb");
    if (!file) return false;
    if (fseek(file, 0, SEEK_END) || (*out_size = (size_t)ftell(file)) == 0 || fseek(file, 0, SEEK_SET)) {
        fclose(file); return false;
    }
    *out = heap_caps_malloc(*out_size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!*out) *out = malloc(*out_size);
    bool ok = *out && fread(*out, 1, *out_size, file) == *out_size;
    fclose(file);
    if (!ok) { free(*out); *out = NULL; }
    return ok;
}

static void sha256_hex(const uint8_t *data, size_t size, char output[65])
{
    uint8_t digest[32];
    mbedtls_sha256(data, size, digest, 0);
    for (size_t i = 0; i < sizeof(digest); ++i) snprintf(output + i * 2, 3, "%02x", digest[i]);
}

/* 返回 HTTP 状态码；本地读文件失败返回 0，传输失败返回 -1。*/
static int upload_chunk(const char *session_id, unsigned sequence, const char *path, const char *content_type)
{
    uint8_t *body = NULL; size_t body_size = 0;
    upload_stage("读文件");
    if (!read_file(path, &body, &body_size)) {
        ESP_LOGW(TAG, "读待传文件失败 %s", path);
        return 0;
    }
    upload_stage("上传中");
    char hash[65], path_buf[160], duration[16], start[24];
    sha256_hex(body, body_size, hash);
    snprintf(path_buf, sizeof(path_buf), "/v1/device-sessions/%s/chunks/%u", session_id, sequence);
    uint32_t start_ms, dur_ms;
    chunk_timing_load(session_id, sequence, &start_ms, &dur_ms);
    snprintf(duration, sizeof(duration), "%lu", (unsigned long)dur_ms);
    snprintf(start, sizeof(start), "%lu", (unsigned long)start_ms);
    int status = api_request(&s_upload_conn, HTTP_METHOD_PUT, path_buf, content_type,
                             (const char *)body, body_size, hash, duration, start);
    free(body);
    if (status != 200 && status != 201) {
        ESP_LOGW(TAG, "上传失败 seq=%u http=%d %.120s", sequence, status, s_upload_conn.response.data);
        return status;
    }
    ESP_LOGI(TAG, "云端已持久化 seq=%u %s bytes=%u", sequence, content_type, (unsigned)body_size);
    return status;
}

static bool post_device_action(const char *action_id, const char *verb, const char **message)
{
    char path_buf[128];
    snprintf(path_buf, sizeof(path_buf), "/v1/device-actions/%.36s/%s", action_id, verb);
    int status = api_request(&s_action_conn, HTTP_METHOD_POST, path_buf, NULL, NULL, 0, NULL, NULL, NULL);
    if (status != 200) {
        ESP_LOGW(TAG, "卡片%s失败 http=%d", verb, status);
        *message = status < 0 && strcmp(verb, "confirm") == 0 ? "结果待同步，请勿重复操作" : "操作未完成，请刷新后重试";
        return false;
    }
    cJSON *root = cJSON_Parse(s_action_conn.response.data);
    const cJSON *draft = cJSON_GetObjectItem(root, "draft");
    const char *state = cJSON_GetStringValue(cJSON_GetObjectItem(draft, "status"));
    bool ok = state && (strcmp(state, "executed") == 0 || strcmp(state, "executing") == 0 ||
                       strcmp(state, "confirmed") == 0 || strcmp(state, "cancelled") == 0);
    *message = !ok ? "操作结果待同步" : strcmp(state, "executed") == 0 ? "执行完成，查看回执" :
               strcmp(state, "cancelled") == 0 ? "已取消" : "已确认，正在执行";
    cJSON_Delete(root);
    return ok;
}

/* 深睡时 3.3V 还开着（TPS63802 的使能脚直接接在电源上，关不掉），外设都还通着电。
 * 没人驱动的脚会悬空：WS2812 的数据线乱跳可能把灯点亮，触摸/屏幕的复位脚一飘低就把
 * 刚睡下的芯片复位叫醒，麦克风时钟、SD 片选悬空时电平转换和存储芯片会多耗电。
 * 全部钉成确定的"不工作"电平。开机时各驱动初始化前会先 gpio_hold_dis。*/
static void sleep_hold_pins(void)
{
    static const struct { int pin; int level; } pins[] = {
        { PIN_LED_DATA, 0 }, { PIN_TP_RST, 1 }, { PIN_LCD_RST, 1 }, { PIN_LCD_CS, 1 },
        { PIN_SD_CS, 1 }, { PIN_MIC_CLK, 0 }, { PIN_MOTOR_PWM, 0 },
    };
    for (size_t i = 0; i < sizeof(pins) / sizeof(pins[0]); ++i) {
        gpio_reset_pin(pins[i].pin);
        gpio_set_direction(pins[i].pin, GPIO_MODE_OUTPUT);
        gpio_set_level(pins[i].pin, pins[i].level);
        gpio_hold_en(pins[i].pin);
    }
}

/* 真关机：深睡眠，整机只剩 RTC 域，长按录音键(GPIO3)开机——docs/20 §10 要求的
 * "物理停止方式"。开了定时开关机的，同时设一个计时器到点自己醒。
 * 板子上没有 32.768kHz 计时晶振（那两个脚给了 4G 串口），睡眠计时靠芯片内部振荡器，
 * 睡十个小时可能差几分钟：所以按 1% 提前量（至少 1 分钟）早醒，宁早勿晚。*/
static bool s_modem_cut_at_off;   /* 软关机里再进深睡时不知道，按 false 记 */
static void enter_deep_sleep(void)
{
    power_record_before_off(s_modem_cut_at_off);
    s_soft_off_flag = 0;                 /* 深睡眠醒来一律正常开机 */
    /* 不能只把背光调到 0：深睡眠时 LEDC 停了，背光脚被模组上拉点亮，屏上停着最后一帧还一直耗电 */
    if (s_display_ready) ui_prepare_sleep(); else display_power_down();
    display_touch_sleep(true);           /* 触摸芯片深睡约 5µA；不睡它整晚都在扫描 */
    sleep_hold_pins();
    input_arm_wakeup();
    if (s_cfg.schedule_enabled && time(NULL) > 1700000000) {
        int64_t sleep_s = seconds_until(s_cfg.on_min);
        int64_t early = sleep_s / 100 > 60 ? sleep_s / 100 : 60;
        if (sleep_s > early + 30) sleep_s -= early;
        esp_sleep_enable_timer_wakeup((uint64_t)sleep_s * 1000000ULL);
        ESP_LOGW(TAG, "定时开机：约 %lld 分钟后醒来", (long long)(sleep_s / 60));
    }
    /* 长按关机时手往往还没松开。唤醒条件正是"录音键按下"，按着就睡下去会被立刻唤醒、
     * 又开机了。所以等松手再睡；按满 5 秒还没松，就当是要开机，照睡（醒来就开机）。*/
    for (int i = 0; i < 100 && gpio_get_level(PIN_BTN_REC) == 0; ++i) vTaskDelay(pdMS_TO_TICKS(50));
    ESP_LOGW(TAG, "进入深睡眠");
    vTaskDelay(pdMS_TO_TICKS(100));
    gpio_deep_sleep_hold_en();           /* 非 RTC 脚（GPIO46/47/48 等）的保持在深睡里也生效 */
    esp_deep_sleep_start();
}

/* 先把当前这一块录完存好，再断 4G。soft=true 进软关机（重启进听指令模式），否则真关机。*/
/* 关机前关掉 4G 射频。
 *
 * 实测 2026-10-02：模组电源键这条路关不掉它——按 1.5 秒、按住 12.5 秒，STATUS 都不掉；从关机里
 * 冷启动时模组也一直开着，而且还卡在上次的拨号（数据）模式里不应答，开机要白等十几秒。
 * 不直接用 AT 指令把模组彻底关机：电源键如果真的不管用，彻底关掉就再也开不起来了，只能拆电池。
 * 关射频（AT+CFUN=0）是标准指令、可逆，射频是模组最耗电的部分；开机时 radio_on() 再打开。
 * 先退出拨号回到指令模式，下次开机模组一问就答，不用再等。*/
/* 经 esp_modem 发一条 AT，把原始回复和耗时都打出来（关射频失败过一次，光说"失败"查不出原因）*/
static char s_at_reply[160];
static esp_err_t at_line_cb(uint8_t *data, size_t len)
{
    size_t have = strlen(s_at_reply);
    for (size_t i = 0; i < len && have + 1 < sizeof(s_at_reply); ++i)
        s_at_reply[have++] = (data[i] == '\r' || data[i] == '\n') ? ' ' : (char)data[i];
    s_at_reply[have] = '\0';
    if (strstr(s_at_reply, "OK")) return ESP_OK;
    if (strstr(s_at_reply, "ERROR")) return ESP_FAIL;
    return ESP_ERR_TIMEOUT;                 /* 还没等到结果，接着等 */
}

static esp_err_t at_cmd(const char *cmd, uint32_t timeout_ms)
{
    char line[48];
    snprintf(line, sizeof(line), "%s\r", cmd);
    s_at_reply[0] = '\0';
    int64_t t0 = esp_timer_get_time();
    esp_err_t r = esp_modem_command(s_dce, line, at_line_cb, timeout_ms);
    ESP_LOGW(TAG, "AT %-10s → %s，%lld ms，回复：%s", cmd, r == ESP_OK ? "OK" : r == ESP_FAIL ? "ERROR" : esp_err_to_name(r),
             (esp_timer_get_time() - t0) / 1000, s_at_reply);
    return r;
}

/* 关机前关掉 4G 射频。
 *
 * 实测 2026-10-02：模组电源键关不掉它（按 1.5 秒、按住 12.5 秒 STATUS 都不掉，冷启动时它也一直开着）。
 * 不直接用 AT 把模组彻底关机：电源键如果真不管用，彻底关掉就再也开不起来，只能拆电池。
 * 关射频（AT+CFUN=0）是标准指令、可逆，射频是最耗电的部分；开机 radio_on() 再打开。
 * 开机探测过：模组支持 CFUN 0/1/4/5，指令模式下 CFUN=0 半秒就回 OK。连着网时要先跟基站断开，
 * 可能慢得多，所以给足 20 秒；万一不认，退一步用 4（飞行模式，同样关射频）。
 * 先退出拨号回到指令模式，下次开机模组一问就答，不用再被强制按 12 秒重启。*/
static bool s_radio_off;
static void modem_radio_off(void)
{
    if (!s_dce) { ESP_LOGW(TAG, "关射频：本次没拨过号，跳过"); return; }
    modem_wake_begin();                  /* 模组可能睡着：先叫醒，不然下面的 AT 全丢 */
    int64_t t0 = esp_timer_get_time();
    esp_err_t mode = esp_modem_set_mode(s_dce, ESP_MODEM_MODE_COMMAND);
    ESP_LOGW(TAG, "退出拨号%s，%lld ms", mode == ESP_OK ? "成功" : "失败", (esp_timer_get_time() - t0) / 1000);
    /* esp_modem 10 毫秒就报"已退出拨号"，模组其实还没切回来：实测紧跟着的第一条指令 20 秒没有
     * 任何回复，第二条才正常。先用最简单的 AT 握手，等它真回话了再发正事 */
    for (int i = 0; i < 6 && at_cmd("AT", 1000) != ESP_OK; ++i) {}
    if (at_cmd("AT+CFUN=0", 10000) != ESP_OK) at_cmd("AT+CFUN=4", 10000);
    at_cmd("AT+CFUN?", 3000);
    s_radio_off = true;
    modem_wake_end();
}

/* 拨号中临时切回指令模式发几条 AT，再拨回去（和关射频、耗电实验恢复同一套做法）。
 * 切换期间别的联网请求会失败、自己重试。*/
static void modem_at_session(const char *const *cmds, int n)
{
    if (!s_dce) { ESP_LOGW(TAG, "AT：没有拨过号"); return; }
    modem_wake_begin();
    esp_modem_set_mode(s_dce, ESP_MODEM_MODE_COMMAND);
    for (int i = 0; i < 6 && at_cmd("AT", 1000) != ESP_OK; ++i) {}
    for (int i = 0; i < n; ++i) at_cmd(cmds[i], 5000);
    esp_err_t e = esp_modem_set_mode(s_dce, ESP_MODEM_MODE_DATA);
    ESP_LOGW(TAG, "AT：回到拨号%s", e == ESP_OK ? "" : "失败");
    modem_wake_end();
}

/* 串口 / 耗电实验用：临时禁用或恢复模组休眠（不用切指令模式：模组那边一直是 sleepmode=2，
 * 只要 DTR 一直低它就不睡）*/
static void modem_set_sleep(bool on)
{
    s_modem_sleep_off = !on;
    modem_sleep_update();
    ESP_LOGW(TAG, "4G 模组休眠：%s", on ? "允许" : "禁用");
}

/* ── 耗电测量 ─────────────────────────────────────────────────
 * 用户反馈：开机耗电很快，黑屏、暂停时也一样。为了把每一项单独量出来：设备脱离 USB，按阶段
 * 依次关掉一个耗电项，每段 8 分钟，每 15 秒记一次电池电压、电量、放电速率（MAX17048 的 CRATE，
 * %/小时，乘电池容量就是平均电流）。相邻两段的差＝被关掉那一项的耗电。跑完恢复原状、整份上传。
 * 插着 USB 是在充电，测不出放电，所以必须拔线跑。实验期间屏幕不许点亮（提醒、卡片都不亮）。*/
static const struct { const char *id, *label; } POWER_PHASES[] = {
    {"A", "录音中、黑屏（日常）"},
    {"B", "暂停录音、黑屏"},
    {"E", "A 但 4G 模组不休眠"},
    {"F", "B 但 4G 模组不休眠"},
    {"D", "B + 4G 射频关"},
    /* 原来还有 C（轮询放慢到 60 秒，2026-10-03 测得只省约 10mA）、E（CPU 动态调频）、
     * F（面板睡眠 + 关麦克风）：后两项 2026-10-02 起成了默认行为 */
};
#define POWER_PHASE_N (sizeof(POWER_PHASES) / sizeof(POWER_PHASES[0]))
static int32_t (*s_power_samples)[5];            /* [秒, 阶段, mV, 电量×100, 放电速率×100] */
static int s_power_n;
static uint32_t s_power_bounds[POWER_PHASE_N][2];
static volatile bool s_power_running, s_power_ready;
static size_t s_power_phase_count = POWER_PHASE_N;

static void power_apply(int phase)
{
    switch (phase) {
    case 0: s_paused = false; s_poll_override_ms = 0; break;
    case 1: s_paused = true; break;
    case 2: s_paused = false; modem_set_sleep(false); break;
    case 3: s_paused = true; break;
    case 4: modem_set_sleep(true); modem_radio_off(); break;
    }
}

static void power_restore(bool was_paused)
{
    /* 只有关过射频才要重开、重拨（以前两段实验也会在拨号状态下发 AT，白白断一次网） */
    if (s_dce && s_radio_off) {
        modem_wake_begin();
        for (int i = 0; i < 6 && at_cmd("AT", 1000) != ESP_OK; ++i) {}
        at_cmd("AT+CFUN=1", 20000);
        esp_modem_set_mode(s_dce, ESP_MODEM_MODE_DATA);
        s_radio_off = false;
        modem_wake_end();
    }
    modem_set_sleep(true);
    s_poll_override_ms = 0;
    s_paused = was_paused;
    if (s_display_ready) ui_set_wake_inhibit(false);
}

static void power_profile_task(void *arg)
{
    uint32_t phase_s = (uint32_t)(uintptr_t)arg;
    bool was_paused = s_paused;
    if (!s_power_samples) s_power_samples = heap_caps_calloc(800, sizeof(*s_power_samples), MALLOC_CAP_SPIRAM);
    s_power_n = 0;
    s_power_ready = false;
    if (s_display_ready) { ui_set_wake_inhibit(true); ui_sleep_now(); }
    ESP_LOGW(TAG, "耗电测量开始：%u 段，每段 %lu 秒", (unsigned)POWER_PHASE_N, (unsigned long)phase_s);
    TickType_t t0 = xTaskGetTickCount();
    for (int ph = 0; ph < (int)s_power_phase_count; ++ph) {
        power_apply(ph);
        uint32_t from = (uint32_t)((xTaskGetTickCount() - t0) / configTICK_RATE_HZ);
        s_power_bounds[ph][0] = from;
        ESP_LOGW(TAG, "耗电测量：第 %s 段 %s", POWER_PHASES[ph].id, POWER_PHASES[ph].label);
        while ((xTaskGetTickCount() - t0) / configTICK_RATE_HZ < from + phase_s) {
            vTaskDelay(pdMS_TO_TICKS(15000));
            power_status_t b;
            if (power_read(&b) != ESP_OK || s_power_n >= 800) continue;
            int32_t *row = s_power_samples[s_power_n++];
            row[0] = (int32_t)((xTaskGetTickCount() - t0) / configTICK_RATE_HZ);
            row[1] = ph;
            row[2] = (int32_t)(b.voltage_v * 1000.0f + 0.5f);
            row[3] = (int32_t)(b.soc_pct * 100.0f);
            row[4] = (int32_t)(b.crate_pct_h * 100.0f);
            ESP_LOGI(TAG, "耗电 %s t=%lds %ldmV 电量%.2f%% 速率%.2f%%/h", POWER_PHASES[ph].id, (long)row[0], (long)row[2],
                     b.soc_pct, b.crate_pct_h);
        }
        s_power_bounds[ph][1] = (uint32_t)((xTaskGetTickCount() - t0) / configTICK_RATE_HZ);
    }
    power_restore(was_paused);
    ESP_LOGW(TAG, "耗电测量结束：%d 个样本，等联网上传", s_power_n);
    s_power_ready = true;                       /* 卡片任务联网后上传（它管着那条连接） */
    s_power_running = false;
    vTaskDelete(NULL);
}

static void power_profile_start(uint32_t phase_s, size_t phases)
{
    if (s_power_running) { ESP_LOGW(TAG, "耗电测量已经在跑"); return; }
    s_power_phase_count = phases && phases <= POWER_PHASE_N ? phases : POWER_PHASE_N;
    s_power_running = true;
    xTaskCreatePinnedToCore(power_profile_task, "voxmind_power_exp", 4096, (void *)(uintptr_t)phase_s, 3, NULL, 1);
}

/* 在卡片任务里调：它管着 s_action_conn，别的任务不能并发用这条连接 */
static void power_log_upload(void)
{
    if (!s_power_ready || !network_ready()) return;
    size_t cap = 512 + (size_t)s_power_n * 48;
    char *body = heap_caps_malloc(cap, MALLOC_CAP_SPIRAM);
    if (!body) return;
    int n = snprintf(body, cap, "{\"phases\":[");
    for (size_t i = 0; i < s_power_phase_count; ++i)
        n += snprintf(body + n, cap - n, "%s{\"id\":\"%s\",\"label\":\"%s\",\"fromS\":%lu,\"toS\":%lu}", i ? "," : "",
                      POWER_PHASES[i].id, POWER_PHASES[i].label, (unsigned long)s_power_bounds[i][0], (unsigned long)s_power_bounds[i][1]);
    n += snprintf(body + n, cap - n, "],\"samples\":[");
    for (int i = 0; i < s_power_n && n < (int)cap - 64; ++i)
        n += snprintf(body + n, cap - n, "%s[%ld,%ld,%ld,%ld,%ld]", i ? "," : "", (long)s_power_samples[i][0],
                      (long)s_power_samples[i][1], (long)s_power_samples[i][2], (long)s_power_samples[i][3], (long)s_power_samples[i][4]);
    n += snprintf(body + n, cap - n, "]}");
    int st = api_request(&s_action_conn, HTTP_METHOD_POST, "/v1/device-power-log", "application/json", body, n, NULL, NULL, NULL);
    free(body);
    ESP_LOGW(TAG, "耗电测量上传 http=%d（%d 个样本）", st, s_power_n);
    if (st == 200) s_power_ready = false;
}

/* 关机：先让人看到"关了"，收尾在黑屏之后做。
 *
 * 以前是 正在关机 → 等这一块录满（最多 5 秒）→ 关 4G（按 1.5 秒电源键再等它断电，最多 10 秒）
 * → "已关机"停 1.2 秒，长按之后要盯着屏幕等十几秒。现在真关机一按到：屏幕立刻黑、
 * 灯灭、振两下；当前这块录到哪存到哪（零点几秒）；关 4G 在黑屏里做完再睡。
 * 软关机是重启进听指令模式，很快，照旧显示一句。*/
static void power_off(const char *reason, bool soft)
{
    if (s_shutdown_requested) return;
    runtime_diag_stop(strcmp(reason, "长按录音键") == 0 ? DIAG_STOP_KEY :
        strcmp(reason, "定时关机") == 0 ? DIAG_STOP_SCHEDULE :
        strcmp(reason, "语音「关机」") == 0 ? DIAG_STOP_VOICE :
        strcmp(reason, "电量耗尽") == 0 ? DIAG_STOP_BATTERY : DIAG_STOP_REMOTE);
    int64_t t0 = esp_timer_get_time();
    ESP_LOGW(TAG, "收到%s请求(%s)", soft ? "软关机" : "关机", reason);
    s_shutdown_requested = true;            /* 录音循环看到它，当前这块就地收尾 */
    if (soft) {
        ui_show_message("正在软关机", "先把最后一段录音存好…");
    } else {
        if (s_display_ready) ui_prepare_sleep(); else display_power_down();
        led_set(LED_OFF);
        motor_buzz(60, 2);                  /* 屏已经黑了，靠振动告诉人"关了" */
    }
    if (s_recorder_stopped) xSemaphoreTake(s_recorder_stopped, pdMS_TO_TICKS(5000));
    int64_t t1 = esp_timer_get_time();
    led_set(LED_OFF);
    modem_radio_off();
    /* 改线 A 的板子：射频关完再整个断电，关机期间 4G 一点电都不耗。没改线的板子这一步无效，
     * 模组仍以关射频的状态挂在电池上 */
    s_modem_cut_at_off = modem_supply_cut();
    modem_prepare_sleep();
    ESP_LOGW(TAG, "关机收尾：录音存好用 %lld ms，关 4G 用 %lld ms，还有 %lu 段下次开机补传",
             (t1 - t0) / 1000, (esp_timer_get_time() - t1) / 1000, (unsigned long)s_pending_chunks);
    if (soft) {
        s_soft_off_flag = SOFT_OFF_MAGIC;
        esp_restart();
    }
    enter_deep_sleep();
}

static void shutdown_device(const char *reason) { power_off(reason, false); }

/* 实体三键：长按录音键关机；OK/BACK 等价于屏幕上的确认/取消。*/
static void button_task(void *arg)
{
    QueueHandle_t events = xQueueCreate(8, sizeof(btn_event_t));
    s_btn_events = events;
    if (!events || input_init(events) != ESP_OK) {
        ESP_LOGW(TAG, "实体按键不可用，只能用触摸屏");
        vTaskDelete(NULL);
        return;
    }
    /* 确认键这一次按下归谁，在"按下"那一刻就定下来：
     * 驱动对一次按键依次发 按下→松开→单击（按久了是长按）。以前"收下提醒"只认单击，
     * 而"按下"先被下面的「在听」接走——屏上闪一下"在听"盖住提醒；按得稍久，
     * 前后几秒的话还会被当成指令送去分析，而且最后来的是长按不是单击，提醒根本没收下。
     * 现在按下时屏上有提醒，这一整次就归提醒：按下、松开都吞掉，单击或长按都算"知道了"。*/
    enum { OK_FREE, OK_REMINDER, OK_OTHER } ok_owner = OK_FREE;
    for (;;) {
        btn_event_t ev;
        /* 「在听」时每 100ms 看一眼确认键是不是真的还按着：松手的事件万一被触点弹跳吃掉，
         * 也要在 0.2 秒内结束，不能一直停在「在听」 */
        static uint8_t up_seen;
        if (xQueueReceive(events, &ev, s_talk_down_tick ? pdMS_TO_TICKS(100) : portMAX_DELAY) != pdTRUE) {
            if (!s_talk_down_tick || input_is_down(BTN_OK_E)) { up_seen = 0; continue; }
            if (++up_seen < 2) continue;
            up_seen = 0;
            ESP_LOGW(TAG, "确认键已经松开但没收到松手事件，补一个");
            ev = (btn_event_t){ .id = BTN_OK_E, .type = BTN_EV_UP,
                                .held_ms = pdTICKS_TO_MS(xTaskGetTickCount() - s_talk_down_tick) };
        }
        if (ev.id == BTN_REC_E && ev.type == BTN_EV_LONG) {
            if (s_soft_off_flag == SOFT_OFF_MAGIC) { runtime_diag_stop(DIAG_STOP_KEY); enter_deep_sleep(); }
            /* 长按是真关机还是软关机，后台「设备」里设；默认真关机 */
            power_off("长按录音键", s_cfg.power_key_soft);
            continue;
        }
        if (s_soft_off_flag == SOFT_OFF_MAGIC) {
            if (ev.type == BTN_EV_CLICK && ev.id == BTN_REC_E) { runtime_diag_stop(DIAG_STOP_WAKE); s_soft_off_flag = 0; esp_restart(); }
            if (ev.type == BTN_EV_CLICK) s_soft_screen_until = xTaskGetTickCount() + pdMS_TO_TICKS(8000);
            continue;
        }
        /* 屏上有到点提醒时，确认键用来收下它——这时候按键的本意肯定是"知道了" */
        if (ev.id == BTN_OK_E) {
            if (ev.type == BTN_EV_DOWN) ok_owner = s_reminder_id[0] ? OK_REMINDER : OK_OTHER;
            bool ends = ev.type == BTN_EV_CLICK || ev.type == BTN_EV_LONG;
            /* OK_FREE 是兜底：万一没收到"按下"（比如驱动丢了），单击时屏上有提醒也照样收下 */
            bool mine = ok_owner == OK_REMINDER || (ok_owner == OK_FREE && ends && s_reminder_id[0]);
            if (ends) ok_owner = OK_FREE;
            if (mine) {
                if (ends && s_reminder_id[0]) {
                    if (!ui_action_requested("", "ack_reminder")) {
                        if (s_display_ready) ui_toast("操作繁忙，请稍后重试");
                        continue;
                    }
                    /* 先收起再去网上报：4G 一来一回要一两秒，按了没反应会让人再按一次。
                     * 万一没报上去，下次轮询服务器还会推它，屏上会再出来，不会丢 */
                    if (s_display_ready) ui_show_message(NULL, NULL);
                    motor_buzz(50, 1);
                }
                continue;
            }
        }

        /* 详情页开着时，返回键先用来关它——而不是去退回某张卡片 */
        if (ev.type == BTN_EV_CLICK && ev.id == BTN_BACK_E && s_display_ready && ui_detail_open()) {
            ui_close_detail();
            continue;
        }

        /* 返回键（中间那颗）单击＝手动分段：话题结束了，接下来算新的一段。屏上有卡片或提醒时它还是「取消」。
         * 熄屏时按也直接分段（顺便点亮屏幕给个提示），不用先按一下点亮 */
        if (ev.type == BTN_EV_CLICK && ev.id == BTN_BACK_E && !s_visible_card[0] && !s_reminder_id[0]) {
            s_split_requested = true;
            ESP_LOGW(TAG, "返回键：手动分段%s", s_paused ? "（暂停中，继续录音时从新的一段开始）" : "");
            if (s_display_ready) { ui_wake(); ui_toast(s_paused ? "已分段 继续录音时开新的一段" : "已分段 接下来是新的一段"); }
            motor_buzz(40, 2);
            continue;
        }

        /* 正在「在听」时，松手的那一下一定要走到下面去结束它，不能被点亮屏幕吞掉，
         * 否则屏幕会一直停在"在听"（实测过）。*/
        bool talking = s_talk_down_tick != 0 && ev.id == BTN_OK_E;
        /* 熄屏时按键先点亮屏幕，这一下不当确认/取消用——看不见卡片就签，等于盲签 */
        if (!talking && ev.type == BTN_EV_CLICK && s_display_ready && ui_wake()) continue;

        /* REC 单击：暂停 / 继续录音。长按仍然是关机，上面已经拦掉了 */
        if (ev.type == BTN_EV_CLICK && ev.id == BTN_REC_E) {
            s_paused = !s_paused;
            ESP_LOGW(TAG, "%s录音", s_paused ? "暂停" : "继续");
            motor_buzz(s_paused ? 150 : 60, 1);
            continue;
        }

        /* OK 键按住＝这段话要当成指令分析。录音不受影响，一直在录 */
        if (ev.id == BTN_OK_E && !s_visible_card[0]) {
            if (ev.type == BTN_EV_DOWN) {
                s_talk_paused = s_paused;
                /* 暂停中：录音循环马上恢复（还是同一段），偏移按这一段的真实钟点算 */
                s_talk_start_ms = s_talk_paused ? session_wall_ms() : recording_offset_ms();
                s_talk_down_tick = xTaskGetTickCount();
                wake_actions();
                wake_uploads();
                /* 按着就一直亮着：用不阻止熄屏的提示的话，按住超过熄屏时间屏幕会黑（用户实测） */
                if (s_display_ready) ui_show_message("在听", s_talk_paused ? "录音暂停中，只录按住的这几句\n松手结束"
                                                                      : "按住说，松手结束");
                motor_buzz(40, 1);
                continue;
            }
            /* 手一松就退出「在听」：按多久就听多久。
             * 按键驱动原来松手只发 CLICK/LONG，没有 UP，屏幕会一直卡在"在听"；现在松手先发 UP。*/
            if (ev.type == BTN_EV_UP && s_talk_down_tick) {
                uint32_t tail = s_talk_paused ? PAUSED_TALK_TAIL_MS : TALK_TAIL_MS;
                talk_mark_t mark = { .start_ms = s_talk_start_ms, .end_ms = recording_offset_ms() + tail };
                strlcpy(mark.session, s_current_session, sizeof(mark.session));
                bool held = xTaskGetTickCount() - s_talk_down_tick >= pdMS_TO_TICKS(400);
                /* 先定好录到哪，再清"按着"，录音窗口不会在中间闪断一下 */
                s_talk_until_tick = held ? xTaskGetTickCount() + pdMS_TO_TICKS(tail) : 0;
                if (held && !s_talk_paused) s_talk_flush = true;   /* 正常录音中：这块录到松手 +1.5 秒就收尾上传 */
                s_talk_down_tick = 0;
                if (s_display_ready) ui_show_message(NULL, NULL);
                /* 碰一下就松（不到 0.4 秒）当误碰：不把前后这几秒的闲聊送去建任务 */
                if (!held) { motor_buzz(30, 1); continue; }
                if (!s_talk_marks || xQueueSend(s_talk_marks, &mark, 0) != pdTRUE) {
                    if (s_display_ready) ui_toast("指令队列已满，请稍后再说");
                    motor_buzz(180, 2);
                    continue;
                }
                strlcpy(s_work_session, mark.session, sizeof(s_work_session));
                s_work_start_ms = mark.start_ms;
                s_work_deadline = xTaskGetTickCount() + pdMS_TO_TICKS(90000);
                runtime_diag_note(DIAG_TALK, (int32_t)(mark.end_ms - mark.start_ms));
                if (s_display_ready) ui_set_working(true);
                if (s_priority_marks && xQueueSend(s_priority_marks, &mark, 0) != pdTRUE)
                    ESP_LOGW(TAG, "指令优先队列已满，音频仍按普通队列补传");
                wake_actions();
                wake_uploads();
                motor_buzz(50, 2);      /* 松手：短振两下＝这段话已记下，稍后分析 */
                continue;
            }
            /* 松手时紧跟着来的 CLICK/LONG 在这里丢掉：它属于刚才那次"按住说话" */
            if (ev.type == BTN_EV_CLICK || ev.type == BTN_EV_LONG) continue;
        }
        /* 提醒盖在卡片上面时不签卡片：按键是冲着眼前这张提醒按的，底下那张卡片看不见，签了等于盲签 */
        if (ev.type != BTN_EV_CLICK || !s_visible_card[0] || s_reminder_id[0]) continue;
        if (ev.id == BTN_OK_E || ev.id == BTN_BACK_E) {
            ui_cmd_t cmd = {0};
            strlcpy(cmd.id, s_visible_card, sizeof(cmd.id));
            strlcpy(cmd.verb, ev.id == BTN_OK_E ? "confirm" : "cancel", sizeof(cmd.verb));
            if (ui_action_requested(cmd.id, cmd.verb)) ui_begin_action();
            else if (s_display_ready) ui_toast("操作繁忙，请稍后重试");
        }
    }
}

static bool save_device_key(const char *key);

/* 亮度存在 NVS：用户在屏上调好，重启后还是这个亮度 */
static uint8_t load_brightness(void)
{
    uint8_t v = 80;
    nvs_handle_t nvs;
    if (nvs_open("voxmind", NVS_READONLY, &nvs) == ESP_OK) { nvs_get_u8(nvs, "brightness", &v); nvs_close(nvs); }
    return v < 10 ? 10 : v > 100 ? 100 : v;
}
static void save_brightness(uint8_t percent)
{
    nvs_handle_t nvs;
    if (nvs_open("voxmind", NVS_READWRITE, &nvs) != ESP_OK) return;
    nvs_set_u8(nvs, "brightness", percent);
    nvs_commit(nvs);
    nvs_close(nvs);
    ESP_LOGI(TAG, "亮度 %u%% 已保存", percent);
}

static void shot_row(const void *row, size_t len)
{
    static unsigned char out[700];      /* 静态：控制台任务栈只有几 KB */
    size_t n = 0;
    if (mbedtls_base64_encode(out, sizeof(out), &n, row, len) == 0) printf("SHOT:%.*s\n", (int)n, out);
}

/* 串口维护命令（设备已配好密钥时才开）：shutdown，以及 setup<TAB>密钥 换一把新密钥
 * （从部署时的共享密钥换成管理端发放的单独密钥，丢了可以单独吊销）。*/
static void console_task(void *arg)
{
    char line[320];
    for (;;) {
        if (!fgets(line, sizeof(line), stdin)) { vTaskDelay(pdMS_TO_TICKS(200)); continue; }
        line[strcspn(line, "\r\n")] = '\0';
        if (strcmp(line, "shutdown") == 0) shutdown_device("串口命令");
        else if (strcmp(line, "screenshot") == 0) {
            /* 每行一段 base64，前缀 SHOT: 方便主机端从日志里挑出来 */
            printf("SHOT:BEGIN 240 320\n");
            if (!ui_screenshot(shot_row)) printf("SHOT:FAIL\n");
            printf("SHOT:END\n");
            fflush(stdout);
        }
        /* 调试：把开机/关机/软关机画面单独调出来拍照，不用真的关机 */
        else if (strcmp(line, "demo boot") == 0) ui_show_progress("VoxMind", "存储就绪・检查麦克风…", 50);
        else if (strcmp(line, "demo off") == 0) ui_show_message("已关机", "录音已存好\n还有 3 段没上传\n下次开机补传\n长按录音键开机");
        else if (strcmp(line, "demo sleep") == 0) ui_show_sleep("休息中，不录音", "说「小沃小沃，开机」\n或按一下录音键", SOFT_OFF_NOTE);
        else if (strcmp(line, "demo clear") == 0) { ui_close_detail(); ui_show_message(NULL, NULL); }
        else if (strcmp(line, "demo bright") == 0) ui_open_brightness();
        else if (strcmp(line, "demo detail") == 0) ui_demo_detail();
        /* 调试：在本机造一屏样例数据看主题效果，不往服务器写任何东西。
         * 卡片下一次轮询（几秒内）会被真实状态盖掉，所以要紧跟着 screenshot */
        else if (strcmp(line, "demo card") == 0)
            ui_show_card("00000000-0000-0000-0000-000000000000", "feishu.task.create", "给王总回电话，确认项目进展",
                         NULL, "明天上午十点给王总回个电话", 86400, 2);
        else if (strcmp(line, "demo feed") == 0) {
            static ui_receipt_t r[2];
            memset(r, 0, sizeof(r));
            strlcpy(r[0].id, "demo-1", sizeof(r[0].id)); strlcpy(r[0].tool, "feishu.task.create", sizeof(r[0].tool));
            strlcpy(r[0].title, "建了飞书任务：周五前交周报", sizeof(r[0].title)); strlcpy(r[0].at, "09:12", sizeof(r[0].at));
            strlcpy(r[1].id, "demo-2", sizeof(r[1].id)); strlcpy(r[1].tool, "note.create", sizeof(r[1].tool));
            strlcpy(r[1].title, "记了一条笔记：买菜清单", sizeof(r[1].title)); strlcpy(r[1].at, "08:40", sizeof(r[1].at));
            static ui_timeline_row_t t[3];
            memset(t, 0, sizeof(t));
            const char *tools[] = {"feishu.task.create", "note.create", "feishu.message.send"};
            const char *titles[] = {"周五前交周报", "买菜清单", "给张总发消息"};
            const char *ats[] = {"09:12", "08:40", "08:05"};
            const char *sts[] = {"executed", "executed", "pending"};
            for (int i = 0; i < 3; ++i) {
                strlcpy(t[i].tool, tools[i], sizeof(t[i].tool)); strlcpy(t[i].title, titles[i], sizeof(t[i].title));
                strlcpy(t[i].at, ats[i], sizeof(t[i].at)); strlcpy(t[i].status, sts[i], sizeof(t[i].status));
            }
            ui_set_feed(r, 2, t, 3, NULL);
        }
        /* 调试：照关机的步骤退出拨号、关射频，但不真关机；测完打开射频重新拨号 */
        else if (strcmp(line, "radio test") == 0) {
            modem_radio_off();
            at_cmd("AT+CFUN=1", 20000);
            esp_err_t back = s_dce ? esp_modem_set_mode(s_dce, ESP_MODEM_MODE_DATA) : ESP_FAIL;
            ESP_LOGW(TAG, "重新拨号%s", back == ESP_OK ? "已发起" : "失败");
        }
        /* 调试：模拟"按住确认键 N 毫秒再松开"，事件和真按键走同一条处理路径 */
        else if (strncmp(line, "demo talk ", 10) == 0 && s_btn_events) {
            uint32_t ms = (uint32_t)atoi(line + 10);
            btn_event_t ev = { .id = BTN_OK_E, .type = BTN_EV_DOWN };
            xQueueSend(s_btn_events, &ev, 0);
            vTaskDelay(pdMS_TO_TICKS(ms));
            ev.type = BTN_EV_UP; ev.held_ms = ms;
            xQueueSend(s_btn_events, &ev, 0);
            ev.type = ms >= 1000 ? BTN_EV_LONG : BTN_EV_CLICK;
            xQueueSend(s_btn_events, &ev, 0);
            ESP_LOGW(TAG, "串口：模拟按住确认键 %lu ms", (unsigned long)ms);
        }
        else if (strncmp(line, "power profile", 13) == 0) {
            uint32_t sec = line[13] == ' ' ? (uint32_t)atoi(line + 14) : 480;
            power_profile_start(sec >= 20 ? sec : 20, POWER_PHASE_N);
        }
        else if (strcmp(line, "demo done") == 0) {
            static ui_receipt_t r;
            memset(&r, 0, sizeof(r));
            strlcpy(r.id, "demo-done", sizeof(r.id)); strlcpy(r.tool, "feishu.task.create", sizeof(r.tool));
            strlcpy(r.title, "明天10点钟确认一些事情", sizeof(r.title)); strlcpy(r.at, "23:25", sizeof(r.at));
            strlcpy(r.evidence, "帮我建个任务，明天十点确认一下合同的事", sizeof(r.evidence));
            ui_show_done(&r);
            motor_buzz(60, 1);
        }
        else if (strcmp(line, "demo reminder") == 0) ui_show_reminder("10点拜访客户", "带上合同和报价单", "今天 10:00");
        /* 滑动帧率自测：来回翻 30 次取总量——单次之间差好几倍，样本少了全是噪声。
         * 参数 full＝翻页时开整屏刷新，partial＝不开，用来对比两种模式。*/
        else if (strncmp(line, "swipe ", 6) == 0) {
            bool full = strcmp(line + 6, "full") == 0;
            ui_set_full_refresh(full);
            vTaskDelay(pdMS_TO_TICKS(200));
            /* 只统计动画那 200ms 里的帧：把翻页之间的空闲也算进去的话，平均帧率没有意义 */
            uint32_t frames = 0, worst = 0, measured_ms = 0;
            uint64_t render_sum = 0;
            for (int i = 0; i < 30; ++i) {
                ui_anim_steps();
                ui_measure_start();
                ui_goto_page_animated(i % 2);
                vTaskDelay(pdMS_TO_TICKS(220));
                uint32_t f10 = 0, w = 0, n = 0, r10 = 0, t10 = 0;
                ui_measure_report(&f10, &w, &n);
                ui_measure_split(&r10, &t10);
                render_sum += (uint64_t)r10 * n;
                if (i < 3) {
                    uint16_t at[12], cost[12];
                    uint32_t cnt = ui_measure_trace(at, cost, 12);
                    char buf[128]; int len = 0;
                    for (uint32_t k = 0; k < cnt && len < 100; ++k)
                        len += snprintf(buf + len, sizeof(buf) - len, "%u(+%ums) ", at[k], cost[k]);
                    ESP_LOGW(TAG, "  第%d次逐帧：%s（动画走了 %u 步）", i + 1, buf, (unsigned)ui_anim_steps());
                }
                frames += n;
                measured_ms += 220;
                if (w > worst) worst = w;
                vTaskDelay(pdMS_TO_TICKS(240));
            }
            uint32_t fps10 = measured_ms ? (frames * 10000u) / measured_ms : 0;
            ui_set_full_refresh(false);
            uint32_t per_anim10 = frames * 10 / 30;
            uint32_t render_avg10 = frames ? (uint32_t)(render_sum / frames) : 0;
            ESP_LOGW(TAG, "滑动[%s] 30 次：%lu.%lu fps，共 %lu 帧（每次 %lu.%lu 帧），单帧渲染 %lu.%lums，最慢一帧 %lu ms",
                     full ? "整屏刷新" : "局部刷新",
                     (unsigned long)(fps10 / 10), (unsigned long)(fps10 % 10),
                     (unsigned long)frames, (unsigned long)(per_anim10 / 10), (unsigned long)(per_anim10 % 10),
                     (unsigned long)(render_avg10 / 10), (unsigned long)(render_avg10 % 10),
                     (unsigned long)worst);
        }
        else if (strncmp(line, "opus ", 5) == 0) { s_opus_cx_override = atoi(line + 5); ESP_LOGW(TAG, "串口：编码复杂度覆盖为 %d（下一块生效，-1 取消）", s_opus_cx_override); }
        else if (strncmp(line, "cpu ", 4) == 0) { s_rec_mhz_override = atoi(line + 4); s_pm_force = true; pm_update(); ESP_LOGW(TAG, "串口：录音 CPU 上限覆盖为 %d（0 取消）", s_rec_mhz_override); }
        else if (strncmp(line, "at ", 3) == 0) { const char *c = line + 3; modem_at_session(&c, 1); }
        else if (strcmp(line, "msleep on") == 0) modem_set_sleep(true);
        else if (strcmp(line, "msleep off") == 0) modem_set_sleep(false);
        else if (strcmp(line, "pause") == 0) { s_paused = !s_paused; ESP_LOGW(TAG, "串口：%s录音", s_paused ? "暂停" : "继续"); }
        else if (strcmp(line, "page a") == 0) ui_goto_page(0);
        else if (strcmp(line, "page b") == 0) ui_goto_page(1);
        else if (strncmp(line, "setup\t", 6) == 0) {
            const char *key = line + 6;
            if (strlen(key) < 16) ESP_LOGW(TAG, "设备密钥至少 16 字符");
            else if (save_device_key(key)) {
                ESP_LOGI(TAG, "新密钥已写入 NVS，正在重启（密钥未输出）");
                runtime_diag_stop(DIAG_STOP_CONFIG);
                vTaskDelay(pdMS_TO_TICKS(500));
                esp_restart();
            }
        }
        /* 不回显原文：这一行可能就是一把打错格式的密钥 */
        else if (line[0]) ESP_LOGW(TAG, "未知命令（支持：shutdown、screenshot、pause、page a|b、setup<TAB>密钥）");
    }
}

/* 心跳：固件版本、电量、网络、待传块数。管理端「设备」页的在线状态和电量全靠它——
 * 以前这些数只打印在设备自己的串口诊断里，云端一无所知。和拉卡片共用同一条
 * 长连接，不多一次 TLS 握手。服务端对旧共享密钥的心跳直接忽略，所以发了也无害。*/
/* 心跳带回来的"有新版本"。真正的下载放在卡片任务的循环里做，
 * 不在解析响应的地方直接刷——那会让这条长连接一挂就是好几分钟。*/
static ota_offer_t s_ota_offer;
static bool s_ota_pending;

static void parse_ota_offer(const cJSON *ota)
{
    s_ota_pending = false;
    if (!cJSON_IsObject(ota)) return;
    const char *id = cJSON_GetStringValue(cJSON_GetObjectItem(ota, "releaseId"));
    const char *version = cJSON_GetStringValue(cJSON_GetObjectItem(ota, "version"));
    const char *url = cJSON_GetStringValue(cJSON_GetObjectItem(ota, "url"));
    const char *sha = cJSON_GetStringValue(cJSON_GetObjectItem(ota, "sha256"));
    cJSON *size = cJSON_GetObjectItem(ota, "byteLength");
    if (!id || !version || !url || !sha || !cJSON_IsNumber(size)) return;
    /* 云端已经比过版本号了，这里再比一次：别因为某次上报丢了就把同一版刷两遍 */
    const char *running = esp_app_get_description()->version;
    if (strcmp(version, running) == 0) return;
    /* 设备端也拒绝降级（云端已经不会推，这里是第二道）：两边都是 x.y.z 且对方更旧就不刷 */
    unsigned a[3], b[3];
    if (sscanf(version, "%u.%u.%u", &a[0], &a[1], &a[2]) == 3 && sscanf(running, "%u.%u.%u", &b[0], &b[1], &b[2]) == 3 &&
        (a[0] < b[0] || (a[0] == b[0] && (a[1] < b[1] || (a[1] == b[1] && a[2] < b[2]))))) {
        ESP_LOGW(TAG, "云端给的 %s 比正在跑的 %s 旧，不降级", version, running);
        return;
    }
    strlcpy(s_ota_offer.release_id, id, sizeof(s_ota_offer.release_id));
    strlcpy(s_ota_offer.version, version, sizeof(s_ota_offer.version));
    strlcpy(s_ota_offer.url, url, sizeof(s_ota_offer.url));
    strlcpy(s_ota_offer.sha256, sha, sizeof(s_ota_offer.sha256));
    s_ota_offer.size = (uint32_t)size->valuedouble;
    s_ota_pending = true;
    ESP_LOGI(TAG, "云端有新固件 %s（%u 字节）", s_ota_offer.version, (unsigned)s_ota_offer.size);
}

/* ── 界面主题 ─────────────────────────────────────────────────
 * 后台选、服务器随心跳下发。下发的是"配方"（30 种颜色 + 5 个形状数，约 130 字节），
 * 设备在 NVS 里只存当前这一套，换了就覆盖——不攒旧主题，也不占文件空间。
 * 开机直接用存下的那套，不用等联网。*/
static ui_theme_t s_ui_theme;
static bool s_ui_theme_known;

static void load_ui_theme(void)
{
    nvs_handle_t nvs;
    if (nvs_open("voxmind", NVS_READONLY, &nvs) != ESP_OK) return;
    ui_theme_t t;
    size_t size = sizeof(t);
    /* 尺寸对不上（结构体变过）就不认，宁可用默认那套也别把颜色错位着刷上屏 */
    if (nvs_get_blob(nvs, "ui_theme", &t, &size) == ESP_OK && size == sizeof(t)) {
        s_ui_theme = t;
        s_ui_theme_known = true;
        ui_apply_theme(&t);
    }
    nvs_close(nvs);
}

static void apply_ui_theme(const cJSON *theme)
{
    if (!cJSON_IsObject(theme)) return;
    /* 格式版本对不上（服务器先升级了）就不换：认错一个字段，全屏颜色都会错位 */
    const cJSON *v = cJSON_GetObjectItem(theme, "v");
    if (!cJSON_IsNumber(v) || (int)v->valuedouble != 1) return;
    int shape[UI_THEME_SHAPES] = {0}, n = 0;
    const cJSON *item;
    cJSON_ArrayForEach(item, cJSON_GetObjectItem(theme, "s")) {
        if (n < UI_THEME_SHAPES && cJSON_IsNumber(item)) shape[n] = (int)item->valuedouble;
        ++n;
    }
    ui_theme_t t;
    if (!ui_theme_parse(cJSON_GetStringValue(cJSON_GetObjectItem(theme, "id")),
                        cJSON_GetStringValue(cJSON_GetObjectItem(theme, "c")), shape, n, &t)) {
        ESP_LOGW(TAG, "主题格式不对，不换");
        return;
    }
    if (s_ui_theme_known && memcmp(&t, &s_ui_theme, sizeof(t)) == 0) return;
    s_ui_theme = t;
    s_ui_theme_known = true;
    nvs_handle_t nvs;
    if (nvs_open("voxmind", NVS_READWRITE, &nvs) == ESP_OK) {
        nvs_set_blob(nvs, "ui_theme", &t, sizeof(t));
        nvs_commit(nvs);
        nvs_close(nvs);
    }
    /* 升级进度条显示着的时候不重建（会把进度条清掉）；存下了，下次开机就是新主题 */
    if (!s_display_ready || s_ota_pending) return;
    ui_apply_theme(&t);
    /* 提醒的内容只存在控件里，重建后没了。清掉记号（不是确认），下一次轮询服务器会再推，
     * 几秒内就回来。待确认卡片每次轮询都会重推，不用管。*/
    s_reminder_id[0] = '\0';
    s_reminder_hide_at = 0;
    ESP_LOGI(TAG, "界面换成主题 %s", t.id);
}

static void send_heartbeat(void)
{
    char battery[24] = "";   /* 电量计读不到时整个字段不发，别发一个假的 0 */
    if (s_battery_pct >= 0) snprintf(battery, sizeof(battery), "\"batteryPct\":%d,", s_battery_pct > 100 ? 100 : s_battery_pct);
    /* Only the action task calls this function. Keep the diagnostics and JSON body
     * off its 8 KB stack: the HTTP/TLS call below needs that stack on first boot,
     * exactly when an OTA image must deliver a heartbeat to avoid rollback. */
    static char health[RUNTIME_DIAG_JSON_BYTES];
    static char body[RUNTIME_DIAG_JSON_BYTES + 620];
    static char power[340];
    size_t health_size = runtime_diag_json(health, sizeof(health));
    power_json(power, sizeof(power));
    int body_len = snprintf(body, sizeof(body), "{\"firmware\":\"%.40s\",%s\"network\":\"4G\",\"pendingUploads\":%lu,\"charging\":%s%s%s%s}",
             esp_app_get_description()->version, battery, (unsigned long)s_pending_chunks, s_charging ? "true" : "false",
             health_size ? ",\"diagnostics\":" : "", health_size ? health : "", power);
    if (body_len < 0 || body_len >= sizeof(body)) { ESP_LOGE(TAG, "心跳正文过长，未发送"); return; }
    int status = api_request(&s_action_conn, HTTP_METHOD_POST, "/v1/device-heartbeat", "application/json",
                             body, (size_t)body_len, NULL, NULL, NULL);
    if (status != 200) { ESP_LOGW(TAG, "心跳失败 http=%d", status); return; }
    cJSON *root = cJSON_Parse(s_action_conn.response.data);
    apply_device_config(root ? cJSON_GetObjectItem(root, "config") : NULL);
    apply_ui_theme(root ? cJSON_GetObjectItem(cJSON_GetObjectItem(root, "config"), "theme") : NULL);
    parse_ota_offer(root ? cJSON_GetObjectItem(root, "ota") : NULL);
    cJSON_Delete(root);
    /* 心跳通了就说明这一版能联网：如果是刚升上来的，到这里才敢取消回滚 */
    ota_mark_valid();
}

/* 升级进度回传。和心跳共用同一条连接，而且就在同一个任务里，不会打架。*/
static void ota_progress(const char *state, int pct, const char *error, void *ctx)
{
    (void)ctx;
    char body[220], escaped[120] = "";
    if (error) {
        /* 错误信息进 JSON 前先把引号和反斜杠去掉，省得拼出坏 JSON */
        size_t n = 0;
        for (const char *p = error; *p && n < sizeof(escaped) - 1; ++p)
            if (*p != '"' && *p != '\\' && (unsigned char)*p >= 0x20) escaped[n++] = *p;
        escaped[n] = '\0';
    }
    snprintf(body, sizeof(body), "{\"releaseId\":\"%.36s\",\"state\":\"%s\",\"progressPct\":%d%s%s%s}",
             s_ota_offer.release_id, state, pct < 0 ? 0 : pct > 100 ? 100 : pct,
             escaped[0] ? ",\"error\":\"" : "", escaped[0] ? escaped : "", escaped[0] ? "\"" : "");
    api_request(&s_action_conn, HTTP_METHOD_POST, "/v1/device-ota", "application/json", body, strlen(body), NULL, NULL, NULL);

    char line[64];
    snprintf(line, sizeof(line), "%s %d%%\n录音照常进行", strcmp(state, "verifying") == 0 ? "校验中" : "下载中", pct);
    if (s_ota_running) { (void)line; }      /* 下载中界面定格，进度只报服务器（网页上能看）*/
    else if (strcmp(state, "downloading") == 0 || strcmp(state, "verifying") == 0) ui_show_progress("正在升级固件", line, pct);
    else if (strcmp(state, "failed") == 0) ui_show_message("升级失败", error ? error : "稍后自动重试");
}

/* 下载几分钟期间录音照常：采集和上传在别的任务里，这里只占卡片轮询。*/
static void run_pending_ota(void)
{
    s_ota_pending = false;
    /* 下载期间屏幕定格在这一屏，不画进度：写 flash 时屏幕传输会失败，界面任务会空转卡死（见 ui_freeze）*/
    if (s_display_ready) {
        ui_show_progress("正在升级固件", "约 3~10 分钟，请保持开机\n录音照常进行，完成后自动重启", 0);
        ui_freeze(true);
    }
    s_ota_running = true;
    runtime_diag_note(DIAG_OTA_FREEZE, 1);
    modem_wake_begin();
    bool ok = ota_apply(&s_ota_offer, s_device_key, ota_progress, NULL);
    modem_wake_end();
    s_ota_running = false;
    if (s_display_ready) ui_freeze(false);
    if (!ok) { ui_show_message(NULL, NULL); return; }
    ui_show_progress("升级完成", "正在重启", 100);
    runtime_diag_stop(DIAG_STOP_OTA);
    vTaskDelay(pdMS_TO_TICKS(1200));
    esp_restart();
}

/* 回执流（A 屏）+ 今日时刻表（B 屏）。只在服务端 feedVersion 变了、或者每 5 分钟
 * （刷新今天录了多久）才拉，不跟着 1.5 秒一次的卡片轮询走——那样一天要多花几 MB 4G 流量。*/
static void copy_str(char *dst, size_t n, const cJSON *obj, const char *key)
{
    const char *v = cJSON_GetStringValue(cJSON_GetObjectItem(obj, key));
    if (!n) return;
    if (!v) v = "";
    size_t length = strlen(v), take = length < n - 1 ? length : n - 1;
    if (take < length) while (take && ((unsigned char)v[take] & 0xc0) == 0x80) --take;
    memcpy(dst, v, take);
    dst[take] = '\0';
}

static bool fetch_feed(void)
{
    int status = api_request(&s_action_conn, HTTP_METHOD_GET, "/v1/device-feed", NULL, NULL, 0, NULL, NULL, NULL);
    if (status != 200) { ESP_LOGW(TAG, "拉回执流失败 http=%d", status); return false; }
    cJSON *root = cJSON_Parse(s_action_conn.response.data);
    if (!cJSON_IsObject(root) || !cJSON_IsArray(cJSON_GetObjectItem(root, "receipts")) ||
        !cJSON_IsArray(cJSON_GetObjectItem(root, "timeline"))) {
        ESP_LOGW(TAG, "回执流解析失败（%u 字节），保留上次内容", (unsigned)s_action_conn.response.length);
        cJSON_Delete(root);
        return false;
    }
    static ui_receipt_t receipts[UI_MAX_RECEIPTS];
    static ui_timeline_row_t rows[UI_MAX_TIMELINE];
    int nr = 0, nt = 0;
    const cJSON *item;
    cJSON_ArrayForEach(item, cJSON_GetObjectItem(root, "receipts")) {
        if (nr >= UI_MAX_RECEIPTS) break;
        const char *id = cJSON_GetStringValue(cJSON_GetObjectItem(item, "i"));
        if (!id || !id[0] || dismissal_pending(id)) continue;
        ui_receipt_t *r = &receipts[nr++];
        copy_str(r->id, sizeof(r->id), item, "i");
        copy_str(r->tool, sizeof(r->tool), item, "t");
        copy_str(r->title, sizeof(r->title), item, "n");
        copy_str(r->at, sizeof(r->at), item, "a");
        copy_str(r->evidence, sizeof(r->evidence), item, "e");
        const char *st = cJSON_GetStringValue(cJSON_GetObjectItem(item, "s"));
        r->failed = st && strcmp(st, "failed") == 0;
    }
    cJSON_ArrayForEach(item, cJSON_GetObjectItem(root, "timeline")) {
        if (nt >= UI_MAX_TIMELINE) break;
        ui_timeline_row_t *r = &rows[nt++];
        copy_str(r->tool, sizeof(r->tool), item, "t");
        copy_str(r->title, sizeof(r->title), item, "n");
        copy_str(r->at, sizeof(r->at), item, "a");
        copy_str(r->status, sizeof(r->status), item, "s");
        copy_str(r->evidence, sizeof(r->evidence), item, "e");
    }
    ui_today_t today = {0};
    const cJSON *t = cJSON_GetObjectItem(root, "today");
    if (cJSON_IsObject(t)) {
        today.valid = true;
        const cJSON *v;
        if (cJSON_IsNumber(v = cJSON_GetObjectItem(t, "recordedSec"))) today.recorded_sec = (uint32_t)v->valuedouble;
        if (cJSON_IsNumber(v = cJSON_GetObjectItem(t, "sentences"))) today.sentences = (uint32_t)v->valuedouble;
        if (cJSON_IsNumber(v = cJSON_GetObjectItem(t, "done"))) today.done = (uint32_t)v->valuedouble;
    }
    cJSON_Delete(root);
    /* 办完一件事（新回执）：亮屏、振一下、直接把它的详情卡片弹出来。
     * 明确说的指令是不问你直接办的，以前只是在列表里悄悄多一张小纸条，不盯着屏幕根本发现不了
     * ——而要你确认的卡片却会振两下弹出来，两边反差太大。在「设置 → 屏幕 → 办完时亮屏」里开关。
     *
     * "新"要按见没见过来判断，不能只比列表第一条：你在屏上把最新那条划掉后，第二条顶上来，
     * 以前会被当成刚办完的又弹一次。开机后第一次拉到的只记下、不弹（那些是关机前办的）。*/
    static char seen[16][40];                                 /* 环形：最近见过的 16 条回执 */
    static int seen_count, seen_next;
    static bool primed;
    const ui_receipt_t *fresh = NULL;
    for (int i = 0; i < nr; ++i) {
        bool known = false;
        for (int k = 0; k < seen_count && !known; ++k) known = strcmp(seen[k], receipts[i].id) == 0;
        if (known) continue;
        if (!fresh) fresh = &receipts[i];                     /* 列表按时间倒序，第一个没见过的就是最新的 */
        strlcpy(seen[seen_next], receipts[i].id, sizeof(seen[0]));
        seen_next = (seen_next + 1) % 16;
        if (seen_count < 16) ++seen_count;
    }
    ui_set_feed(receipts, nr, rows, nt, &today);
    if (fresh && primed && s_cfg.wake_on_done && s_display_ready && !s_visible_card[0] && !s_reminder_id[0]) {
        /* 有待确认卡片或提醒在屏上时不盖住它们：那两个更要紧，这条照样进列表 */
        ui_show_done(fresh);
        motor_buzz(60, 1);                                    /* 振一下；待确认卡片是振两下 */
    }
    primed = true;
    return true;
}

/* 告诉服务端这条提醒已经收到：屏上收起来，不再弹 */
static void ack_reminder(void)
{
    if (!s_reminder_id[0]) return;
    char path[96];
    snprintf(path, sizeof(path), "/v1/device-reminders/%s/ack", s_reminder_id);
    s_reminder_id[0] = '\0';
    s_reminder_hide_at = 0;
    /* 先收屏、再上报。以前是报完再收：4G 一来一回一两秒，这期间屏上要是已经换成别的提示，
     * 会被这一句一起清掉。没报上去也不要紧——服务器下次轮询还会推它，屏上会再出来 */
    if (s_display_ready) ui_show_message(NULL, NULL);
    int st = api_request(&s_action_conn, HTTP_METHOD_POST, path, "application/json", "{}", 2, NULL, NULL, NULL);
    if (st != 200 && st != 404) ESP_LOGW(TAG, "提醒确认没同步上去 http=%d", st);
    else ESP_LOGI(TAG, "提醒已收下 http=%d", st);
}

/* 卡片任务：轮询队首待确认卡片推给屏幕，并执行用户在屏幕上按的确认/取消。
 * 所有 HTTP 都在这个任务里做，界面任务只负责显示和把按键丢进队列。*/
static void sync_one_dismissal(void)
{
    char id[40] = "";
    int slot = -1;
    TickType_t now = xTaskGetTickCount();
    portENTER_CRITICAL(&s_dismiss_mux);
    for (unsigned i = 0; i < MAX_PENDING_DISMISS; ++i) {
        if (s_pending_dismiss[i].id[0] && (!s_pending_dismiss[i].retry_at ||
            (int32_t)(now - s_pending_dismiss[i].retry_at) >= 0)) {
            slot = (int)i;
            strlcpy(id, s_pending_dismiss[i].id, sizeof(id));
            break;
        }
    }
    portEXIT_CRITICAL(&s_dismiss_mux);
    if (slot < 0) return;
    char path[96];
    snprintf(path, sizeof(path), "/v1/device-receipts/%s/dismiss", id);
    int status = api_request(&s_action_conn, HTTP_METHOD_POST, path, "application/json", "{}", 2, NULL, NULL, NULL);
    portENTER_CRITICAL(&s_dismiss_mux);
    pending_dismiss_t *pending = &s_pending_dismiss[slot];
    if (status == 200 || status == 404) memset(pending, 0, sizeof(*pending));
    else {
        if (pending->tries < 5) ++pending->tries;
        pending->retry_at = xTaskGetTickCount() + pdMS_TO_TICKS(1000u << pending->tries);
    }
    portEXIT_CRITICAL(&s_dismiss_mux);
    if (status != 200 && status != 404) ESP_LOGW(TAG, "回执删除待同步 http=%d", status);
}

static void action_queue_task(void *arg)
{
    TickType_t last_beat = 0;
    for (;;) {
        runtime_diag_heartbeat(DIAG_ACTION);
        ui_cmd_t cmd = {0};
        bool got = s_ui_cmds && xQueueReceive(s_ui_cmds, &cmd, 0) == pdTRUE;
        if (got && strcmp(cmd.verb, "ack_reminder") == 0) {
            ack_reminder();
            continue;
        }
        if (got && strcmp(cmd.verb, "dismiss") == 0) {
            /* Registered by the UI callback; flush below when connected. */
        } else if (got) {
            bool confirm = strcmp(cmd.verb, "confirm") == 0;
            const char *message;
            bool ok = post_device_action(cmd.id, cmd.verb, &message);
            ui_action_done(ok, message);
            motor_buzz(ok ? 60 : 180, ok ? 1 : 2);
            if (ok && confirm) led_flash_ok();
        }
        if (!network_ready() || !s_device_key[0]) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        sync_one_dismissal();
        if (!last_beat || xTaskGetTickCount() - last_beat >= pdMS_TO_TICKS(60000)) {
            send_heartbeat();
            last_beat = xTaskGetTickCount();
        }
        if (s_ota_pending) { run_pending_ota(); continue; }
        power_log_upload();

        /* 按住 OK 说的那一段：把区间报给服务端，只有这些话会被送去抽意图 */
        /* 标记常常比那段录音先到：暂停时按住新开的那段、或者断网积压时，服务器上还没有这个会话，
         * 会回 404。以前 404 就丢了；现在放回队列，等录音传上去、会话建好再发（最多试 40 轮）。*/
        talk_mark_t mark;
        int pending_marks = s_talk_marks ? (int)uxQueueMessagesWaiting(s_talk_marks) : 0;
        while (pending_marks-- > 0 && xQueueReceive(s_talk_marks, &mark, 0) == pdTRUE) {
            char body[160];
            snprintf(body, sizeof(body), "{\"sessionId\":\"%s\",\"startMs\":%lu,\"endMs\":%lu}",
                     mark.session, (unsigned long)mark.start_ms, (unsigned long)mark.end_ms);
            int st = api_request(&s_action_conn, HTTP_METHOD_POST, "/v1/device-marks", "application/json",
                                 body, strlen(body), NULL, NULL, NULL);
            ESP_LOGI(TAG, "按住说话 %lu~%lu ms 上报 http=%d", (unsigned long)mark.start_ms, (unsigned long)mark.end_ms, st);
            if (st != 200 && st != 400 && ++mark.tries < 40) {
                if (xQueueSend(s_talk_marks, &mark, 0) != pdTRUE) work_end("指令队列已满，请重试");
            } else if (st != 200) work_end("指令标记未同步，请重试");
        }
        int status = api_request(&s_action_conn, HTTP_METHOD_GET, "/v1/device-actions",
                                 NULL, NULL, 0, NULL, NULL, NULL);
        if (status == 200) {
            cJSON *root = cJSON_Parse(s_action_conn.response.data);
            if (!cJSON_IsObject(root) || !cJSON_IsNumber(cJSON_GetObjectItem(root, "pendingCount")) ||
                !cJSON_GetObjectItem(root, "action") || !cJSON_GetObjectItem(root, "reminder")) {
                ESP_LOGW(TAG, "卡片响应无效，保留上一份有效内容");
                cJSON_Delete(root);
                vTaskDelay(pdMS_TO_TICKS(1500));
                continue;
            }
            /* 语音说的「小沃，关机」由云端识别后顺着这里下发 */
            /* 回执流：版本变了或 5 分钟到了才拉（先把版本抄出来，下面 root 会被释放） */
            static char feed_version[48];
            static TickType_t feed_at;
            const char *ver = root ? cJSON_GetStringValue(cJSON_GetObjectItem(root, "feedVersion")) : NULL;
            bool want_feed = (ver && strcmp(ver, feed_version) != 0) || !feed_at ||
                             xTaskGetTickCount() - feed_at >= pdMS_TO_TICKS(300000);
            char next_version[48] = "";
            if (ver) strlcpy(next_version, ver, sizeof(next_version));
            const char *command = root ? cJSON_GetStringValue(cJSON_GetObjectItem(root, "command")) : NULL;
            /* 后台改了设置（比如换主题）：下一圈马上发心跳拉配置，不等一分钟 */
            if (command && strcmp(command, "sync_config") == 0) last_beat = 0;
            /* 远程关机：和长按录音键同一条路径（立刻黑屏、存好当前这块、关 4G 射频、深睡眠）。
             * USB 串口卡住时也能把设备关掉；要开机还是得长按录音键 */
            if (command && strcmp(command, "shutdown") == 0) { cJSON_Delete(root); power_off("远程指令", false); continue; }
            if (command && strcmp(command, "power_profile") == 0) power_profile_start(480, POWER_PHASE_N);
            /* 改完前后对比：只测日常录音、暂停两段，每段 10 分钟 */
            if (command && strcmp(command, "power_profile_ab") == 0) power_profile_start(600, 2);
            if (command && strcmp(command, "soft_off") == 0) {
                cJSON_Delete(root);
                power_off("语音「关机」", true);
                continue;
            }
            /* 到点提醒：整屏弹一张，按确认键才算收到。设置里可以选一直留着还是几秒后消失 */
            const cJSON *rem = root ? cJSON_GetObjectItem(root, "reminder") : NULL;
            if (cJSON_IsObject(rem)) {
                const char *rid = cJSON_GetStringValue(cJSON_GetObjectItem(rem, "id"));
                if (rid && strcmp(s_reminder_id, rid) != 0) {
                    strlcpy(s_reminder_id, rid, sizeof(s_reminder_id));
                    const char *rtitle = cJSON_GetStringValue(cJSON_GetObjectItem(rem, "title"));
                    const char *rbody = cJSON_GetStringValue(cJSON_GetObjectItem(rem, "body"));
                    const char *rat = cJSON_GetStringValue(cJSON_GetObjectItem(rem, "at"));
                    bool hold = cJSON_IsTrue(cJSON_GetObjectItem(rem, "hold"));
                    const cJSON *hide = cJSON_GetObjectItem(rem, "hideSec");
                    int hide_sec = cJSON_IsNumber(hide) ? (int)hide->valuedouble : 0;
                    if (s_display_ready) {
                        ui_show_reminder(rtitle ? rtitle : "到点了", rbody ? rbody : "", rat ? rat : "");
                        ui_wake();
                    }
                    if (cJSON_IsTrue(cJSON_GetObjectItem(rem, "vibrate"))) motor_buzz(200, 2);
                    led_flash_ok();
                    s_reminder_hide_at = (!hold && hide_sec > 0)
                        ? xTaskGetTickCount() + pdMS_TO_TICKS(hide_sec * 1000) : 0;
                    ESP_LOGW(TAG, "到点提醒：%s", rtitle ? rtitle : "");
                }
            }
            /* 服务端说这条已经不用再弹了（在网页上确认过、或者任务被退回）：屏上也要跟着收起来。
             * 少了这一步，网页上点完确认，设备还会一直举着那张卡——实测过。*/
            if (s_reminder_id[0] && !cJSON_IsObject(rem)) {
                ESP_LOGI(TAG, "提醒在别处确认了，屏上收起");
                s_reminder_id[0] = '\0';
                s_reminder_hide_at = 0;
                if (s_display_ready) ui_show_message(NULL, NULL);
            }
            /* 自动消失：时间到了就自己收起来并告诉服务端"看到了" */
            if (s_reminder_id[0] && s_reminder_hide_at && xTaskGetTickCount() >= s_reminder_hide_at) {
                ack_reminder();
            }
            /* 刚才按住说的那句处理到哪了 */
            if (s_work_deadline) {
                const cJSON *talk = root ? cJSON_GetObjectItem(root, "talk") : NULL;
                const char *ts = cJSON_GetStringValue(cJSON_GetObjectItem(talk, "s"));
                const cJSON *tm = cJSON_GetObjectItem(talk, "m");
                const char *st = cJSON_GetStringValue(cJSON_GetObjectItem(talk, "st"));
                bool mine = ts && st && cJSON_IsNumber(tm) && strcmp(ts, s_work_session) == 0
                            && (uint32_t)tm->valuedouble == s_work_start_ms;
                if (mine && strcmp(st, "done") == 0) work_end(NULL);          /* 卡片或回执自己会弹出来 */
                else if (mine && strcmp(st, "none") == 0) work_end("没听出要办的事");
                else if (xTaskGetTickCount() >= s_work_deadline) work_end("还在处理，好了会弹出来");
            }
            cJSON *count = root ? cJSON_GetObjectItem(root, "pendingCount") : NULL;
            cJSON *action = root ? cJSON_GetObjectItem(root, "action") : NULL;
            uint32_t pending = cJSON_IsNumber(count) ? (uint32_t)count->valuedouble : 0;
            if (pending && cJSON_IsObject(action)) {
                const char *id = cJSON_GetStringValue(cJSON_GetObjectItem(action, "id"));
                const char *tool = cJSON_GetStringValue(cJSON_GetObjectItem(action, "tool"));
                const char *title = cJSON_GetStringValue(cJSON_GetObjectItem(action, "title"));
                const char *detail = cJSON_GetStringValue(cJSON_GetObjectItem(action, "detail"));
                /* 原话片段：用户判断"是 AI 听错了还是我说错了"的唯一依据 */
                const char *evidence = cJSON_GetStringValue(cJSON_GetObjectItem(action, "evidence"));
                /* C 类卡片 15 分钟不确认就作废，屏幕上要能看到还剩多久 */
                cJSON *ttl = cJSON_GetObjectItem(action, "expiresInSec");
                int32_t expires_in = cJSON_IsNumber(ttl) ? (int32_t)ttl->valuedouble : -1;
                static char last_id[40];
                if (id && strcmp(last_id, id) != 0) {
                    strlcpy(last_id, id, sizeof(last_id));
                    motor_buzz(60, 2);   /* 新卡片到达：短振两下（v3 需求 §三） */
                    /* 要你拍板的事：屏幕黑着的话点亮，不然振动过去了就没了 */
                    if (s_cfg.wake_on_card && s_display_ready) ui_wake();
                }
                strlcpy(s_visible_card, id ? id : "", sizeof(s_visible_card));
                ui_show_card(id, tool, title, detail, evidence, expires_in, pending);
            } else {
                s_visible_card[0] = '\0';
                ui_show_card(NULL, NULL, NULL, NULL, NULL, -1, 0);
            }
            cJSON_Delete(root);
            /* 同一条连接、同一个任务里接着拉，响应缓冲是共用的，所以放在 root 释放之后 */
            if (want_feed && fetch_feed()) {
                strlcpy(feed_version, next_version, sizeof(feed_version));
                feed_at = xTaskGetTickCount();
            }
        }
        /* Backlight follows its existing timer. Only communication stays responsive while
         * a command is pending; both UI commands and PTT marks wake this task immediately. */
        bool interactive = s_talk_down_tick || s_work_deadline ||
                           (s_talk_marks && uxQueueMessagesWaiting(s_talk_marks));
        uint32_t wait_ms = s_poll_override_ms ? s_poll_override_ms :
            voxmind_command_poll_ms(s_display_ready && ui_screen_off(), interactive);
        if (!s_ui_cmds || !uxQueueMessagesWaiting(s_ui_cmds))
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(wait_ms));
    }
}

static const char *parse_sequence(const char *name, unsigned *sequence)
{
    /* 不能用 sscanf("%8u.pcm%c")==1 判断：字面量不匹配时 sscanf 照样返回 1，
     * "00000085.part"(正在写/掉电残留的半截文件) 也会被当成待传块——实测
     * 上传任务因此卡在一个 0 字节的 .part 上无限重试，后面所有录音都传不上去。*/
    if (strlen(name) < 9 || name[8] != '.') return NULL;
    for (int i = 0; i < 8; ++i) if (!isdigit((unsigned char)name[i])) return NULL;
    const char *type = strcmp(name + 8, ".opus") == 0 ? "audio/ogg"
                     : strcmp(name + 8, ".pcm") == 0  ? "audio/pcm" : NULL;
    if (type) *sequence = (unsigned)strtoul(name, NULL, 10);
    return type;
}

/* 上传任务启动时做一次（只做一次）的全盘整理，全部跳过当前会话目录，不会和
 * 录音抢正在写的文件：
 *   - 往次掉电/复位留下的半截 .part：Ogg 一页一页自带边界，截断的文件照样能
 *     解出截断前的声音，非空的改名成正式块照常上传，只有 0 字节的才删；
 *   - 已经传空的旧会话目录删掉；
 *   - 统计待传块数。
 * 实测 20260919：卡上攒了 694 个会话目录（每次开机一个），一次全盘扫描要好几
 * 分钟——所以它绝不能放在录音路径上，也不能周期性地做。*/
static void startup_scan(void)
{
    upload_stage("开机整理");
    DIR *root = opendir(PENDING_ROOT);
    if (!root) return;
    struct dirent *s;
    unsigned salvaged = 0, dropped = 0, removed_dirs = 0, pending = 0, purged = 0;
    while ((s = readdir(root))) {
        if (s->d_name[0] == '.' || strcmp(s->d_name, s_current_session) == 0) continue;
        char dir_path[160];
        snprintf(dir_path, sizeof(dir_path), "%s/%.36s", PENDING_ROOT, s->d_name);
        DIR *d = opendir(dir_path);
        if (!d) continue;
        struct dirent *f;
        bool any_entry = false;
        while ((f = readdir(d))) {
            if (f->d_name[0] == '.' || strcmp(f->d_name, CHUNK_INDEX) == 0 || strcmp(f->d_name, SESSION_META) == 0) continue;
            unsigned seq;
            const char *type = parse_sequence(f->d_name, &seq);
#if CONFIG_VOXMIND_PURGE_LEGACY_PCM
            if (type && strcmp(type, "audio/pcm") == 0) {
                char legacy[200];
                snprintf(legacy, sizeof(legacy), "%s/%.13s", dir_path, f->d_name);
                if (unlink(legacy) == 0) { purged++; continue; }
            }
#endif
            if (type) { pending++; any_entry = true; continue; }
            if (strlen(f->d_name) != 13 || strcmp(f->d_name + 8, ".part") != 0) { any_entry = true; continue; }
            char part[200], final[200];
            snprintf(part, sizeof(part), "%s/%.13s", dir_path, f->d_name);
            struct stat st;
            if (stat(part, &st) != 0 || st.st_size == 0) {
                unlink(part);
                dropped++;
                continue;
            }
            char magic[4] = {0};
            FILE *file = fopen(part, "rb");
            if (file) { fread(magic, 1, sizeof(magic), file); fclose(file); }
            snprintf(final, sizeof(final), "%s/%.8s%s", dir_path, f->d_name,
                     memcmp(magic, "OggS", 4) == 0 ? ".opus" : ".pcm");
            if (rename(part, final) == 0) { salvaged++; pending++; }
            any_entry = true;
        }
        closedir(d);
        if (!any_entry) {
            char index[200];
            snprintf(index, sizeof(index), "%s/" CHUNK_INDEX, dir_path);
            unlink(index);
            snprintf(index, sizeof(index), "%s/" SESSION_META, dir_path);
            unlink(index);
            if (rmdir(dir_path) == 0) removed_dirs++;
        }
    }
    closedir(root);
    __atomic_add_fetch(&s_pending_chunks, pending, __ATOMIC_RELAXED);
    uint64_t total = 0, free_bytes = 0;
    esp_vfs_fat_info(STORAGE_MOUNT_POINT, &total, &free_bytes);
    ESP_LOGW(TAG, "开机整理完成：待传 %u 块，抢救半截块 %u 个，删空文件 %u 个，删空会话目录 %u 个，清理旧 PCM %u 个；SD 剩余 %llu/%llu MB",
             pending, salvaged, dropped, removed_dirs, purged, free_bytes >> 20, total >> 20);
}

/* 上传游标：同一会话里块号是连续的，传完 k 直接试 k+1，不用每传一块就把所有
 * 目录扫一遍（离线 71 小时攒下的约 5 万块，逐块全盘扫描根本追不上）。*/
static char s_cursor_session[37];
static unsigned s_cursor_seq;

static const char *cursor_path(char *path, size_t len)
{
    struct stat st;
    snprintf(path, len, "%s/%s/%08u.opus", PENDING_ROOT, s_cursor_session, s_cursor_seq);
    if (stat(path, &st) == 0) return "audio/ogg";
    snprintf(path, len, "%s/%s/%08u.pcm", PENDING_ROOT, s_cursor_session, s_cursor_seq);
    if (stat(path, &st) == 0) return "audio/pcm";
    return NULL;
}

/* 找一个有待传块的会话，把游标指向它最小的块号。优先往次开机的旧会话——当前
 * 会话最后传，否则游标追上正在录的块以后就再也不会回头去传旧会话了。*/
static bool find_oldest_pending(void)
{
    DIR *root = opendir(PENDING_ROOT);
    if (!root) return false;
    char best_session[37] = {0};
    unsigned best_seq = UINT_MAX;
    bool best_is_current = true;
    struct dirent *s;
    while ((s = readdir(root))) {
        if (s->d_name[0] == '.') continue;
        bool is_current = strcmp(s->d_name, s_current_session) == 0;
        if (best_session[0] && !best_is_current && is_current) continue;
        char dir_path[160];
        snprintf(dir_path, sizeof(dir_path), "%s/%.36s", PENDING_ROOT, s->d_name);
        DIR *d = opendir(dir_path);
        if (!d) continue;
        unsigned min_seq = UINT_MAX;
        bool any_entry = false;
        struct dirent *f;
        while ((f = readdir(d))) {
            if (f->d_name[0] == '.' || strcmp(f->d_name, CHUNK_INDEX) == 0 || strcmp(f->d_name, SESSION_META) == 0) continue;
            any_entry = true;
            unsigned seq;
            if (parse_sequence(f->d_name, &seq) && seq < min_seq) min_seq = seq;
        }
        closedir(d);
        if (!any_entry && !is_current) {
            char index[200];
            snprintf(index, sizeof(index), "%s/" CHUNK_INDEX, dir_path);
            unlink(index);
            snprintf(index, sizeof(index), "%s/" SESSION_META, dir_path);
            unlink(index);
            rmdir(dir_path);
            continue;
        }
        if (min_seq == UINT_MAX) continue;
        strlcpy(best_session, s->d_name, sizeof(best_session));
        best_seq = min_seq;
        best_is_current = is_current;
        if (!is_current) break;
    }
    closedir(root);
    if (!best_session[0]) return false;
    strlcpy(s_cursor_session, best_session, sizeof(s_cursor_session));
    s_cursor_seq = best_seq;
    return true;
}

/* 服务器明确拒收(4xx，重试也不会成功)的块挪到 rejected/ 目录留档，不删数据，
 * 但也不能让它堵在队头——否则后面所有录音都传不上去。*/
static void quarantine_chunk(const char *path, int status)
{
    char dest[200];
    mkdir(REJECTED_ROOT, 0775);
    snprintf(dest, sizeof(dest), "%s/%.8s-%08u-%d", REJECTED_ROOT, s_cursor_session, s_cursor_seq, status);
    if (rename(path, dest) != 0) unlink(path);
    ESP_LOGE(TAG, "服务器拒收 seq=%u http=%d，已移到 %s 留档，继续传后面的", s_cursor_seq, status, dest);
}

/* Upload every finalized chunk overlapping this command, in sequence order, even when
 * old audio from the SAME session is queued. Cloud 1.0.25 waits for complete marked
 * coverage before recognition; the ordinary cursor still owns all background audio. */
static bool upload_priority(void)
{
    static talk_mark_t mark;
    static bool active;
    static TickType_t started;
    if (!active) {
        if (!s_priority_marks || xQueueReceive(s_priority_marks, &mark, 0) != pdTRUE) return false;
        active = true;
        started = xTaskGetTickCount();
    }
    char path[200];
    snprintf(path, sizeof(path), "%s/%s/" CHUNK_INDEX, PENDING_ROOT, mark.session);
    FILE *index = fopen(path, "r");
    unsigned selected = UINT_MAX, seq;
    unsigned long st, du;
    bool tail_ready = false;
    struct stat info;
    if (index) {
        while (fscanf(index, "%u %lu %lu", &seq, &st, &du) == 3) {
            if (!voxmind_chunk_overlaps(st, du, mark.start_ms, mark.end_ms)) continue;
            /* Metadata is committed before final rename. A .part file means not ready. */
            snprintf(path, sizeof(path), "%s/%s/%08u.part", PENDING_ROOT, mark.session, seq);
            if (stat(path, &info) == 0) continue;
            if (voxmind_mark_tail_ready(st, du, mark.end_ms)) tail_ready = true;
            snprintf(path, sizeof(path), "%s/%s/%08u.opus", PENDING_ROOT, mark.session, seq);
            if (seq < selected && stat(path, &info) == 0) selected = seq;
        }
        fclose(index);
    }
    if (selected == UINT_MAX) {
        if (tail_ready || xTaskGetTickCount() - started >= pdMS_TO_TICKS(600000)) active = false;
        return false;
    }
    if (!ensure_cloud_session(mark.session)) return false;
    snprintf(path, sizeof(path), "%s/%s/%08u.opus", PENDING_ROOT, mark.session, selected);
    int status = upload_chunk(mark.session, selected, path, "audio/ogg");
    if (status == 404) s_ensured_session[0] = '\0';
    if (status != 200 && status != 201) {
        /* Permanent rejection is left for the ordinary cursor's existing quarantine path. */
        if (status == 400 || status == 409 || status == 413) active = false;
        return false;
    }
    if (unlink(path) == 0 && s_pending_chunks) __atomic_sub_fetch(&s_pending_chunks, 1, __ATOMIC_RELAXED);
    ESP_LOGI(TAG, "指令音频优先上传 seq=%u", selected);
    return true;
}

static bool upload_one_pending(void)
{
    if (upload_priority()) return true;
    /* Do not start another slow background upload while the user is speaking or
     * the 1.5 s command tail is being finalized. Recording continues locally. */
    if (talk_window_open()) return false;
    char path[200];
    const char *type = NULL;
    if (s_cursor_session[0]) {
        type = cursor_path(path, sizeof(path));
        if (!type) {
            /* 已经追上正在录的那一块：等它落盘，不要去全盘扫描 */
            if (strcmp(s_cursor_session, s_current_session) == 0 && s_cursor_seq >= s_recording_seq) return false;
            s_cursor_session[0] = '\0';
        }
    }
    if (!s_cursor_session[0]) {
        upload_stage("扫描");
        if (!find_oldest_pending()) return false;
        type = cursor_path(path, sizeof(path));
        if (!type) return false;
    }
    upload_stage("建会话");
    if (!ensure_cloud_session(s_cursor_session)) return false;
    int status = upload_chunk(s_cursor_session, s_cursor_seq, path, type);
    if (status == 200 || status == 201) {
        unlink(path);
    } else if (status == 404) {
        s_ensured_session[0] = '\0'; /* 服务器没有这个会话了：下一轮重新创建 */
        return false;
    } else if (status == 400 || status == 409 || status == 413) {
        quarantine_chunk(path, status);
    } else {
        return false; /* 断网/超时/5xx：退避后重试同一块 */
    }
    if (s_pending_chunks) __atomic_sub_fetch(&s_pending_chunks, 1, __ATOMIC_RELAXED);
    s_cursor_seq++;
    return true;
}

static void uploader_task(void *arg)
{
    startup_scan();
    for (;;) {
        runtime_diag_heartbeat(DIAG_UPLOAD);
        if (network_ready() && s_device_key[0]) {
            if (upload_one_pending()) continue;
            upload_stage("空闲/退避");
        } else {
            upload_stage("等网络");
        }
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(2000));
    }
}

static void load_device_config(void)
{
    strlcpy(s_device_key, CONFIG_VOXMIND_DEVICE_API_KEY, sizeof(s_device_key));
    nvs_handle_t nvs;
    if (nvs_open("voxmind", NVS_READONLY, &nvs) != ESP_OK) return;
    size_t size = sizeof(s_device_key); nvs_get_str(nvs, "device_key", s_device_key, &size);
    nvs_close(nvs);
}

/* 4G 不需要配 SSID/密码——只要 SIM 插好、天线接好，APN 走 Kconfig 的默认值
 * (cmnet)。串口配置现在只剩一件事：设备密钥。*/
static void provision_task(void *arg)
{
    char line[320];
    ESP_LOGW(TAG, "等待串口配置。输入：setup<TAB>设备密钥");
    for (;;) {
        if (!fgets(line, sizeof(line), stdin)) { vTaskDelay(pdMS_TO_TICKS(200)); continue; }
        char *save = NULL;
        char *command = strtok_r(line, "\t\r\n", &save);
        char *key = strtok_r(NULL, "\t\r\n", &save);
        if (!command || strcmp(command, "setup") || !key || strlen(key) < 16) {
            ESP_LOGW(TAG, "格式无效；字段用 Tab 分隔，设备密钥至少 16 字符");
            continue;
        }
        if (!save_device_key(key)) continue;
        ESP_LOGI(TAG, "配置已安全写入 NVS，正在重启（密钥未输出）");
        runtime_diag_stop(DIAG_STOP_CONFIG);
        vTaskDelay(pdMS_TO_TICKS(500));
        esp_restart();
    }
}

static bool save_device_key(const char *key)
{
    nvs_handle_t nvs = 0;
    if (nvs_open("voxmind", NVS_READWRITE, &nvs) != ESP_OK ||
        nvs_set_str(nvs, "device_key", key) != ESP_OK || nvs_commit(nvs) != ESP_OK) {
        ESP_LOGE(TAG, "保存配置失败");
        if (nvs) nvs_close(nvs);
        return false;
    }
    nvs_close(nvs);
    return true;
}

/* 当前录到会话的第几毫秒。块号 × 5 秒 + 这一块里已经过去的时间 */
static uint32_t recording_offset_ms(void)
{
    uint32_t into = s_chunk_start_tick ? (uint32_t)((xTaskGetTickCount() - s_chunk_start_tick) * portTICK_PERIOD_MS) : 0;
    if (into > (uint32_t)s_active_chunk_sec * 1000) into = (uint32_t)s_active_chunk_sec * 1000;
    return s_chunk_offset_ms + into;
}

static esp_err_t record_chunk(const char *session_dir, unsigned sequence)
{
    char part[200], final[200];
    snprintf(part, sizeof(part), "%s/%08u.part", session_dir, sequence);
    snprintf(final, sizeof(final), "%s/%08u.opus", session_dir, sequence);
    s_recording_seq = sequence;
    s_chunk_start_tick = xTaskGetTickCount();
    /* 音质是后台可调的。只能在两块之间换编码器：写到一半换，这个块的 Ogg 页会前后不一致 */
    static uint16_t applied_bitrate = CONFIG_VOXMIND_OPUS_BITRATE;
    static uint8_t applied_complexity = CONFIG_VOXMIND_OPUS_COMPLEXITY;
    uint8_t want_cx = s_opus_cx_override >= 0 ? (uint8_t)s_opus_cx_override : s_cfg.audio_complexity;
    if (s_cfg.audio_bitrate != applied_bitrate || want_cx != applied_complexity) {
        if (codec_opus_reconfigure(AUDIO_SAMPLE_RATE, s_cfg.audio_bitrate, want_cx) == ESP_OK) {
            ESP_LOGW(TAG, "音质已切换：%u bps，复杂度 %u", (unsigned)s_cfg.audio_bitrate, (unsigned)want_cx);
            applied_bitrate = s_cfg.audio_bitrate;
            applied_complexity = want_cx;
            s_active_cx = want_cx;
            pm_update();
        } else {
            ESP_LOGE(TAG, "切音质失败，继续用原来的");
            applied_bitrate = s_cfg.audio_bitrate = applied_bitrate;   /* 别每块都重试 */
            s_cfg.audio_complexity = applied_complexity;
        }
    }
    FILE *file = fopen(part, "wb");
    if (!file) return ESP_FAIL;
    esp_err_t result = codec_opus_begin_file(file);
    const size_t target_samples = (size_t)AUDIO_SAMPLE_RATE * s_active_chunk_sec;
    size_t written_samples = 0;
    int silent_seconds = 0;
    /* 收到关机就地收尾：录到哪存到哪。以前要等这一块录满（最多 5 秒，块长调成 15 秒时
     * 关机流程等 8 秒就超时、照样断电，最后一块反而被截坏）。*/
    /* 暂停中按住说完了（松手 + 1.5 秒）也就地收尾：这一小段立刻落盘上传，不等凑满一块 */
    while (result == ESP_OK && written_samples < target_samples && !s_shutdown_requested && !recorder_paused()
           && !(s_talk_flush && !talk_window_open()) && !s_split_requested) {
        esp_task_wdt_reset();
        size_t want = (target_samples - written_samples) * sizeof(int16_t);
        if (want > sizeof(s_chunk_pcm)) want = sizeof(s_chunk_pcm);
        size_t got = xStreamBufferReceive(s_pcm_stream, s_chunk_pcm, want, pdMS_TO_TICKS(1000));
        /* 80MHz 编码跟不上的保险：积压超过 2 秒就提到 160MHz，本次开机内不再降回 */
        if (!s_rec_boost && rec_mhz() == 80 &&
            xStreamBufferBytesAvailable(s_pcm_stream) > AUDIO_SAMPLE_RATE * sizeof(int16_t) * 2) {
            s_rec_boost = true;
            ESP_LOGW(TAG, "录音编码积压超过 2 秒，CPU 提到 160MHz");
            pm_update();
        }
        if (got == 0) {
            if (++silent_seconds >= 5) {
                ESP_LOGE(TAG, "麦克风 5 秒没有数据");
                result = ESP_ERR_TIMEOUT;
            }
            continue;
        }
        silent_seconds = 0;
        result = codec_opus_write_pcm(file, s_chunk_pcm, got / sizeof(int16_t));
        if (result == ESP_OK) {
            written_samples += got / sizeof(int16_t);
            voxmind_recorded_add(&s_recorded_seconds, &s_recorded_remainder,
                                got / sizeof(int16_t), AUDIO_SAMPLE_RATE);
        }
    }
    if (result == ESP_OK) result = codec_opus_end_file(file);
    if (fflush(file) || fsync(fileno(file))) result = ESP_FAIL;
    long size = ftell(file);
    fclose(file);
    /* 这块实际录了多久：块长会变（按住说完提前收尾、暂停、关机），时间轴按真实时长累加 */
    uint32_t dur_ms = (uint32_t)(written_samples * 1000ULL / AUDIO_SAMPLE_RATE);
    if (s_talk_flush && !talk_window_open()) {
        s_talk_flush = false;
        ESP_LOGI(TAG, "按住说完，这块提前收尾 seq=%u（%lu ms）", sequence, (unsigned long)dur_ms);
    }
    /* 不到 0.3 秒的块不要：暂停中碰一下确认键（不到 0.4 秒算误碰）会新开一段、马上收尾，麦克风刚打开
     * 一帧都没录到，留下 125 字节只有文件头的空 Ogg。以前照样上传，服务器解码报「End of file」
     * 记成转写失败，时长还按块长记成 15 秒（2026-10-05 一天 10 条）*/
    if (result == ESP_OK && written_samples < AUDIO_SAMPLE_RATE * 3 / 10) {
        unlink(part);
        ESP_LOGI(TAG, "这块只录到 %lu ms，丢掉不传 seq=%u", (unsigned long)dur_ms, sequence);
        return ESP_OK;
    }
    uint32_t start_ms = s_chunk_offset_ms;
    s_chunk_offset_ms = start_ms + dur_ms;
    if (result == ESP_OK) {
        /* Never publish audio before its real timing is readable by the uploader. */
        chunk_timing_save(session_dir, sequence, start_ms, dur_ms);
    }
    if (result == ESP_OK && rename(part, final) == 0) {
        __atomic_add_fetch(&s_pending_chunks, 1, __ATOMIC_RELAXED);
        wake_uploads();
        ESP_LOGI(TAG, "本地安全落盘 seq=%u %ld 字节", sequence, size);
        return ESP_OK;
    }
    unlink(part);
    return result == ESP_OK ? ESP_FAIL : result;
}

static esp_err_t ensure_directory(const char *path)
{
    if (mkdir(path, 0775) == 0 || errno == EEXIST) return ESP_OK;
    ESP_LOGE(TAG, "创建目录失败 path=%s errno=%d (%s)", path, errno, strerror(errno));
    return ESP_FAIL;
}

static void start_microphone(void)
{
    const size_t stream_bytes = AUDIO_SAMPLE_RATE * sizeof(int16_t) * CAPTURE_BUFFER_SECONDS;
    static StaticStreamBuffer_t stream_struct;
    uint8_t *stream_storage = heap_caps_malloc(stream_bytes + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    ESP_ERROR_CHECK(stream_storage ? ESP_OK : ESP_ERR_NO_MEM);
    s_pcm_stream = xStreamBufferCreateStatic(stream_bytes, 1, stream_storage, &stream_struct);
    ESP_ERROR_CHECK(audio_init());
    ESP_ERROR_CHECK(audio_start());
    /* 采集任务优先级最高、钉在 CPU0：它几乎只阻塞在 I2S DMA 上，CPU 占用极小，
     * 但必须保证每 15ms 的 DMA 块一到就能被取走。*/
    xTaskCreatePinnedToCore(capture_task, "voxmind_mic", 3072, NULL, 10, NULL, 0);
}

/* 定时关机：到了关机时间点（跨过那一分钟）就按设置真关机或软关机 */
static void schedule_task(void *arg)
{
    int prev = -1;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(15000));
        if (!s_cfg.schedule_enabled || time(NULL) < 1700000000) { prev = -1; continue; }
        int now = minute_of_day();
        if (prev >= 0 && crossed(prev, now, s_cfg.off_min)) power_off("定时关机", s_cfg.schedule_soft);
        prev = now;
    }
}

static void leave_soft_off(const char *reason)
{
    runtime_diag_stop(DIAG_STOP_WAKE);
    ESP_LOGW(TAG, "退出软关机(%s)，重启回到正常录音", reason);
    voice_cmd_stop();
    s_soft_off_flag = 0;
    display_backlight(100);
    ui_show_progress("正在开机", NULL, 10);
    vTaskDelay(pdMS_TO_TICKS(400));
    esp_restart();
}

/* 软关机模式：不录音、不开 4G、不上传。麦克风的声音只喂给本地指令识别，不落盘、不外传。*/
static void soft_off_main(void)
{
    ESP_LOGW(TAG, "软关机模式：不录音、不联网，只在本地听「唤醒词＋开机」");
    setenv("TZ", "CST-8", 1);
    tzset();
    load_device_cfg();
    load_ui_theme();
    ESP_ERROR_CHECK(feedback_init());
    bool screen = power_init() == ESP_OK && display_init() == ESP_OK && display_touch_init() == ESP_OK &&
                  ui_init(ui_status, ui_action_requested) == ESP_OK;
    char hint[96];
    snprintf(hint, sizeof(hint), "说「%s，开机」\n或按一下录音键", s_cfg.wake_word);
    if (screen) { ui_show_sleep("休息中，不录音", hint, SOFT_OFF_NOTE); display_backlight(100); }
    s_soft_screen_until = xTaskGetTickCount() + pdMS_TO_TICKS(8000);
    xTaskCreatePinnedToCore(button_task, "voxmind_keys", 4096, NULL, 6, NULL, 1);
    start_microphone();

    const char *phrases[MAX_WAKE_PHRASES];
    for (int i = 0; i < s_cfg.phrase_count; ++i) phrases[i] = s_cfg.phrases[i];
    bool listening = voice_cmd_start(phrases, s_cfg.phrase_count) == ESP_OK;
    if (!listening) ESP_LOGE(TAG, "离线指令识别起不来，只能按键或定时开机");
    int chunk = listening ? voice_cmd_chunk_samples() : 512;
    int16_t *buf = heap_caps_malloc(chunk * sizeof(int16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    ESP_ERROR_CHECK(buf ? ESP_OK : ESP_ERR_NO_MEM);

    int prev_min = time(NULL) > 1700000000 ? minute_of_day() : -1;
    TickType_t last_check = xTaskGetTickCount();
    bool lit = screen;
    for (;;) {
        size_t got = 0;
        while (got < chunk * sizeof(int16_t)) {
            size_t n = xStreamBufferReceive(s_pcm_stream, (uint8_t *)buf + got, chunk * sizeof(int16_t) - got, pdMS_TO_TICKS(500));
            if (!n) break;
            got += n;
        }
        if (listening && got == chunk * sizeof(int16_t) && voice_cmd_feed(buf)) leave_soft_off("语音「开机」");

        TickType_t tick = xTaskGetTickCount();
        if (screen) {
            bool want = (int32_t)(s_soft_screen_until - tick) > 0;
            if (want != lit) { if (want) ui_show_sleep("休息中，不录音", hint, SOFT_OFF_NOTE); display_backlight(want ? 100 : 0); lit = want; }
        }
        /* 开了定时开关机的，到开机时间就回来——不管当初是定时还是语音进的软关机 */
        if (tick - last_check >= pdMS_TO_TICKS(15000)) {
            last_check = tick;
            if (s_cfg.schedule_enabled && time(NULL) > 1700000000) {
                int now = minute_of_day();
                if (prev_min >= 0 && crossed(prev_min, now, s_cfg.on_min)) leave_soft_off("定时开机");
                prev_min = now;
            }
        }
    }
}

void cloud_app_run(void)
{
    /* 深睡前钉住的脚（sleep_hold_pins），醒来先松开，不然各驱动接管不了 */
    gpio_deep_sleep_hold_dis();
    static const int held[] = { PIN_LED_DATA, PIN_TP_RST, PIN_LCD_RST, PIN_LCD_CS, PIN_SD_CS, PIN_MIC_CLK, PIN_MOTOR_PWM };
    for (size_t i = 0; i < sizeof(held) / sizeof(held[0]); ++i) gpio_hold_dis(held[i]);
    runtime_diag_init((uint32_t)esp_reset_reason(), esp_random());
    char boot_health[RUNTIME_DIAG_JSON_BYTES];
    if (runtime_diag_json(boot_health, sizeof(boot_health))) ESP_LOGI(TAG, "启动留痕 %s", boot_health);
    if (s_soft_off_flag == SOFT_OFF_MAGIC) soft_off_main();   /* 不返回 */
    ESP_LOGI(TAG, "VoxMind 云端实验模式：持续录音，本地优先，4G(ML307C) 补传");
    ESP_ERROR_CHECK(storage_init());
    ESP_ERROR_CHECK(codec_opus_init(AUDIO_SAMPLE_RATE, CONFIG_VOXMIND_OPUS_BITRATE, CONFIG_VOXMIND_OPUS_COMPLEXITY));
    ESP_ERROR_CHECK(ensure_directory(PENDING_ROOT));
    snprintf(s_boot_id, sizeof(s_boot_id), "%08lx%04lx", (unsigned long)esp_random(), (unsigned long)(esp_random() & 0xffff));
    make_uuid(s_current_session);
    /* 先读存下的设置再定块长。以前这里在 load_device_cfg() 之前，开机这段录音永远用编译时的默认
     * 5 秒——后台设的块长只有暂停再继续之后才生效，而设备通常一路录到关机，设置等于没用（2026-10-03 发现）*/
    load_device_cfg();
    s_active_chunk_sec = s_cfg.chunk_sec;          /* 新会话才换块长：中途换会把时间轴算错位 */
    char session_dir[160];
    snprintf(session_dir, sizeof(session_dir), "%s/%s", PENDING_ROOT, s_current_session);
    ESP_ERROR_CHECK(ensure_directory(session_dir));
    session_meta_save(session_dir);
    ESP_ERROR_CHECK(feedback_init());
    setenv("TZ", "CST-8", 1);   /* 屏幕上显示的是北京时间 */
    tzset();
    s_ui_cmds = xQueueCreate(4, sizeof(ui_cmd_t));
    s_talk_marks = xQueueCreate(4, sizeof(talk_mark_t));
    s_priority_marks = xQueueCreate(8, sizeof(talk_mark_t));
    load_ui_theme();          /* 建界面之前：开机第一帧就是存下的主题，不会先闪一下默认的 */
    pm_init();
    if (power_init() == ESP_OK && display_init() == ESP_OK && display_touch_init() == ESP_OK &&
        ui_init(ui_status, ui_action_requested) == ESP_OK) {
        s_display_ready = true;
        ui_set_screen_listener(on_screen_change);
        power_boot_check();
        power_status_t battery;
        if (power_read(&battery) == ESP_OK) { s_battery_pct = (int)battery.soc_pct; s_charging = battery.charging; }
    } else {
        ESP_LOGW(TAG, "屏幕/触摸未就绪；录音上传仍继续，卡片可在 Web 处理");
    }
    if (s_display_ready) ui_show_progress("VoxMind", "存储就绪・检查麦克风…", 50);
    start_microphone();
    /* 自检只报真做完的：等麦克风真的有采样进来（最多 2 秒）才打勾 */
    uint32_t before = s_captured_samples;
    for (int i = 0; i < 20 && s_captured_samples == before; ++i) vTaskDelay(pdMS_TO_TICKS(100));
    if (s_display_ready) {
        bool mic = s_captured_samples != before;
        ui_show_progress("VoxMind", mic ? "存储就绪・麦克风就绪" : "麦克风没有数据，请检查", 100);
        vTaskDelay(pdMS_TO_TICKS(mic ? 500 : 2500));
        ui_show_message(NULL, NULL);
    }
    load_device_config();
    load_device_cfg();
    led_set_mode((led_mode_t)s_cfg.led_mode);
    if (s_display_ready) {
        ui_set_brightness(load_brightness(), save_brightness);
        ui_set_screen_timeout(s_cfg.screen_off_sec);
        ui_set_tap_wake(s_cfg.tap_wake);
        ui_set_double_tap_off(s_cfg.dtap_off);
    }
    led_set(LED_RECORDING);
    xTaskCreatePinnedToCore(power_led_task, "voxmind_power", 3072, NULL, 3, NULL, 1);
    xTaskCreatePinnedToCore(schedule_task, "voxmind_sched", 3072, NULL, 3, NULL, 1);
    /* docs/20 §4.2："音频采集绝不能被上传阻塞"。录音循环在 main 任务上，固定
     * 在 CPU0；所有联网相关任务都钉到 CPU1。实测 20260918：上传任务不钉核、
     * 优先级又比录音高时，一次 TLS 握手(mbedTLS 大数运算)能在 CPU0 上连续
     * 霸占 5 秒以上，录音任务完全拿不到 CPU——I2S 缓冲溢出丢音频，看门狗复位。*/
    if (s_device_key[0]) {
        xTaskCreatePinnedToCore(network_task, "voxmind_net", 6144, NULL, 4, NULL, 1);
    } else {
        ESP_LOGW(TAG, "未配置设备密钥；仍会持续本地录音，但不会上传");
        xTaskCreatePinnedToCore(provision_task, "voxmind_setup", 4096, NULL, 4, NULL, 1);
    }
    xTaskCreatePinnedToCore(uploader_task, "voxmind_upload", 8192, NULL, 5, &s_upload_task, 1);
    xTaskCreatePinnedToCore(action_queue_task, "voxmind_actions", 8192, NULL, 4, &s_action_task, 1);
    xTaskCreatePinnedToCore(diag_task, "voxmind_diag", 4096, NULL, 3, NULL, 0);
    s_recorder_stopped = xSemaphoreCreateBinary();
    xTaskCreatePinnedToCore(button_task, "voxmind_keys", 4096, NULL, 6, NULL, 1);
    if (s_device_key[0]) xTaskCreatePinnedToCore(console_task, "voxmind_console", 6144, NULL, 2, NULL, 1);
    /* 录音循环大部分时间阻塞在 audio_read 上等 DMA，提到比所有应用任务都高
     * 不会饿死别人，但保证它醒来时一定能立刻拿到 CPU。*/
    vTaskPrioritySet(NULL, 8);
    /* 录音循环是这台设备唯一不能丢的功能——把它挂到任务看门狗上，万一某次
     * SD 卡/驱动调用真的卡死不返回，靠看门狗强制复位自救，好过悄无声息地
     * 停在那不录了。record_chunk() 内层循环里会按每次 audio_read 的节奏
     * 喂狗，节奏比 5 秒的看门狗超时短得多，不会误触发。*/
    s_main_task = xTaskGetCurrentTaskHandle();
    esp_task_wdt_add(NULL);
    ESP_LOGI(TAG, "录音循环启动，main 剩余栈=%u bytes，内部 RAM 剩余=%u bytes",
             (unsigned)(uxTaskGetStackHighWaterMark(NULL) * sizeof(StackType_t)),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    bool was_paused = false, mic_on = true;
    s_chunk_offset_ms = 0;
    s_session_start_tick = xTaskGetTickCount();
    for (unsigned sequence = 0; !s_shutdown_requested; ++sequence) {
        /* 按了返回键：开新的一段（新会话）。暂停中按的话，等继续录音时再开 */
        if (s_split_requested && !recorder_paused()) {
            s_split_requested = false;
            make_uuid(s_current_session);
            s_active_chunk_sec = s_cfg.chunk_sec;
            snprintf(session_dir, sizeof(session_dir), "%s/%s", PENDING_ROOT, s_current_session);
            ensure_directory(session_dir);
            session_meta_save(session_dir);
            sequence = 0;
            s_chunk_offset_ms = 0;
            s_session_start_tick = xTaskGetTickCount();
            ESP_LOGW(TAG, "手动分段，新的一段 %s", s_current_session);
        }
        if (recorder_paused()) {
            if (!was_paused) {
                was_paused = true;
                ESP_LOGW(TAG, "录音已暂停（按一下录音键继续）");
                /* 不弹全屏提示：A 屏顶上第一张卡就是「已暂停」，状态栏也写着，
                 * 盖一整屏反而挡住别的任务，暂停时也该能翻看、能签卡片 */
            }
            /* 暂停时关麦克风：以前一直开着、采到的直接扔掉，白耗电（实测暂停时面板+麦克风约 29mA）。
             * 按住确认键会让这里马上走到下面恢复，50ms 内重新打开，开头的字不会丢 */
            if (mic_on) { s_mic_wanted = false; mic_on = false; pm_update(); }
            vTaskDelay(pdMS_TO_TICKS(50));
            esp_task_wdt_reset();
            --sequence;                     /* 暂停期间不占块号 */
            continue;
        }
        if (!mic_on) {
            if (s_pcm_stream) xStreamBufferReset(s_pcm_stream);   /* 采集任务停着，这时清得掉 */
            s_mic_wanted = true;
            mic_on = true;
            pm_update();
        }
        if (was_paused) {
            /* 恢复：还是同一段（只有返回键和开机才分段）。时间轴按这一段的真实钟点接上——
             * 每块的起点记在 index.txt，云端按它排，暂停的那几分钟就是空着的，不会被压扁。
             * 以前恢复时另起会话，是因为那时起点按「块号 × 块长」推算 */
            was_paused = false;
            if (s_split_requested) { --sequence; continue; }   /* 暂停时按过返回键：回到循环开头开新的一段 */
            s_chunk_offset_ms = session_wall_ms();
            ESP_LOGW(TAG, "继续录音（同一段），从第 %lu 秒接上", (unsigned long)(s_chunk_offset_ms / 1000));
            /* 这里以前会 ui_show_message(NULL, NULL) 清掉暂停提示——但它清的是屏上任何消息，
             * 暂停期间弹出的到点提醒会被一并无声抹掉。暂停不再弹全屏，这里也就不用清了。*/
        }
        if (record_chunk(session_dir, sequence) != ESP_OK) {
            runtime_diag_note(DIAG_RECORD_ERROR, (int32_t)sequence);
            ESP_LOGE(TAG, "录音块写入失败 seq=%u", sequence);
            /* fopen 一开始就失败时 record_chunk 不会进内层循环，喂狗节点
             * 不会被跑到——SD 卡拔了之类的持续性故障不该被看门狗当成"卡死"
             * 复位死循环（那是另一种我们已经吃过亏的坑），这里补一次喂狗。*/
            esp_task_wdt_reset();
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }
    /* 关机流程：当前这一块已经录完落盘，告诉它可以断电了，然后挂起自己。*/
    esp_task_wdt_delete(NULL);
    if (s_recorder_stopped) xSemaphoreGive(s_recorder_stopped);
    vTaskSuspend(NULL);
}

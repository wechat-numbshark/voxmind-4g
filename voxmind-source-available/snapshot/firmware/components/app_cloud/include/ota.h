#pragma once
#include <stdbool.h>
#include <stdint.h>

/* 远程升级（双 OTA 分区）。
 *
 * 设备戴在用户身上，出了 bug 不可能把人约回来插 USB，所以必须能远程刷。
 * 刷的是当前没在跑的那个分区，校验通过才切启动分区；新固件起不来，
 * bootloader 会自动退回上一版，最坏情况是停在旧固件上，不会变砖。*/

typedef struct {
    char release_id[40];
    char version[48];
    char url[288];
    char sha256[65];
    uint32_t size;
} ota_offer_t;

/* 进度回调。state 是给服务端看的状态名（downloading/verifying/rebooting/failed），
 * 在调用 ota_apply() 的那个任务里被同步调用，所以回调里发 HTTP 是安全的。*/
typedef void (*ota_progress_fn)(const char *state, int pct, const char *error, void *ctx);

/* 把这一版刷进备用分区。阻塞若干分钟。成功返回 true，调用方随后自己重启。*/
bool ota_apply(const ota_offer_t *offer, const char *device_key, ota_progress_fn progress, void *ctx);

/* 新固件跑起来、并且确实能和云端通上话之后调用：取消回滚，认定这一版可用。
 * 早调了等于放弃回滚保护，所以要等到网络真的通了再调。*/
void ota_mark_valid(void);

/* 这次启动是不是刚升级完、还在待确认状态（用于日志和界面提示）。*/
bool ota_pending_verify(void);

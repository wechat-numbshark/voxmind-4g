#include "ota.h"

#include <string.h>

#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_https_ota.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_task_wdt.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/sha256.h"

static const char *TAG = "ota";

/* 只有挂了看门狗的任务才喂：卡片任务故意没挂（它跑 TLS，合法地会占 CPU 好几秒），
 * 直接调 esp_task_wdt_reset() 会每包刷一行 "task not found"。*/
static void feed_watchdog(void)
{
    if (esp_task_wdt_status(NULL) == ESP_OK) esp_task_wdt_reset();
}
static char s_device_key[129];

/* esp_https_ota 自己建 http client，设备密钥只能从这个回调里塞进去 */
static esp_err_t attach_device_key(esp_http_client_handle_t client)
{
    return esp_http_client_set_header(client, "x-device-key", s_device_key);
}

/* 刷完再把分区读回来对一遍 sha256。
 *
 * esp_https_ota 只校验镜像头，不校验内容：4G 上传到一半被运营商截断、
 * flash 某一页没写进去，镜像头照样是对的。真刷坏了要等 bootloader 回滚，
 * 那中间设备会白重启一次；在这里读回来比一遍便宜得多。*/
static bool partition_matches(const esp_partition_t *part, uint32_t size, const char *expect_hex)
{
    if (!part || !size || strlen(expect_hex) != 64) return false;
    uint8_t *buffer = malloc(4096);
    if (!buffer) return false;
    mbedtls_sha256_context ctx;
    mbedtls_sha256_init(&ctx);
    mbedtls_sha256_starts(&ctx, 0);
    bool ok = true;
    for (uint32_t offset = 0; offset < size && ok; offset += 4096) {
        uint32_t take = size - offset < 4096 ? size - offset : 4096;
        ok = esp_partition_read(part, offset, buffer, take) == ESP_OK;
        if (ok) mbedtls_sha256_update(&ctx, buffer, take);
        feed_watchdog();
    }
    uint8_t digest[32];
    mbedtls_sha256_finish(&ctx, digest);
    mbedtls_sha256_free(&ctx);
    free(buffer);
    if (!ok) return false;
    char hex[65];
    for (int i = 0; i < 32; ++i) snprintf(hex + i * 2, 3, "%02x", digest[i]);
    if (strcasecmp(hex, expect_hex) != 0) {
        ESP_LOGE(TAG, "刷进去的内容对不上：本地 %.12s… 期望 %.12s…", hex, expect_hex);
        return false;
    }
    return true;
}

static void report(ota_progress_fn progress, void *ctx, const char *state, int pct, const char *error)
{
    if (progress) progress(state, pct, error, ctx);
}

bool ota_apply(const ota_offer_t *offer, const char *device_key, ota_progress_fn progress, void *ctx)
{
    if (!offer || !offer->url[0] || !offer->size) return false;
    strlcpy(s_device_key, device_key ? device_key : "", sizeof(s_device_key));

    const esp_partition_t *target = esp_ota_get_next_update_partition(NULL);
    const esp_partition_t *running = esp_ota_get_running_partition();
    if (!target) { report(progress, ctx, "failed", 0, "没有可用的 OTA 分区"); return false; }
    if (offer->size > target->size) { report(progress, ctx, "failed", 0, "固件比分区还大"); return false; }
    ESP_LOGI(TAG, "开始升级 %s → %s（%s，%u 字节）", esp_app_get_description()->version, offer->version,
             target->label, (unsigned)offer->size);

    esp_http_client_config_t http = {
        .url = offer->url,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .timeout_ms = 30000,
        .keep_alive_enable = true,
        .buffer_size = 4096,
    };
    /* 分段下载 + 断点续传：每段 1MB 一个 Range 请求；中途断了（4G 抖一下、模组重拨），
     * 从已经写进 flash 的字节处接着下（续传按字节，不按段），最多重试 8 次。以前一次下完 4MB，
     * 三次升级都在 30%~80% 报 ESP_FAIL、整个作废。服务器 2026-10-04 起支持 Range。
     * 段长实测：64KB 一段要 62 个请求、每个都重新握手，4MB 下了 16 分钟（4KB/s），比一次下完还慢。*/
    esp_https_ota_config_t config = {
        .http_config = &http, .http_client_init_cb = attach_device_key,
        .partial_http_download = true, .max_http_request_size = 1024 * 1024,
    };
    esp_https_ota_handle_t handle = NULL;
    esp_err_t err = ESP_FAIL;
    size_t written = 0;
    int last_reported = -10;
    for (int attempt = 0;; ++attempt) {
        config.ota_resumption = written > 0;
        config.ota_image_bytes_written = written;
        handle = NULL;
        err = esp_https_ota_begin(&config, &handle);
        if (err == ESP_OK && handle) {
            if (attempt == 0) report(progress, ctx, "downloading", 0, NULL);
            while ((err = esp_https_ota_perform(handle)) == ESP_ERR_HTTPS_OTA_IN_PROGRESS) {
                feed_watchdog();
                int done = esp_https_ota_get_image_len_read(handle);
                if (done > 0) written = (size_t)done;
                int pct = (int)((int64_t)done * 100 / offer->size);
                if (pct > 99) pct = 99;              /* 100% 留给校验通过之后 */
                /* 每 10% 报一次：设备走 4G，报太勤等于拿流量刷进度条 */
                if (pct >= last_reported + 10) { last_reported = pct; report(progress, ctx, "downloading", pct, NULL); }
            }
            int done = esp_https_ota_get_image_len_read(handle);
            if (done > 0) written = (size_t)done;
            if (err == ESP_OK && esp_https_ota_is_complete_data_received(handle)) break;
            esp_https_ota_abort(handle);
        }
        if (attempt >= 8) {
            ESP_LOGE(TAG, "下载失败：%s（已重试 %d 次）", esp_err_to_name(err), attempt);
            report(progress, ctx, "failed", last_reported < 0 ? 0 : last_reported, err == ESP_OK ? "下载不完整" : esp_err_to_name(err));
            return false;
        }
        ESP_LOGW(TAG, "下载中断（%s），5 秒后从 %u 字节处接着下（第 %d 次重试）", esp_err_to_name(err), (unsigned)written, attempt + 1);
        vTaskDelay(pdMS_TO_TICKS(5000));
    }

    report(progress, ctx, "verifying", 99, NULL);
    err = esp_https_ota_finish(handle);
    if (err != ESP_OK) {
        report(progress, ctx, "failed", 99, esp_err_to_name(err));
        return false;
    }
    if (!partition_matches(target, offer->size, offer->sha256)) {
        /* 切回原来的分区：宁可停在旧固件上，也不要重启进一个半截的镜像 */
        esp_ota_set_boot_partition(running);
        report(progress, ctx, "failed", 99, "校验不通过，已退回原固件");
        return false;
    }
    report(progress, ctx, "rebooting", 100, NULL);
    ESP_LOGI(TAG, "升级完成，准备重启到 %s", target->label);
    return true;
}

void ota_mark_valid(void)
{
    esp_ota_img_states_t state;
    const esp_partition_t *running = esp_ota_get_running_partition();
    if (esp_ota_get_state_partition(running, &state) != ESP_OK) return;
    if (state != ESP_OTA_IMG_PENDING_VERIFY) return;
    esp_ota_mark_app_valid_cancel_rollback();
    ESP_LOGI(TAG, "新固件 %s 已联网，取消回滚", esp_app_get_description()->version);
}

bool ota_pending_verify(void)
{
    esp_ota_img_states_t state;
    const esp_partition_t *running = esp_ota_get_running_partition();
    if (esp_ota_get_state_partition(running, &state) != ESP_OK) return false;
    return state == ESP_OTA_IMG_PENDING_VERIFY;
}

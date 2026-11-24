#include "cellular_settings.h"
#include "nvs.h"
#include <assert.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

/* A transaction-boundary fake: the actual settings adapter, JSON parser and
 * profile validator run unchanged; only the hardware NVS API is substituted. */
static cellular_profile_t disk, pending;
static bool exists, fail_commit;
static size_t disk_size;
static unsigned commits;
static char logs[8192];
static size_t log_len;
const char *esp_err_to_name(esp_err_t err) { (void)err; return "test-error"; }
void cellular_test_log(const char *tag, const char *format, ...)
{
    (void)tag;
    va_list args; va_start(args, format);
    int n = vsnprintf(logs + log_len, sizeof(logs) - log_len, format, args);
    va_end(args);
    assert(n >= 0 && (size_t)n < sizeof(logs) - log_len);
    log_len += (size_t)n;
}
esp_err_t nvs_open(const char *ns, int mode, nvs_handle_t *handle)
{
    assert(!strcmp(ns, "voxmind")); *handle = 1;
    return !exists && mode == NVS_READONLY ? ESP_ERR_NVS_NOT_FOUND : ESP_OK;
}
esp_err_t nvs_get_blob(nvs_handle_t h, const char *key, void *out, size_t *size)
{
    assert(h == 1 && !strcmp(key, "cellular"));
    if (!exists) return ESP_ERR_NVS_NOT_FOUND;
    if (*size < disk_size) { *size = disk_size; return ESP_ERR_NVS_INVALID_LENGTH; }
    memcpy(out, &disk, disk_size); *size = disk_size;
    return ESP_OK;
}
esp_err_t nvs_set_blob(nvs_handle_t h, const char *key, const void *value, size_t size)
{
    assert(h == 1 && !strcmp(key, "cellular") && size == sizeof(pending));
    memcpy(&pending, value, size); return ESP_OK;
}
esp_err_t nvs_commit(nvs_handle_t h)
{
    assert(h == 1);
    if (fail_commit) return ESP_FAIL;
    disk = pending; exists = true; disk_size = sizeof(disk); ++commits;
    return ESP_OK;
}
void nvs_close(nvs_handle_t h) { assert(h == 1); }

int main(void)
{
    cellular_profile_t p;
    assert(cellular_settings_load(&p) == ESP_OK && !strcmp(p.id, "auto"));
    assert(!cellular_settings_command("setup\tsome-device-key"));
    assert(!cellular_settings_command("cellularx"));
    assert(cellular_settings_command("cellular profile giffgaff"));
    assert(commits == 1 && !strcmp(disk.apn, "giffgaff.com"));
    assert(cellular_settings_load(&p) == ESP_OK && !strcmp(p.id, "giffgaff"));
    assert(cellular_settings_command("cellular set {\"apn\":\"private.apn\",\"auth\":\"pap\",\"username\":\"test-user\",\"password\":\"private-password\"}"));
    assert(commits == 2 && !strcmp(disk.password, "private-password"));
    assert(cellular_settings_command("cellular show"));
    assert(!strstr(logs, "private-password") && !strstr(logs, "test-user"));
    const char *invalid[] = {
        "cellular profile unknown", "cellular profile ee extra",
        "cellular set {\"apn\":\"x\",\"auth\":\"invalid\"}",
        "cellular set {\"apn\":\"x\",\"auth\":\"pap\",\"username\":42}",
        "cellular set {\"apn\":\"x\\rAT+CFUN=0\",\"auth\":\"none\"}",
        "cellular set {\"apn\":\"x\",\"auth\":\"none\"} trailing", "cellular set [1]",
        "cellular set {\"apn\":\"x\",\"auth\":\"none\"",
    };
    for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); ++i) {
        assert(cellular_settings_command(invalid[i])); assert(commits == 2);
    }
    fail_commit = true;
    assert(cellular_settings_command("cellular profile ee"));
    assert(commits == 2 && !strcmp(disk.apn, "private.apn"));
    fail_commit = false;
    assert(cellular_settings_command("cellular auto"));
    assert(commits == 3 && !strcmp(disk.id, "auto"));
    disk.version++;
    assert(cellular_settings_load(&p) == ESP_ERR_INVALID_ARG);
    disk_size = sizeof(disk) - 1;
    assert(cellular_settings_load(&p) == ESP_ERR_INVALID_ARG);
    puts("cellular_settings: persisted selection, JSON validation, failed commit, corrupt records, and credential redaction passed");
}

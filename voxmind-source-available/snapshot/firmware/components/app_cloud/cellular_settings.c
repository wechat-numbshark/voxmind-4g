#include "cellular_settings.h"

#include <stdio.h>
#include <string.h>
#include "cJSON.h"
#include "esp_log.h"
#include "nvs.h"

static const char *TAG = "cellular";

esp_err_t cellular_settings_load(cellular_profile_t *out)
{
    if (!out) return ESP_ERR_INVALID_ARG;
    *out = *cellular_profile_find("auto");
    nvs_handle_t nvs;
    esp_err_t err = nvs_open("voxmind", NVS_READONLY, &nvs);
    if (err == ESP_ERR_NVS_NOT_FOUND) return ESP_OK;
    if (err != ESP_OK) return err;
    cellular_profile_t saved = {0};
    size_t size = sizeof(saved);
    err = nvs_get_blob(nvs, "cellular", &saved, &size);
    nvs_close(nvs);
    if (err == ESP_ERR_NVS_NOT_FOUND) return ESP_OK;
    if (err != ESP_OK) return err;
    if (size != sizeof(saved) || !cellular_profile_valid(&saved)) return ESP_ERR_INVALID_ARG;
    *out = saved;
    return ESP_OK;
}

static bool save_profile(const cellular_profile_t *profile)
{
    if (!cellular_profile_valid(profile)) return false;
    nvs_handle_t nvs;
    esp_err_t err = nvs_open("voxmind", NVS_READWRITE, &nvs);
    if (err == ESP_OK) {
        err = nvs_set_blob(nvs, "cellular", profile, sizeof(*profile));
        if (err == ESP_OK) err = nvs_commit(nvs);
        nvs_close(nvs);
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "保存蜂窝配置失败：%s", esp_err_to_name(err));
        return false;
    }
    ESP_LOGI(TAG, "蜂窝配置 %s 已保存；本次录音继续，下次手动重启后生效（不回显认证信息）", profile->id);
    return true;
}

static bool json_profile(const char *json, cellular_profile_t *out)
{
    cJSON *root = cJSON_ParseWithOpts(json, NULL, true);
    if (!cJSON_IsObject(root)) { cJSON_Delete(root); return false; }
    const cJSON *apn = cJSON_GetObjectItemCaseSensitive(root, "apn");
    const cJSON *auth = cJSON_GetObjectItemCaseSensitive(root, "auth");
    const cJSON *user = cJSON_GetObjectItemCaseSensitive(root, "username");
    const cJSON *pass = cJSON_GetObjectItemCaseSensitive(root, "password");
    bool valid = cJSON_IsString(apn) && cJSON_IsString(auth) &&
        (!user || cJSON_IsString(user)) && (!pass || cJSON_IsString(pass));
    if (valid) valid = cellular_profile_custom(out, apn->valuestring, auth->valuestring,
                                              user ? user->valuestring : "", pass ? pass->valuestring : "");
    cJSON_Delete(root);
    return valid;
}

bool cellular_settings_command(const char *line)
{
    if (!line || strncmp(line, "cellular", 8) || (line[8] && line[8] != ' ')) return false;
    const cellular_profile_t *profile = NULL;
    cellular_profile_t custom;
    if (!strcmp(line, "cellular list")) {
        for (size_t i = 0; i < cellular_profile_count(); ++i) {
            const cellular_profile_t *p = cellular_profile_at(i);
            printf("cellular profile %-14s APN=%s auth=%s\n", p->id,
                   p->apn[0] ? p->apn : "(SIM 自动选择)", cellular_auth_name(p->auth));
        }
        return true;
    }
    if (!strcmp(line, "cellular show")) {
        if (cellular_settings_load(&custom) != ESP_OK)
            ESP_LOGE(TAG, "已存配置无法读取；用 cellular auto 或重新选择配置修复");
        else
            ESP_LOGI(TAG, "已存配置=%s APN=%s auth=%s（下次启动使用；自动模式仅推测归属网络，不能识别所有套餐/MVNO）",
                     custom.id, custom.apn[0] ? custom.apn : "自动", cellular_auth_name(custom.auth));
        return true;
    }
    if (!strcmp(line, "cellular auto")) profile = cellular_profile_find("auto");
    else if (!strncmp(line, "cellular profile ", 17)) profile = cellular_profile_find(line + 17);
    else if (!strncmp(line, "cellular set ", 13) && json_profile(line + 13, &custom)) profile = &custom;
    if (profile) save_profile(profile);
    else ESP_LOGW(TAG, "配置无效。支持 cellular list|show|auto、cellular profile <名称>、cellular set JSON（apn/auth/username/password）；认证可选 none/pap/chap/papchap");
    return true;
}

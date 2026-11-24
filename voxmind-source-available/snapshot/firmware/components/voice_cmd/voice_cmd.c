#include "voice_cmd.h"

#include "esp_log.h"
#include "esp_mn_iface.h"
#include "esp_mn_models.h"
#include "esp_mn_speech_commands.h"
#include "model_path.h"

static const char *TAG = "voice_cmd";

static srmodel_list_t *s_models;
static const esp_mn_iface_t *s_mn;
static model_iface_data_t *s_data;

esp_err_t voice_cmd_start(const char *const phrases[], int count)
{
    if (count <= 0) return ESP_ERR_INVALID_ARG;
    if (!s_models) s_models = esp_srmodel_init("model");
    if (!s_models) { ESP_LOGE(TAG, "找不到 model 分区里的语音模型"); return ESP_ERR_NOT_FOUND; }
    char *name = esp_srmodel_filter(s_models, ESP_MN_PREFIX, ESP_MN_CHINESE);
    if (!name) { ESP_LOGE(TAG, "模型分区里没有中文指令词模型"); return ESP_ERR_NOT_FOUND; }
    s_mn = esp_mn_handle_from_name(name);
    /* 6 秒一个识别窗口；超时后清空重新听，相当于一直在听 */
    s_data = s_mn->create(name, 6000);
    if (!s_data) return ESP_ERR_NO_MEM;
    esp_mn_commands_alloc(s_mn, s_data);
    esp_mn_commands_clear();
    for (int i = 0; i < count; ++i) {
        /* 所有短语都算同一个指令（id 1）：叫一声还是两声都行 */
        if (esp_mn_commands_add(1, phrases[i]) != ESP_OK) ESP_LOGW(TAG, "指令词无效：%s", phrases[i]);
    }
    esp_mn_error_t *err = esp_mn_commands_update();
    if (err && err->num > 0) ESP_LOGW(TAG, "%d 条指令词拼音不被模型支持", err->num);
    ESP_LOGI(TAG, "离线指令词已就绪（%s），共 %d 条", name, count);
    return ESP_OK;
}

int voice_cmd_chunk_samples(void)
{
    return s_mn && s_data ? s_mn->get_samp_chunksize(s_data) : 0;
}

bool voice_cmd_feed(int16_t *samples)
{
    if (!s_mn || !s_data) return false;
    esp_mn_state_t state = s_mn->detect(s_data, samples);
    if (state == ESP_MN_STATE_DETECTED) {
        esp_mn_results_t *r = s_mn->get_results(s_data);
        ESP_LOGW(TAG, "听到指令词 id=%d 置信度=%.2f", r->num > 0 ? r->command_id[0] : -1, r->num > 0 ? r->prob[0] : 0);
        s_mn->clean(s_data);
        return r->num > 0 && r->command_id[0] == 1;
    }
    if (state == ESP_MN_STATE_TIMEOUT) s_mn->clean(s_data);
    return false;
}

void voice_cmd_stop(void)
{
    if (s_mn && s_data) {
        esp_mn_commands_free();
        s_mn->destroy(s_data);
    }
    s_data = NULL;
    s_mn = NULL;
}

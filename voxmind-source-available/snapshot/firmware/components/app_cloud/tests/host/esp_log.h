#pragma once
void cellular_test_log(const char *tag, const char *format, ...);
#define ESP_LOGI(tag, ...) cellular_test_log(tag, __VA_ARGS__)
#define ESP_LOGW(tag, ...) cellular_test_log(tag, __VA_ARGS__)
#define ESP_LOGE(tag, ...) cellular_test_log(tag, __VA_ARGS__)

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* 每连接固定上界，存储由调用者从堆上申请，不扩大网络任务的栈。 */
#define VOXMIND_HTTP_RESPONSE_BYTES (16u * 1024u)
typedef struct {
    char *data;
    size_t capacity;
    size_t length;
    bool overflow;
} voxmind_http_response_t;

static inline void voxmind_response_reset(voxmind_http_response_t *response)
{
    response->length = 0;
    response->overflow = false;
    if (response->data && response->capacity) response->data[0] = '\0';
}

/* 绝不把截断 JSON 当作成功。溢出后保持原缓冲有效且以 NUL 结尾。 */
static inline bool voxmind_response_append(voxmind_http_response_t *response,
                                           const void *data, size_t length)
{
    if (response->overflow) return false;
    if (!response->data || !response->capacity || response->length >= response->capacity ||
        length > response->capacity - response->length - 1) {
        response->overflow = true;
        return false;
    }
    if (length) memcpy(response->data + response->length, data, length);
    response->length += length;
    response->data[response->length] = '\0';
    return true;
}

/* 将有效编码采样累计成秒，避免 32 位采样计数约 74 小时后回绕。 */
static inline void voxmind_recorded_add(volatile uint32_t *seconds, uint32_t *remainder,
                                        uint32_t samples, uint32_t sample_rate)
{
    uint64_t total = (uint64_t)*remainder + samples;
    *seconds += (uint32_t)(total / sample_rate);
    *remainder = (uint32_t)(total % sample_rate);
}

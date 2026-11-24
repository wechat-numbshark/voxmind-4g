#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint32_t magic, generation, boot_id, reset_reason, uptime_ms, stop;
    uint32_t health_ms[3], health_mask, event, detail, checksum;
} diag_record_t;

static inline uint32_t diag_checksum(const diag_record_t *record)
{
    const unsigned char *bytes = (const unsigned char *)record;
    uint32_t hash = 2166136261u;
    for (size_t i = 0; i < offsetof(diag_record_t, checksum); ++i) hash = (hash ^ bytes[i]) * 16777619u;
    return hash;
}
static inline bool diag_valid(const diag_record_t *record)
{
    return record->magic == 0x564d2501u && record->checksum == diag_checksum(record);
}
static inline void diag_seal(diag_record_t *record)
{
    record->magic = 0x564d2501u;
    record->checksum = diag_checksum(record);
}
static inline int diag_latest(const diag_record_t records[2])
{
    if (!diag_valid(&records[0])) return diag_valid(&records[1]) ? 1 : -1;
    if (!diag_valid(&records[1])) return 0;
    return (int32_t)(records[1].generation - records[0].generation) > 0 ? 1 : 0;
}

#include "runtime_diagnostics.h"
#include "diagnostic_record.h"
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include "esp_attr.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"

/* Two checksummed RTC slots survive warm resets, NOT a complete power loss. No
 * flash writes on the UI/recording path; interrupted writes leave the older slot. */
static RTC_NOINIT_ATTR diag_record_t retained[2];
static diag_record_t current, previous;
static int slot;
static bool previous_valid;
static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
static uint32_t now_ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }
static void commit(void)
{
    current.uptime_ms = now_ms();
    ++current.generation;
    diag_seal(&current);
    slot = 1 - slot;
    retained[slot] = current;
}
void runtime_diag_init(uint32_t reset_reason, uint32_t boot_id)
{
    portENTER_CRITICAL(&mux);
    int last = diag_latest(retained);
    previous_valid = last >= 0 && reset_reason != ESP_RST_POWERON && reset_reason != ESP_RST_UNKNOWN;
    if (previous_valid) previous = retained[last];
    else memset(&previous, 0, sizeof(previous));
    memset(&current, 0, sizeof(current));
    current.generation = last >= 0 ? retained[last].generation : 0;
    current.boot_id = boot_id;
    current.reset_reason = reset_reason;
    slot = last >= 0 ? last : 0;
    commit();
    portEXIT_CRITICAL(&mux);
}
void runtime_diag_heartbeat(diag_task_t task)
{
    if (task >= DIAG_TASK_COUNT) return;
    portENTER_CRITICAL(&mux);
    current.health_ms[task] = now_ms();
    current.health_mask |= 1u << task;
    commit();
    portEXIT_CRITICAL(&mux);
}
void runtime_diag_note(diag_event_t event, int32_t detail)
{
    portENTER_CRITICAL(&mux);
    current.event = event;
    current.detail = (uint32_t)detail;
    commit();
    portEXIT_CRITICAL(&mux);
}
void runtime_diag_stop(diag_stop_t reason)
{
    portENTER_CRITICAL(&mux);
    current.stop = reason;
    commit();
    portEXIT_CRITICAL(&mux);
}
static int64_t age(const diag_record_t *r, unsigned task)
{
    return r->health_mask & (1u << task) ? (int64_t)(uint32_t)(r->uptime_ms - r->health_ms[task]) : -1;
}
size_t runtime_diag_json(char *out, size_t capacity)
{
    diag_record_t c, p;
    portENTER_CRITICAL(&mux);
    c = current; p = previous;
    portEXIT_CRITICAL(&mux);
    c.uptime_ms = now_ms();
    int n = snprintf(out, capacity,
        "{\"version\":1,\"bootId\":\"%08" PRIx32 "\",\"resetReason\":%" PRIu32 ",\"retention\":\"rtc_warm_reset_only\","
        "\"previous\":{\"valid\":%s,\"bootId\":\"%08" PRIx32 "\",\"plannedStop\":%" PRIu32 ",\"uptimeMs\":%" PRIu32 ","
        "\"healthAgeMs\":[%" PRId64 ",%" PRId64 ",%" PRId64 "],\"event\":%" PRIu32 ",\"detail\":%" PRId32 "},"
        "\"current\":{\"plannedStop\":%" PRIu32 ",\"uptimeMs\":%" PRIu32 ",\"healthAgeMs\":[%" PRId64 ",%" PRId64 ",%" PRId64 "],"
        "\"event\":%" PRIu32 ",\"detail\":%" PRId32 "}}",
        c.boot_id, c.reset_reason, previous_valid ? "true" : "false", p.boot_id, p.stop, p.uptime_ms,
        age(&p, 0), age(&p, 1), age(&p, 2), p.event, (int32_t)p.detail,
        c.stop, c.uptime_ms, age(&c, 0), age(&c, 1), age(&c, 2), c.event, (int32_t)c.detail);
    if (n < 0 || (size_t)n >= capacity) { if (capacity) out[0] = 0; return 0; }
    return (size_t)n;
}

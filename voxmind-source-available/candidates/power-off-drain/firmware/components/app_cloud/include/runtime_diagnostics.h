#pragma once
#include <stddef.h>
#include <stdint.h>

typedef enum { DIAG_UI, DIAG_ACTION, DIAG_UPLOAD, DIAG_TASK_COUNT } diag_task_t;
typedef enum { DIAG_STOP_NONE, DIAG_STOP_KEY, DIAG_STOP_REMOTE, DIAG_STOP_VOICE,
    DIAG_STOP_SCHEDULE, DIAG_STOP_NETWORK, DIAG_STOP_UART, DIAG_STOP_ROLLBACK,
    DIAG_STOP_OTA, DIAG_STOP_WAKE, DIAG_STOP_CONFIG, DIAG_STOP_BATTERY } diag_stop_t;
typedef enum { DIAG_BOOT, DIAG_TALK, DIAG_HTTP_BEGIN, DIAG_HTTP_END,
    DIAG_RECORD_ERROR, DIAG_UI_STALE, DIAG_OTA_FREEZE } diag_event_t;
void runtime_diag_init(uint32_t reset_reason, uint32_t boot_id);
void runtime_diag_heartbeat(diag_task_t task);
void runtime_diag_note(diag_event_t event, int32_t detail);
void runtime_diag_stop(diag_stop_t reason);
size_t runtime_diag_json(char *out, size_t capacity);
#define RUNTIME_DIAG_JSON_BYTES 768

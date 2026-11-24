#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define UI_STACK_TOP 146
#define UI_STACK_BOTTOM 270
#define UI_STACK_CARD_HEIGHT 54
#define UI_STACK_GAP 8
#define UI_STACK_PLAN_SLOTS 3

typedef struct {
    int y;
    int receipt; /* -1 is the combined battery/network notice. */
} ui_stack_slot_t;

typedef struct {
    int count;
    int receipts;
    ui_stack_slot_t slots[UI_STACK_PLAN_SLOTS];
} ui_stack_plan_t;

/* Make the complete geometry before touching LVGL's deferred layout. */
ui_stack_plan_t ui_stack_plan(bool notice, int receipts, unsigned outline);
uint32_t ui_recorded_since_snapshot(uint32_t cloud_seconds, uint32_t local_baseline,
                                  uint32_t local_seconds);
void ui_copy_utf8(char *dst, size_t capacity, const char *src);

#include "ui_logic.h"

#include <string.h>

ui_stack_plan_t ui_stack_plan(bool notice, int receipts, unsigned outline)
{
    ui_stack_plan_t plan = {0};
    int y = UI_STACK_TOP;
    if (receipts < 0) receipts = 0;
    if (outline > (UI_STACK_BOTTOM - UI_STACK_TOP) / 2) return plan;
    const int outer_height = UI_STACK_CARD_HEIGHT + 2 * (int)outline;
    for (int item = notice ? -1 : 0; item < receipts && plan.count < UI_STACK_PLAN_SLOTS; ++item) {
        if (y + outer_height > UI_STACK_BOTTOM) break;
        plan.slots[plan.count++] = (ui_stack_slot_t){ .y = y + (int)outline, .receipt = item };
        if (item >= 0) ++plan.receipts;
        y += outer_height + UI_STACK_GAP;
    }
    return plan;
}

uint32_t ui_recorded_since_snapshot(uint32_t cloud_seconds, uint32_t local_baseline,
                                  uint32_t local_seconds)
{
    /* A counter restart must not underflow into years of recorded audio. */
    uint32_t delta = local_seconds >= local_baseline ? local_seconds - local_baseline : 0;
    return delta > UINT32_MAX - cloud_seconds ? UINT32_MAX : cloud_seconds + delta;
}

void ui_copy_utf8(char *dst, size_t capacity, const char *src)
{
    if (!capacity) return;
    if (!src) src = "";
    size_t length = strlen(src);
    size_t n = length < capacity - 1 ? length : capacity - 1;
    /* A cut may land inside a multibyte code point; omit that whole point. */
    if (n < length) while (n && ((unsigned char)src[n] & 0xc0) == 0x80) --n;
    memcpy(dst, src, n);
    dst[n] = '\0';
}

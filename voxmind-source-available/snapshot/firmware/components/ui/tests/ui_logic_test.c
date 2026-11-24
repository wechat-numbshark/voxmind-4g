#include "../ui_logic.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void)
{
    for (unsigned outline = 0; outline <= 4; ++outline) {
        for (int notice = 0; notice <= 1; ++notice) {
            for (int receipts = 0; receipts <= 4; ++receipts) {
                ui_stack_plan_t p = ui_stack_plan(notice, receipts, outline);
                int previous_bottom = UI_STACK_TOP - UI_STACK_GAP;
                for (int i = 0; i < p.count; ++i) {
                    int top = p.slots[i].y - (int)outline;
                    int bottom = p.slots[i].y + UI_STACK_CARD_HEIGHT + (int)outline;
                    assert(top >= previous_bottom + UI_STACK_GAP);
                    assert(bottom <= UI_STACK_BOTTOM);
                    assert(p.slots[i].receipt == (notice ? i - 1 : i));
                    previous_bottom = bottom;
                }
                assert(p.receipts <= receipts);
                /* Every shipped theme permits a receipt even with both alerts. */
                if (receipts && outline <= 2) assert(p.receipts >= 1);
            }
        }
    }
    /* Paused recording no longer consumes a separate card. */
    assert(ui_stack_plan(false, 4, 1).receipts == 2);
    assert(ui_stack_plan(true, 4, 1).receipts == 1);
    assert(ui_stack_plan(false, -1, 0).count == 0);

    assert(ui_recorded_since_snapshot(600, 100, 130) == 630);
    assert(ui_recorded_since_snapshot(600, 100, 130) == 630); /* Pause. */
    assert(ui_recorded_since_snapshot(600, 100, 145) == 645); /* Resume. */
    assert(ui_recorded_since_snapshot(600, 100, 0) == 600);
    assert(ui_recorded_since_snapshot(UINT32_MAX - 1, 0, 20) == UINT32_MAX);

    char text[8];
    ui_copy_utf8(text, sizeof(text), "打开空调");
    assert(strcmp(text, "打开") == 0);
    ui_copy_utf8(text, 7, "打开空调");
    assert(strcmp(text, "打开") == 0);
    ui_copy_utf8(text, 3, "空调");
    assert(strcmp(text, "") == 0);
    ui_copy_utf8(text, sizeof(text), NULL);
    assert(strcmp(text, "") == 0);
    puts("ui_logic: layout bounds, pause/resume accounting and UTF-8 boundaries passed");
    return 0;
}

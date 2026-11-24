#include "../include/runtime_protocol.h"
#include "../include/command_runtime.h"
#include "../include/diagnostic_record.h"
#include <assert.h>
#include <stdio.h>

int main(void)
{
    assert(voxmind_command_poll_ms(true, false) == 15000);
    assert(voxmind_command_poll_ms(true, true) == 750);
    assert(voxmind_command_poll_ms(false, false) == 1500);
    assert(voxmind_command_poll_ms(false, true) == 750);
    assert(voxmind_chunk_overlaps(300000, 15000, 302000, 318000));
    assert(voxmind_chunk_overlaps(315000, 3000, 302000, 318000));
    assert(!voxmind_chunk_overlaps(0, 15000, 302000, 318000));
    assert(!voxmind_chunk_overlaps(318000, 15000, 302000, 318000));
    assert(voxmind_chunk_overlaps(UINT32_MAX - 100, 200, UINT32_MAX - 50, UINT32_MAX));
    assert(voxmind_mark_tail_ready(315000, 2940, 318000));
    assert(!voxmind_mark_tail_ready(315000, 2800, 318000));
    diag_record_t records[2] = {0};
    assert(diag_latest(records) == -1);
    records[0].generation = 1; diag_seal(&records[0]);
    assert(diag_latest(records) == 0);
    records[1] = records[0]; records[1].generation = 2; diag_seal(&records[1]);
    assert(diag_latest(records) == 1);
    records[1].boot_id = 4; /* Interrupted/corrupt write falls back to older slot. */
    assert(diag_latest(records) == 0);
    records[0].generation = UINT32_MAX; diag_seal(&records[0]);
    records[1].generation = 0; diag_seal(&records[1]);
    assert(diag_latest(records) == 1);
    char data[8];
    voxmind_http_response_t response = { .data = data, .capacity = sizeof(data) };
    voxmind_response_reset(&response);
    assert(voxmind_response_append(&response, "{\"x\":", 5));
    assert(voxmind_response_append(&response, "1}", 2));
    assert(strcmp(data, "{\"x\":1}") == 0 && response.length == 7);
    assert(!voxmind_response_append(&response, " ", 1));
    assert(response.overflow && data[7] == 0);
    assert(!voxmind_response_append(&response, "", 0));
    voxmind_response_reset(&response);
    assert(!response.overflow && response.length == 0 && data[0] == 0);
    assert(voxmind_response_append(&response, "中文", 6));
    assert(!voxmind_response_append(&response, "字", 3));
    assert(strcmp(data, "中文") == 0);
    voxmind_http_response_t missing = {0};
    assert(!voxmind_response_append(&missing, "x", 1));
    volatile uint32_t seconds = 0;
    uint32_t remainder = 0;
    for (unsigned i = 0; i < 101; ++i) voxmind_recorded_add(&seconds, &remainder, 320, 16000);
    assert(seconds == 2 && remainder == 320);
    /* Pause adds no samples. Crossing the old 32-bit sample limit stays monotonic. */
    seconds = 268435;
    voxmind_recorded_add(&seconds, &remainder, 16000, 16000);
    assert(seconds == 268436 && remainder == 320);
    puts("runtime_protocol: split response, UTF-8 byte overflow, reset, effective recording time passed");
}

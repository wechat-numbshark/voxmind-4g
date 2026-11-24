#pragma once

#include <stdbool.h>
#include <stdint.h>

/* Display policy is deliberately not changed by command scheduling. */
static inline uint32_t voxmind_command_poll_ms(bool screen_off, bool interactive)
{
    if (interactive) return 750u;
    return screen_off ? 15000u : 1500u;
}

/* Half-open time ranges, widened arithmetic avoids wrapping long sessions. */
static inline bool voxmind_chunk_overlaps(uint32_t start, uint32_t duration,
                                          uint32_t mark_start, uint32_t mark_end)
{
    return duration && mark_end > mark_start && start < mark_end &&
           (uint64_t)start + duration > mark_start;
}

static inline bool voxmind_mark_tail_ready(uint32_t start, uint32_t duration, uint32_t end)
{
    /* Codec/frame rounding can put the finalized end a few frames before the mark. */
    return duration && (uint64_t)start + duration + 80u >= end;
}

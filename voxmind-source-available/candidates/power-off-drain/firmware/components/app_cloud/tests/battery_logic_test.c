#include "battery_logic.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>

int main(void)
{
    battery_smooth_t st = BATTERY_SMOOTH_INIT;
    assert(battery_smooth(&st, 54, false, false, 3) == 54);        /* 第一次直接采用 */
    assert(battery_smooth(&st, 51, false, false, 3) == 53);        /* 放电：每次最多降 1% */
    assert(battery_smooth(&st, 51, false, false, 3) == 52);
    assert(battery_smooth(&st, 55, false, false, 3) == 52);        /* 放电时往上跳：先不信 */
    assert(battery_smooth(&st, 53, false, false, 3) == 52);        /* 只差 1%：当抖动，计数清零 */
    assert(battery_smooth(&st, 55, false, false, 3) == 52);
    assert(battery_smooth(&st, 55, false, false, 3) == 52);
    assert(battery_smooth(&st, 55, false, false, 3) == 55);        /* 连续 3 次差 ≥2%：采信 */
    assert(battery_smooth(&st, 57, true, false, 3) == 56);         /* 充电：每次最多升 1% */
    assert(battery_smooth(&st, 50, true, false, 3) == 56);         /* 充电时往下跳：先不信 */
    assert(battery_smooth(&st, 30, false, true, 3) == 30);         /* 重估：直接采用 */
    assert(battery_smooth(&st, 130, false, true, 3) == 100);       /* 夹在 0~100 */
    assert(battery_smooth(&st, -4, false, true, 3) == 0);

    assert(fabs(battery_off_drain_ma(80.0, 70.0, 10.0, 1050) - 10.5) < 1e-9);   /* 10% × 1050mAh / 10h */
    assert(battery_off_drain_ma(80.0, 80.0, 10.0, 1050) < 0);                   /* 没掉 */
    assert(battery_off_drain_ma(80.0, 79.0, 0.5, 1050) < 0);                    /* 不到 1 小时 */
    puts("battery_logic: smoothing direction, jitter, reset, clamp and off-drain current passed");
    return 0;
}

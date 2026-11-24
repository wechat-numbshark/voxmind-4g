#pragma once
#include <stdbool.h>

/* 电池显示与关机掉电换算。纯逻辑、不碰硬件，电脑上就能测（tests/battery_logic_test.c）。*/

/* 显示用的电量：放电时只降不升，充电时只升不降，每次最多走 1%。
 * 电量计在大负载（4G 发射）下会来回抖几个百分点，原样显示就是 54→51→55 这种跳。
 * 反方向的变化连续 against_limit 次、差 2% 以上才采信（比如充电状态判断错了）。
 * reset=true 时直接采用 raw（刚重估过电量）。*/
typedef struct { int shown; int against_n; } battery_smooth_t;
#define BATTERY_SMOOTH_INIT { -1, 0 }
int battery_smooth(battery_smooth_t *st, int raw, bool charging, bool reset, int against_limit);

/* 关机期间的平均电流（mA）：电量从 soc_from 掉到 soc_to，经过 hours 小时。
 * 不到 1 小时、或者电量没掉（电量计分辨率不够）时返回 -1。*/
double battery_off_drain_ma(double soc_from, double soc_to, double hours, int capacity_mah);

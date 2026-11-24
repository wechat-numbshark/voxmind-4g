#include "battery_logic.h"
#include <stdlib.h>

int battery_smooth(battery_smooth_t *st, int raw, bool charging, bool reset, int against_limit)
{
    if (raw < 0) raw = 0;
    if (raw > 100) raw = 100;
    if (st->shown < 0 || reset) { st->shown = raw; st->against_n = 0; return st->shown; }
    if (raw == st->shown) { st->against_n = 0; return st->shown; }
    bool against = charging ? raw < st->shown : raw > st->shown;
    if (!against) { st->shown += raw > st->shown ? 1 : -1; st->against_n = 0; return st->shown; }
    if (abs(raw - st->shown) < 2) { st->against_n = 0; return st->shown; }
    if (++st->against_n >= against_limit) { st->shown = raw; st->against_n = 0; }
    return st->shown;
}

double battery_off_drain_ma(double soc_from, double soc_to, double hours, int capacity_mah)
{
    double drop = soc_from - soc_to;
    if (hours < 1.0 || drop <= 0.0) return -1.0;
    return drop / 100.0 * capacity_mah / hours;
}

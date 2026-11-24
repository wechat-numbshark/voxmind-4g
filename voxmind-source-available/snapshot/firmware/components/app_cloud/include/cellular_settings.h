#pragma once

#include "cellular_profile.h"
#include "esp_err.h"

esp_err_t cellular_settings_load(cellular_profile_t *out);
/* Consumes only cellular commands. Saves settings without interrupting recording. */
bool cellular_settings_command(const char *line);

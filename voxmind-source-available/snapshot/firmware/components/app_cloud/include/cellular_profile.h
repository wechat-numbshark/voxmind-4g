#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Versioned, single-blob NVS record. No IMSI or SIM PIN is stored. */
#define CELLULAR_PROFILE_VERSION 1u
#define CELLULAR_APN_MAX 100
#define CELLULAR_CREDENTIAL_MAX 63
enum { CELLULAR_AUTH_NONE = 0, CELLULAR_AUTH_PAP = 1,
       CELLULAR_AUTH_CHAP = 2, CELLULAR_AUTH_PAP_CHAP = 3 };

typedef struct {
    uint32_t version;
    uint8_t auth;
    char id[24];
    char apn[CELLULAR_APN_MAX + 1];
    char username[CELLULAR_CREDENTIAL_MAX + 1];
    char password[CELLULAR_CREDENTIAL_MAX + 1];
} cellular_profile_t;

size_t cellular_profile_count(void);
const cellular_profile_t *cellular_profile_at(size_t index);
const cellular_profile_t *cellular_profile_find(const char *id);
bool cellular_profile_valid(const cellular_profile_t *profile);
bool cellular_profile_custom(cellular_profile_t *out, const char *apn,
                             const char *auth, const char *username, const char *password);
const char *cellular_auth_name(uint8_t auth);
/* Parses a complete CIMI digit line, never an arbitrary substring/echo/error. */
bool cellular_imsi_plmn(const char *reply, char plmn[6]);
/* Home-SIM PLMN only. A UK result is a network default, not MVNO detection. */
bool cellular_profile_resolve(const cellular_profile_t *saved, const char *plmn,
                              const char *fallback_apn, cellular_profile_t *out,
                              bool *uk_network_default);
/* Query response (+CEREG/+CGREG: <n>,<stat>), home=1 or roaming=5. */
bool cellular_registered(const char *reply, const char *prefix);

#include "cellular_profile.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

#define PROFILE(id_, apn_, user_, pass_, auth_) \
    { .version = CELLULAR_PROFILE_VERSION, .auth = auth_, .id = id_, \
      .apn = apn_, .username = user_, .password = pass_ }

/* Operator sources and plan differences: docs/31_VoxMind_v9英国SIM适配_20261103.md. */
static const cellular_profile_t profiles[] = {
    PROFILE("auto", "", "", "", CELLULAR_AUTH_NONE),
    PROFILE("ee", "everywhere", "eesecure", "secure", CELLULAR_AUTH_PAP),
    PROFILE("o2", "mobile.o2.co.uk", "o2web", "password", CELLULAR_AUTH_PAP),
    PROFILE("o2-payg", "payandgo.o2.co.uk", "o2", "p", CELLULAR_AUTH_PAP_CHAP),
    PROFILE("o2-data", "m-bb.o2.co.uk", "o2bb", "password", CELLULAR_AUTH_PAP),
    PROFILE("vodafone", "wap.vodafone.co.uk", "wap", "wap", CELLULAR_AUTH_NONE),
    PROFILE("vodafone-payg", "pp.vodafone.co.uk", "wap", "wap", CELLULAR_AUTH_NONE),
    PROFILE("vodafone-data", "internet", "web", "web", CELLULAR_AUTH_PAP_CHAP),
    PROFILE("three", "three.co.uk", "", "", CELLULAR_AUTH_NONE),
    PROFILE("three-data", "3internet", "", "", CELLULAR_AUTH_NONE),
    PROFILE("giffgaff", "giffgaff.com", "gg", "p", CELLULAR_AUTH_PAP),
    PROFILE("smarty", "mob.asm.net", "", "", CELLULAR_AUTH_NONE),
    PROFILE("lebara", "uk.lebara.mobi", "wap", "wap", CELLULAR_AUTH_PAP_CHAP),
};

size_t cellular_profile_count(void) { return sizeof(profiles) / sizeof(profiles[0]); }
const cellular_profile_t *cellular_profile_at(size_t index)
{
    return index < cellular_profile_count() ? &profiles[index] : NULL;
}
const cellular_profile_t *cellular_profile_find(const char *id)
{
    if (!id) return NULL;
    for (size_t i = 0; i < cellular_profile_count(); ++i)
        if (strcmp(id, profiles[i].id) == 0) return &profiles[i];
    return NULL;
}

static bool bounded_text(const char *text, size_t capacity)
{
    if (!memchr(text, '\0', capacity)) return false;
    for (const unsigned char *p = (const unsigned char *)text; *p; ++p)
        if (*p < 32 || *p > 126 || *p == '"' || *p == '\\') return false;
    return true;
}

static bool valid_apn(const char *apn)
{
    size_t length = strlen(apn), label = 0;
    if (!length || length > CELLULAR_APN_MAX) return false;
    for (size_t i = 0; i < length; ++i) {
        unsigned char c = (unsigned char)apn[i];
        if (c == '.') {
            if (!label || apn[i - 1] == '-') return false;
            label = 0;
        } else {
            if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                  (c >= '0' && c <= '9') || (c == '-' && label))) return false;
            if (++label > 63) return false;
        }
    }
    return label && apn[length - 1] != '-';
}

bool cellular_profile_valid(const cellular_profile_t *p)
{
    if (!p || p->version != CELLULAR_PROFILE_VERSION || p->auth > CELLULAR_AUTH_PAP_CHAP ||
        !bounded_text(p->id, sizeof(p->id)) || !bounded_text(p->apn, sizeof(p->apn)) ||
        !bounded_text(p->username, sizeof(p->username)) ||
        !bounded_text(p->password, sizeof(p->password))) return false;
    if (strcmp(p->id, "auto") == 0)
        return !p->apn[0] && !p->username[0] && !p->password[0] && p->auth == CELLULAR_AUTH_NONE;
    if (strcmp(p->id, "custom") != 0 && !cellular_profile_find(p->id)) return false;
    return valid_apn(p->apn) && (p->auth == CELLULAR_AUTH_NONE || p->username[0]);
}

const char *cellular_auth_name(uint8_t auth)
{
    static const char *names[] = { "none", "pap", "chap", "papchap" };
    return auth < sizeof(names) / sizeof(names[0]) ? names[auth] : "invalid";
}

bool cellular_profile_custom(cellular_profile_t *out, const char *apn,
                             const char *auth, const char *username, const char *password)
{
    if (!out || !apn || !auth || !username || !password ||
        strlen(apn) > CELLULAR_APN_MAX || strlen(username) > CELLULAR_CREDENTIAL_MAX ||
        strlen(password) > CELLULAR_CREDENTIAL_MAX) return false;
    uint8_t mode = 0;
    while (mode <= CELLULAR_AUTH_PAP_CHAP && strcmp(auth, cellular_auth_name(mode))) ++mode;
    if (mode > CELLULAR_AUTH_PAP_CHAP) return false;
    cellular_profile_t p = PROFILE("custom", "", "", "", mode);
    strcpy(p.apn, apn);
    strcpy(p.username, username);
    strcpy(p.password, password);
    if (!cellular_profile_valid(&p)) return false;
    *out = p;
    return true;
}

bool cellular_imsi_plmn(const char *reply, char plmn[6])
{
    if (!plmn) return false;
    plmn[0] = '\0';
    if (!reply) return false;
    for (const char *line = reply; *line;) {
        while (*line == '\r' || *line == '\n' || *line == ' ' || *line == '\t') ++line;
        const char *end = line;
        while (isdigit((unsigned char)*end)) ++end;
        size_t digits = (size_t)(end - line);
        const char *tail = end;
        while (*tail == ' ' || *tail == '\t') ++tail;
        if ((digits == 14 || digits == 15) && (!*tail || *tail == '\r' || *tail == '\n')) {
            memcpy(plmn, line, 5); plmn[5] = '\0';
            return true;
        }
        while (*line && *line != '\r' && *line != '\n') ++line;
    }
    return false;
}

bool cellular_profile_resolve(const cellular_profile_t *saved, const char *plmn,
                              const char *fallback_apn, cellular_profile_t *out,
                              bool *uk_network_default)
{
    if (uk_network_default) *uk_network_default = false;
    if (!out || !cellular_profile_valid(saved)) return false;
    if (strcmp(saved->id, "auto")) { *out = *saved; return true; }
    static const struct { const char *plmn, *apn; } china[] = {
        {"46000", "cmnet"}, {"46002", "cmnet"}, {"46004", "cmnet"},
        {"46007", "cmnet"}, {"46008", "cmnet"}, {"46013", "cmnet"},
        {"46001", "3gnet"}, {"46006", "3gnet"}, {"46009", "3gnet"}, {"46010", "3gnet"},
        {"46003", "ctnet"}, {"46005", "ctnet"}, {"46011", "ctnet"}, {"46012", "ctnet"},
    };
    if (plmn) {
        for (size_t i = 0; i < sizeof(china) / sizeof(china[0]); ++i)
            if (!strcmp(plmn, china[i].plmn))
                return cellular_profile_custom(out, china[i].apn, "none", "", "");
        static const struct { const char *plmn, *id; } uk[] = {
            {"23430", "ee"}, {"23433", "ee"}, {"23434", "ee"}, {"23486", "ee"},
            {"23402", "o2"}, {"23410", "o2"}, {"23411", "o2"}, {"23415", "vodafone"},
            {"23420", "three"},
        };
        for (size_t i = 0; i < sizeof(uk) / sizeof(uk[0]); ++i)
            if (!strcmp(plmn, uk[i].plmn)) {
                *out = *cellular_profile_find(uk[i].id);
                if (uk_network_default) *uk_network_default = true;
                return true;
            }
        /* Unknown UK / foreign SIM: do not silently attempt China's cmnet. */
        if (plmn[0] && strncmp(plmn, "460", 3)) return false;
    }
    return cellular_profile_custom(out, fallback_apn, "none", "", "");
}

bool cellular_registered(const char *reply, const char *prefix)
{
    if (!reply || !prefix) return false;
    const char *p = strstr(reply, prefix);
    if (!p || (p != reply && p[-1] != '\r' && p[-1] != '\n')) return false;
    p += strlen(prefix);
    while (*p == ' ') ++p;
    if (!isdigit((unsigned char)*p)) return false;
    char *end;
    long mode = strtol(p, &end, 10);
    while (*end == ' ') ++end;
    if (mode > 5 || *end++ != ',') return false;
    while (*end == ' ') ++end;
    if (!isdigit((unsigned char)*end)) return false;
    long status = strtol(end, &end, 10);
    while (*end == ' ') ++end;
    if (*end && *end != ',' && *end != '\r' && *end != '\n') return false;
    return status == 1 || status == 5;
}

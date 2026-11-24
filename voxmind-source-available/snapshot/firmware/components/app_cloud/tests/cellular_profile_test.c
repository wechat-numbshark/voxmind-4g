#include "cellular_profile.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static cellular_profile_t resolve(const char *saved_id, const char *plmn, bool expected_uk)
{
    cellular_profile_t p;
    bool uk = !expected_uk;
    assert(cellular_profile_resolve(cellular_profile_find(saved_id), plmn, "cmnet", &p, &uk));
    assert(uk == expected_uk);
    assert(cellular_profile_valid(&p));
    return p;
}

int main(void)
{
    for (size_t i = 0; i < cellular_profile_count(); ++i)
        assert(cellular_profile_valid(cellular_profile_at(i)));
    assert(!cellular_profile_at(cellular_profile_count()));
    assert(!cellular_profile_find("unknown"));

    const char *mobile[] = {"46000", "46002", "46004", "46007", "46008", "46013"};
    const char *unicom[] = {"46001", "46006", "46009", "46010"};
    const char *telecom[] = {"46003", "46005", "46011", "46012"};
    for (size_t i = 0; i < sizeof(mobile) / sizeof(mobile[0]); ++i) {
        cellular_profile_t p = resolve("auto", mobile[i], false);
        assert(!strcmp(p.apn, "cmnet") && p.auth == CELLULAR_AUTH_NONE);
    }
    for (size_t i = 0; i < sizeof(unicom) / sizeof(unicom[0]); ++i)
        assert(!strcmp(resolve("auto", unicom[i], false).apn, "3gnet"));
    for (size_t i = 0; i < sizeof(telecom) / sizeof(telecom[0]); ++i)
        assert(!strcmp(resolve("auto", telecom[i], false).apn, "ctnet"));
    assert(!strcmp(resolve("auto", "23430", true).apn, "everywhere"));
    assert(!strcmp(resolve("auto", "23410", true).apn, "mobile.o2.co.uk"));
    assert(!strcmp(resolve("auto", "23415", true).apn, "wap.vodafone.co.uk"));
    assert(!strcmp(resolve("auto", "23420", true).apn, "three.co.uk"));
    /* Shared home network IDs do not override explicitly selected SIM brands. */
    assert(!strcmp(resolve("giffgaff", "23410", false).apn, "giffgaff.com"));
    assert(!strcmp(resolve("smarty", "23420", false).apn, "mob.asm.net"));
    assert(!strcmp(resolve("lebara", "23415", false).apn, "uk.lebara.mobi"));
    assert(!strcmp(resolve("o2-payg", "23410", false).apn, "payandgo.o2.co.uk"));
    assert(!strcmp(resolve("vodafone-payg", "23415", false).apn, "pp.vodafone.co.uk"));
    assert(!strcmp(resolve("three-data", "23420", false).apn, "3internet"));
    assert(!strcmp(resolve("o2-data", "23410", false).apn, "m-bb.o2.co.uk"));
    assert(!strcmp(resolve("vodafone-data", "23415", false).apn, "internet"));
    /* Explicit travel/IoT profiles still work outside their home country. */
    assert(!strcmp(resolve("ee", "46003", false).apn, "everywhere"));
    cellular_profile_t p;
    bool uk = true;
    assert(!cellular_profile_resolve(cellular_profile_find("auto"), "23499", "cmnet", &p, &uk));
    assert(!uk);
    assert(!cellular_profile_resolve(cellular_profile_find("auto"), "31026", "cmnet", &p, NULL));
    assert(!strcmp(resolve("auto", NULL, false).apn, "cmnet"));

    char plmn[6];
    assert(cellular_imsi_plmn("AT+CIMI\r\n\r\n234300000000000\r\nOK\r\n", plmn));
    assert(!strcmp(plmn, "23430"));
    assert(cellular_imsi_plmn("\r\n46003123456789\r\nOK", plmn));
    assert(!strcmp(plmn, "46003"));
    const char *bad_imsi[] = {"", "ERROR", "23430", "x234300000000000", "234300000000000x",
                             "2343012345678900", "log: 234300000000000", "AT+CIMI\r\nOK"};
    for (size_t i = 0; i < sizeof(bad_imsi) / sizeof(bad_imsi[0]); ++i) {
        assert(!cellular_imsi_plmn(bad_imsi[i], plmn));
        assert(!plmn[0]);
    }
    assert(cellular_profile_custom(&p, "private.example", "papchap", "test user", "test pass"));
    assert(p.auth == CELLULAR_AUTH_PAP_CHAP);
    assert(!cellular_profile_custom(&p, "apn\"\rAT+CFUN=0", "none", "", ""));
    assert(!cellular_profile_custom(&p, ".apn", "none", "", ""));
    assert(!cellular_profile_custom(&p, "apn..name", "none", "", ""));
    assert(!cellular_profile_custom(&p, "apn-", "none", "", ""));
    assert(!cellular_profile_custom(&p, "apn", "pap", "", ""));
    assert(!cellular_profile_custom(&p, "apn", "invalid", "user", "pass"));
    assert(!cellular_profile_custom(&p, "apn", "pap", "user", "pass\ncommand"));
    char long_text[102]; memset(long_text, 'a', sizeof(long_text)); long_text[101] = 0;
    assert(!cellular_profile_custom(&p, long_text, "none", "", ""));
    assert(!cellular_profile_custom(&p, "apn", "pap", long_text, "pass"));
    p = *cellular_profile_find("ee"); p.version++;
    assert(!cellular_profile_valid(&p));
    p = *cellular_profile_find("ee"); memset(p.password, 'x', sizeof(p.password));
    assert(!cellular_profile_valid(&p));

    assert(cellular_registered("\r\n+CEREG: 0,1\r\nOK", "+CEREG:"));
    assert(cellular_registered("\r\n+CEREG: 2,5,\"0123\",\"12345\",7\r\nOK", "+CEREG:"));
    assert(cellular_registered("+CGREG: 0,5\r\nOK", "+CGREG:"));
    const char *bad_reg[] = {"+CEREG: 0,0", "+CEREG: 0,2", "+CEREG: 0,3",
                            "+CEREG: 0,10", "+CEREG: 0,15", "+CEREG: 0,1x",
                            "+CEREG: 0,-1", "+CEREG: 1", "+CEREG: 9,1", "ERROR",
                            "echo +CEREG: 0,1", "+CGREG: 0,1"};
    for (size_t i = 0; i < sizeof(bad_reg) / sizeof(bad_reg[0]); ++i)
        assert(!cellular_registered(bad_reg[i], "+CEREG:"));
    puts("cellular: CN regression, UK defaults, MVNO/PAYG overrides, roaming, malformed records/input and LTE registration passed");
}

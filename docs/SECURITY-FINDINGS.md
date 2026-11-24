# Security findings (paths only)

Scan date of this import: 2026-11-24. Values are not recorded in this file.

Scope: every file extracted from the software archive and both hardware
archives, including `candidates/power-off-drain` and `patches/`, plus text
inside xlsx, zip member names, PDF byte scans, PNG text chunks, and a
byte scan of the EasyEDA project. No archive member was executed.

Repository: https://github.com/wechat-numbshark/voxmind-4g

The repository is private. This file is not a certificate that a later
public copy is clean. Re-scan the tracked tree before any visibility
change. See the release checklist.

## Removed or replaced before the first content commit

| Path | What was wrong | What replaced it |
| --- | --- | --- |
| `voxmind-source-available/snapshot/firmware/components/app_cloud/Kconfig.projbuild` | Firmware default API base URL was a production hostname on `sslip.io` with a public IPv4 embedded in the name. This was the only remaining `sslip.io` and the only non-loopback public IPv4 in the extract. | `https://EXAMPLE-DEMO-HOST.invalid` |
| `voxmind-source-available/snapshot/docs/25_开放接口.md` | Production web host. | `EXAMPLE-DEMO-HOST.invalid` |
| `voxmind-source-available/snapshot/交接文件_20261002.md` | Production web host, SSH alias, and a zeroed address comment beside that alias. | `EXAMPLE-DEMO-HOST.invalid`; the address comment now says the address was removed |
| `voxmind-source-available/snapshot/docs/21_实现与上线计划.md` | Production SSH alias; a Feishu app id in `cli_` plus 16 hex digits; one sentence that still showed a zeroed public address as if it were the address obtained. | Placeholder host; `cli_example00000000`; the sentence now says the address was removed |
| `voxmind-source-available/snapshot/deploy/deploy-cloud.sh` | Default SSH/deploy host alias. | `EXAMPLE-DEMO-HOST.invalid` |
| `voxmind-source-available/snapshot/deploy/README.md` | Same alias, plus a production Caddy container name. | Placeholder host and `example-caddy` |
| `voxmind-source-available/snapshot/deploy/Caddyfile.snippet` | Earlier substitution had left a malformed host (`voxmind.0.0.0.0.EXAMPLE-DEMO-HOST.invalid`) and the production Caddy name. | `EXAMPLE-DEMO-HOST.invalid` and `example-caddy` |
| `voxmind-source-available/snapshot/README.md` | Same malformed host. | `https://EXAMPLE-DEMO-HOST.invalid` |
| `voxmind-source-available/snapshot/docs/22_明天实板首测_从上电到云端闭环.md` | Same malformed host. | `https://EXAMPLE-DEMO-HOST.invalid` |
| `voxmind-source-available/snapshot/firmware/releases/VoxMind_EVT_V1_PCB1_cloud_lab_20260913/README.md` | Same malformed host. | `https://EXAMPLE-DEMO-HOST.invalid` |
| `voxmind-source-available/patches/power-off-drain/0001-fix-power-4G.patch` | Patch `From:` mailbox at qq.com (6-letter local part, not the display name). | `noreply@example.invalid` |
| `voxmind-source-available/patches/power-off-drain/0002-docs-firmware-record-1.0.27-power.1-single-device-OT.patch` | Same mailbox. | `noreply@example.invalid` |
| `voxmind-source-available/candidates/power-off-drain/cloud/test/device-diagnostics.test.ts` | One quoted `secret` fixture, 14 characters, letters and two hyphens, not `CHANGEME`, found only in this file. The snapshot copy of the same test already used `CHANGEME`. The assertion only checks that the property is stripped. | `fixture-not-a-secret` |
| `voxmind-source-available/snapshot/firmware/components/app_cloud/tests/cellular_profile_test.c` | One 15-digit IMSI, used four times. Prefix is the UK PLMN the test asserts (`23430`); the subscriber tail was high-entropy. It appeared only in this file. | `234300000000000` (same 5-digit PLMN, zero subscriber tail) |

Carrier codes `460xx` were not edited. The test still lists `46000`, `46001`, `46002`, `46003`, and the other China Mobile / Unicom / Telecom prefixes it already used.

`Co-Authored-By` on the two power patches uses `noreply@anthropic.com`. That address was left as model attribution, not a personal mailbox.

## Classified and left in place

| Path or pattern | Classification |
| --- | --- |
| `CHANGEME` left by the earlier redaction | Too short for `DEVICE_API_KEY` / `ADMIN_API_KEY` (minimum 16) and for `passwordProblem` (minimum 10). One identity test used the same fake for the real password and the rejected password. `tools/lark_push_doc.mjs` had a broken string where a replacement ate the next log line. Repaired with obvious fakes already used by the tests (`test-device-key-123456`, `test-admin-key-123456`) and with `fixture-owner-pw`, `fixture-member-pw`, `fixture-wrong-pw`. The preview script uses `preview-owner-pw` and `preview-member-pw`, matching its own header. The diagnostics test still uses `CHANGEME` only as a field that must be stripped. The Feishu upload script again stringifies the response and logs step 2. |
| `EXAMPLE-DEMO-HOST.invalid` | Reserved `.invalid` name (RFC 2606). Not a production host. Malformed leftovers of the earlier `0.0.0.0` plus this name were repaired. |
| `0.0.0.0` in `snapshot/cloud/src/config.ts` and `snapshot/deploy/compose.yml` | Bind-all listen address, not a redacted public address. |
| `demo-voxmind-not-a-real-device` in Kconfig, release notes, `cloud/src/app.ts`, tests, and `cloud/scripts/dev-preview.ts` | Fictional demo id written in place of the former lab default. The second preview id is `demo-voxmind-not-a-real-device-2`. These are not production devices. Do not point this tree at a live device or a production host. |
| `postgres://voxmind:voxmind@127.0.0.1` style default in `cloud/src/config.ts` | Local default, user and password are the same short word. Not a production credential. |
| `Bearer dev-admin-key-change-me` in `cloud/scripts/dev-preview.ts` | Obvious local placeholder. |
| `Bearer test-…` shared by several cloud tests | Test token, identical across those tests, starts with `test`. |
| `cloud/src/security/auth.ts` | Comment names the header shape `admin_api_key`. Not a credential value. |
| `cli_` in `cloud/tools/README_飞书配置.md` | Placeholder whose body is one repeated character. |
| `cli_` in `cloud/test/feishu-user.test.ts` and `cloud/test/expense.test.ts` | Short test tokens. |
| Emails at `voxmind.local`, `example.com`, `company.com` | Fixtures and UI placeholders. |
| `firmware/components/ui/fonts/font_cn_16.c`, `font_cn_24.c`, `font_num_44.c` | Regenerated from hash-checked Noto Sans SC 2.004 subset OTFs. Copyright from each file's name table is in the `.c` header. See `fonts/README.md`. |
| `结构设计_v1_20260830/预览/*.svg` | Thousands of 15-digit runs inside path geometry. Not IMSIs. |
| `VoxMind_EVT_V1_当前设计.eprj2` | A few 11-digit runs sit inside binary records next to hex ids. They are not labeled phone fields. No `sslip.io`, email, or `cli_` plus 16 hex. |
| Manufacturing zip/xlsx/pdf | No path traversal, no symlink members, no email/`sslip.io`/China-mobile-number hits in the xlsx XML or PDF byte scan. |
| `cloud/web/public/assets/voice-flow.png` | 68-byte eXIf chunk, no GPS keyword. `PRODUCT.md` calls it an atmosphere image. |
| Enclosure preview PNGs | tEXt software tag is Matplotlib. |
| `cloud/test/fixtures/speech-zh-16k.pcm` | Not in this tree. Tests generate a deterministic waveform in `cloud/test/fixtures/synthetic-speech.ts`. |
| Board annotation PNGs under `snapshot/交付/实板标注/` | Kept. They are component callouts on the author's board. No silkscreen device serial was visible. No QR or Data Matrix decoded at 1x, 2x, or 4x. Module cans show factory marks that this scan could not read. |

## Not present

No `.env` (examples only), no generated `sdkconfig`, no `node_modules`, no `managed_components`, no build directory, no `.git` inside the archives, no payment or authorization QR document, no SQLite/database file, no private key block, no live cloud token that matched the scanners after the replacements above.

`secret-like` code such as `config.API_KEY` and `process.env` reads remains. Those are field names, not values.

## Single-device OTA record identifiers

`releaseId` in `firmware/releases/v1.0.24`, `v1.0.25`, and `v1.0.26`, `otaReleaseId` in v1.0.24, and `releaseId` in `candidates/power-off-drain/firmware/releases/v1.0.27-power.1` are null. The same values were removed from the v1.0.26 and power-line notes and from `patches/power-off-drain/0002-...patch`. Those identifiers are not repeated in this file. v1.0.24 and v1.0.25 were the same kind of single-device rollout record, so they were cleared in the same pass.

## Published tree

Repository: https://github.com/wechat-numbshark/voxmind-4g

This tree does not contain the former lab device id, an unverified speech recording, or the single-device OTA record identifiers. Those values are not written in this file. The Chinese UI fonts were regenerated from the hash-checked Noto Sans SC 2.004 files named in `fonts/README.md`.

No production host was contacted. No production key was used. No verified WhatsApp or WeChat contact is known. None was invented.

## This source set

The tree is the supplied source set. It is not the original working tree of about 9 GB. Enclosure v2 (about 96.3 MB, 143 files) and the three author videos are still absent. No verified business contact is known. None is invented here.

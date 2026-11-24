# Import manifest

Original Mac project directories were not modified. Nothing in this import
was merged from the power-off-drain line into the v7 snapshot.

## Archives

All three uploads matched the expected byte size and SHA-256 before
extraction. Members were listed before extract. Each archive contained only
regular files. No absolute path, no `..`, no symlink, no hard link.

| Archive | Bytes | SHA-256 | Files |
| --- | ---: | --- | ---: |
| Software slim tar | 16337605 | `308bfed51d408a4d9a2f49eb57ab903cdd01867afc85df7b54ff92ae972cd368` | 345 |
| Hardware part 01, current EasyEDA project | 23352672 | `26f4c9dc967301a7c3dc96b33ff0f4c5e9575e9867b7882c07fa2f6c938fe775` | 1 |
| Hardware part 02, manufacturing and enclosure | 11292275 | `e38128b96fca34937be869773e0b157eab00514d6d8a036a962da657753746a6` | 68 |

Part 01 and part 02 together are the 69-file hardware set. Per-file size
and SHA-256 matched the hardware handoff for all 69 paths. No missing file,
no extra file, no hash mismatch.

The combined hardware package those parts were split from was not attached
again. Its recorded SHA-256, for comparison only, is
`63c5eff699cda6f62949841b223061cb325d0affe50d90ba7945add835eb19d5`
(34640190 bytes). This import checked the parts, not a reassembly of that
original tar.

## Where the bytes landed

```
voxmind-source-available/snapshot/     v7 working snapshot, firmware 1.0.27-uk.1
voxmind-source-available/candidates/power-off-drain/   separate power-off line
voxmind-source-available/patches/      power patches and the v7 uncommitted diff
voxmind-source-available/reports/      prior scan reports (paths and counts)
voxmind-source-available/manifests/    slim software file hashes
voxmind-hardware-extra/snapshot/       EasyEDA project, manufacturing v4–v8 and
                                       the 20260826 pack, enclosure v1
```

Manufacturing v9 (2026-08-30) is inside the software snapshot at
`voxmind-source-available/snapshot/制造文件_v9_20260830/`, because that is
where the software archive already carried it. It was not duplicated into
the hardware tree.

## Preserved lines, not merged

- Snapshot firmware version file: `1.0.27-uk.1` (UK SIM / cellular profile line).
- Power candidate version file: `1.0.27-power.1`.
- `docs/31` means different documents on the two lines. The snapshot file is
  the UK SIM note. The candidate file is the power-drain investigation.
  Both are kept. Neither was copied over the other.
- `patches/power-off-drain/*.patch` were not applied.
- `patches/v7-worktree-uncommitted.diff` was not applied. The snapshot is
  already the v7 working tree the archive exported.

Conflicting files include firmware `app_cloud.c`, modem and power drivers,
`CMakeLists.txt`, `version.txt`, and cloud identity/diagnostics. Applying
the power patches on top of the UK snapshot would be a merge. This import
does not do that.

## Hardware revisions that are present

| Label | Path | Role |
| --- | --- | --- |
| Current EasyEDA project | `voxmind-hardware-extra/snapshot/VoxMind_EVT_V1_当前设计.eprj2` | Part 01. Supplied as the current design file. This import did not diff it against v9 Gerbers. |
| Manufacturing 20260826 | `voxmind-hardware-extra/snapshot/制造文件_20260826/` | Earlier manufacturing pack |
| v4 20260826 | `…/制造文件_v4_20260826/` | Versioned manufacturing pack |
| v5 20260826 | `…/制造文件_v5_20260826/` | Versioned manufacturing pack |
| v6 20260827 | `…/制造文件_v6_20260827/` | Versioned manufacturing pack |
| v7 20260828 | `…/制造文件_v7_20260828/` | Versioned manufacturing pack |
| v8 20260829 | `…/制造文件_v8_20260829/` | v8 README: part swaps, including the modem change to ML307C-GC. Its own text says the PCB PDF and Altium zip were not generated. |
| v9 20260830 | `voxmind-source-available/snapshot/制造文件_v9_20260830/` | v9 README says this pack supersedes v8 and adds level shifters. It states a 4-layer 100×55 mm, 1.6 mm, 1 oz ENIG board. Those figures are quotations from that file, not a new measurement. |
| Enclosure v1 20260830 | `voxmind-hardware-extra/snapshot/结构设计_v1_20260830/` | STEP, STL, print zips, previews, mesh notes |
| Enclosure notes also in the software snapshot | `voxmind-source-available/snapshot/结构设计_v1_20260830/` | Python/markdown/text only. STEP/STL live in the hardware tree. |

Inner zip files (Gerber, pick-and-place, Altium, print zips) were not
extracted into the git tree. Their member names were checked: no absolute
paths, no `..`, no symlink members.

## What this repository is

This git tree is the supplied source set from the software archive and the
two hardware parts. It is not the original working tree of about 9 GB.
The missing pieces below are still missing.

## Explicitly not in this repository

- Enclosure/print project v2. The staging notes describe about 96.3 MB and
  143 files under a `结构设计_v2_20260928` directory. That package was not
  attached. This import does not contain it and does not claim it does.
- The three existing author videos. They were not attached. No video file
  and no demo embed was added.
- `.git` history of the original firmware repo, `.env`, generated
  `sdkconfig`, `managed_components`, `node_modules`, build directories,
  firmware `.bin` images, payment or authorization QR documents, customer
  databases.
- A verified WeChat or WhatsApp contact. None was supplied. No placeholder
  number or account was invented.
- A public demo site. Not created.

## Edits in the published tree

Redactions are listed in `docs/SECURITY-FINDINGS.md`. No power patch was
applied. No source file was reformatted for style.

- The former lab device id is replaced with `demo-voxmind-not-a-real-device`
- The unverified speech PCM file is not included. Tests generate a
  synthetic waveform
- `font_cn_16.c`, `font_cn_24.c`, and `font_num_44.c` were regenerated
  from hash-checked Noto Sans SC 2.004. See `fonts/README.md`
- Single-device OTA release-record identifiers in v1.0.24, v1.0.25,
  v1.0.26, and v1.0.27-power.1 are null
- Annotated board photographs are included after a visual and barcode scan
- `LICENSE.md` is the grant itself. Chinese controls if a translation differs

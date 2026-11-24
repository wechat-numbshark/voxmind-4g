# VoxMind firmware 1.0.26 — single-device test candidate

Built on 2026-10-11 for the ESP32-S3 EVT PCB1 cloud configuration.

Changes relative to 1.0.25:

- Move heartbeat diagnostic JSON buffers (~1.8 KiB) from the 8 KiB action-task stack to static storage. This removes a plausible first-heartbeat stack pressure after OTA; the exact cause of the 1.0.25 rollback is not established.
- Poll device actions every 750 ms only while a voice command is in progress. Normal lit-screen polling stays 1.5 s and idle screen-off polling stays 15 s. Recording tail and confirmation rules are unchanged.
- Reject an unexpectedly truncated heartbeat body before transmission.

Verification so far: host tests with ASan/UBSan passed; ESP-IDF 5.5.1 cloud build and esptool image validation passed. Binary: `firmware/releases/build/1.0.26/voxmind.bin` (ignored build artifact), SHA-256 `a0bf0504a1a472aa035f815d1aa0a5d1c4c580cbc96190e8fe02b9da2298aecd`, 4,039,568 bytes. The target app partition is 5,242,880 bytes.

Deployment state: **single-device OTA confirmed**. The server release-record identifier for that rollout is not in this source set. The device name published here is `demo-voxmind-not-a-real-device`. The device reported download/reboot at 100%, then produced a `1.0.26` heartbeat on 2026-10-11 20:39:21 China time. The server recorded `otaState=done`, no error, and a boot-diagnostics audit entry. The rollout was then changed to `none` to prevent another automatic download. USB serial disconnected during the download, so the new-version boot was verified by heartbeat and diagnostics audit, not by a captured boot console. The 1.0.25 OTA had reached download completion but never produced a new-version heartbeat and reverted to 1.0.24; its exact failure cause remains unproven.

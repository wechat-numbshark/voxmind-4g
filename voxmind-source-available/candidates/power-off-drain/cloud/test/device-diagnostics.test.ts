import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { DeviceHeartbeat } from "../src/identity/types.js";
import { IdentityService } from "../src/services/identity.js";
import { MemoryRepository } from "../src/store/memory.js";

const snapshot = { plannedStop: 0, uptimeMs: 30000, healthAgeMs: [0, 100, 100], event: 3, detail: 200 };
const diagnostics = { version: 1, bootId: "1234abcd", resetReason: 3, retention: "rtc_warm_reset_only",
  previous: { ...snapshot, valid: true, bootId: "1234abce", plannedStop: 5 }, current: snapshot };
describe("bounded authenticated device diagnostics", () => {
  it("accepts old heartbeat and bounded snapshots, strips arbitrary data", () => {
    expect(DeviceHeartbeat.parse({ firmware: "1.0.24" }).diagnostics).toBeUndefined();
    const parsed = DeviceHeartbeat.parse({ diagnostics: { ...diagnostics, secret: "fixture-not-a-secret" } });
    expect(parsed.diagnostics).not.toHaveProperty("secret");
    expect(DeviceHeartbeat.safeParse({ diagnostics: { ...diagnostics, bootId: "unbounded" } }).success).toBe(false);
    expect(DeviceHeartbeat.safeParse({ diagnostics: { ...diagnostics, current: { ...snapshot, healthAgeMs: [1,2,3,4] } } }).success).toBe(false);
  });
  it("accepts the battery report and keeps off-drain evidence in the boot audit", async () => {
    const power = { mv: 3912, crate: -8.1, usb: null, gaugeReset: false, modemSwitch: true,
      offDrain: { hours: 14.2, socFrom: 80.1, socTo: 78.3, mvFrom: 4010, mvTo: 3990, estMa: 1.33, modemCut: true, gaugeReset: false } };
    expect(DeviceHeartbeat.parse({ power: { ...power, extra: 1 } }).power).not.toHaveProperty("extra");
    expect(DeviceHeartbeat.safeParse({ power: { ...power, mv: 99999 } }).success).toBe(false);
    const repository = new MemoryRepository();
    const identity = new IdentityService(repository, loadConfig({ NODE_ENV: "test" }));
    await identity.issueDevice("owner", "test-device", "test");
    await identity.heartbeat("test-device", DeviceHeartbeat.parse({ batteryPct: 78, diagnostics, power }));
    const [boot] = await repository.listAudit(5, { action: "device.boot_diagnostics" });
    expect((boot.detail as { power: typeof power }).power.offDrain?.estMa).toBe(1.33);
  });
  it("stores boot evidence, deduplicates healthy heartbeats, records stale UI and new boot", async () => {
    const repository = new MemoryRepository();
    const identity = new IdentityService(repository, loadConfig({ NODE_ENV: "test" }));
    await identity.issueDevice("owner", "test-device", "test");
    const beat = DeviceHeartbeat.parse({ firmware: "1.0.25", pendingUploads: 7, diagnostics });
    await identity.heartbeat("test-device", beat);
    await identity.heartbeat("test-device", beat);
    expect(await repository.listAudit(20)).toHaveLength(1);
    await identity.heartbeat("test-device", DeviceHeartbeat.parse({ diagnostics: { ...diagnostics,
      current: { ...snapshot, healthAgeMs: [45000, 100, 100] } } }));
    expect(await repository.listAudit(20)).toHaveLength(2);
    await identity.heartbeat("test-device", DeviceHeartbeat.parse({ diagnostics: { ...diagnostics, bootId: "1234abcf" } }));
    expect(await repository.listAudit(20)).toHaveLength(3);
    expect((await repository.listAudit(20, { action: "device.boot_diagnostics" }))).toHaveLength(2);
  });
});

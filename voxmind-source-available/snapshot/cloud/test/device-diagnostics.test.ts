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
    const parsed = DeviceHeartbeat.parse({ diagnostics: { ...diagnostics, secret: "CHANGEME" } });
    expect(parsed.diagnostics).not.toHaveProperty("secret");
    expect(DeviceHeartbeat.safeParse({ diagnostics: { ...diagnostics, bootId: "unbounded" } }).success).toBe(false);
    expect(DeviceHeartbeat.safeParse({ diagnostics: { ...diagnostics, current: { ...snapshot, healthAgeMs: [1,2,3,4] } } }).success).toBe(false);
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

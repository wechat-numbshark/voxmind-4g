import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MockToolExecutor } from "../src/connectors/mock.js";
import { readFirmwareImage } from "../src/ota/image.js";
import { FileObjectStore } from "../src/storage/file-store.js";
import { MemoryRepository } from "../src/store/memory.js";

/* 远程升级。设备戴在用户身上，刷错一版就得把人约回来，所以这里盯的是：
 * 版本号只能来自镜像本身、别的工程的固件收不进来、只推给挑中的那台、
 * 失败之后不会拿 4G 流量反复下同一个坏包。*/

const ADMIN_KEY = "test-admin-key-123456";

/** 造一个最小的 ESP32 app 镜像：0xE9 + esp_app_desc_t（偏移 0x20） */
function fakeImage(version: string, project = "voxmind", size = 4096) {
  const bin = Buffer.alloc(size);
  bin[0] = 0xe9;
  bin.writeUInt32LE(0xabcd5432, 0x20);
  bin.write(version, 0x30, "utf8");
  bin.write(project, 0x50, "utf8");
  bin.write("14:40:02", 0x70, "utf8");
  bin.write("Sep 19 2026", 0x80, "utf8");
  bin.write("v5.5.1", 0x90, "utf8");
  bin.write(version, size - 32, "utf8");   // 尾部也写一份，验证整个文件原样下发
  return bin;
}

describe("固件与远程升级", () => {
  let dir: string;
  let repository: MemoryRepository;
  let app: Awaited<ReturnType<typeof createApp>>;
  const admin = { authorization: `Bearer ${ADMIN_KEY}` };
  let deviceKey = "";
  let otherKey = "";

  async function upload(bin: Buffer, notes = "") {
    return app.inject({ method: "POST", url: `/v1/admin/firmware?notes=${encodeURIComponent(notes)}`,
      headers: { ...admin, "content-type": "application/octet-stream" }, payload: bin });
  }
  async function heartbeat(key: string, body: Record<string, unknown> = {}) {
    const r = await app.inject({ method: "POST", url: "/v1/device-heartbeat",
      headers: { "x-device-key": key }, payload: body });
    expect(r.statusCode).toBe(200);
    return r.json() as { ota: { releaseId: string; version: string; sha256: string; url: string } | null };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "voxmind-ota-"));
    repository = new MemoryRepository();
    app = await createApp({
      config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: "test-device-key-123456", ADMIN_API_KEY: ADMIN_KEY,
        AUDIO_STORAGE_DIR: dir, BOOTSTRAP_ADMIN_PASSWORD: "fixture-owner-pw",
        PUBLIC_BASE_URL: "https://voxmind.example" }),
      repository, objects: new FileObjectStore(dir), executor: new MockToolExecutor(),
    });
    for (const [id, target] of [["evt-a", "a"], ["evt-b", "b"]] as const) {
      const r = await app.inject({ method: "POST", url: "/v1/devices", headers: admin,
        payload: { id, name: id, userId: "owner" } });
      expect(r.statusCode).toBe(201);
      if (target === "a") deviceKey = r.json().key; else otherKey = r.json().key;
    }
  });

  afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  it("版本号从镜像里读，不是人填的", async () => {
    const r = await upload(fakeImage("v7.1.0"), "修了唤醒词误触发");
    expect(r.statusCode).toBe(201);
    expect(r.json().release).toMatchObject({ version: "v7.1.0", project: "voxmind", idfVersion: "v5.5.1",
      rollout: "none", notes: "修了唤醒词误触发" });
  });

  it("不是 ESP32 镜像、或者是别的工程的，一律拒收", async () => {
    expect((await upload(Buffer.alloc(8192))).statusCode).toBe(400);            // 全是 0，没有 0xE9
    expect((await upload(Buffer.from("hello world"))).statusCode).toBe(400);    // 太小
    const wrong = await upload(fakeImage("v1.0", "someone-else"));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toContain("someone-else");
  });

  it("同一个文件传两次只留一份", async () => {
    const bin = fakeImage("v7.1.0");
    expect((await upload(bin)).statusCode).toBe(201);
    expect((await upload(bin)).statusCode).toBe(409);
  });

  it("传上来默认不推给任何设备", async () => {
    await upload(fakeImage("v7.1.0"));
    expect((await heartbeat(deviceKey)).ota).toBeNull();
  });

  it("只推给挑中的那台；别的设备收不到", async () => {
    const release = (await upload(fakeImage("v7.1.0"))).json().release;
    const patch = await app.inject({ method: "PATCH", url: `/v1/admin/firmware/${release.id}`, headers: admin,
      payload: { rollout: "devices", deviceIds: ["evt-a"] } });
    expect(patch.statusCode).toBe(200);

    const offer = (await heartbeat(deviceKey)).ota;
    expect(offer).toMatchObject({ version: "v7.1.0", url: `https://voxmind.example/v1/device-firmware/${release.id}` });
    expect((await heartbeat(otherKey)).ota).toBeNull();
  });

  it("已经是这一版的设备不会被反复推", async () => {
    const release = (await upload(fakeImage("v7.1.0"))).json().release;
    await app.inject({ method: "PATCH", url: `/v1/admin/firmware/${release.id}`, headers: admin,
      payload: { rollout: "all", deviceIds: [] } });
    expect((await heartbeat(deviceKey, { firmware: "v7.0.0" })).ota).not.toBeNull();
    expect((await heartbeat(deviceKey, { firmware: "v7.1.0" })).ota).toBeNull();
  });

  it("刷失败之后先晾着，不拿 4G 流量反复下同一个坏包", async () => {
    const release = (await upload(fakeImage("v7.1.0"))).json().release;
    await app.inject({ method: "PATCH", url: `/v1/admin/firmware/${release.id}`, headers: admin,
      payload: { rollout: "all", deviceIds: [] } });
    const report = await app.inject({ method: "POST", url: "/v1/device-ota",
      headers: { "x-device-key": deviceKey },
      payload: { releaseId: release.id, state: "failed", progressPct: 37, error: "下载中断" } });
    expect(report.statusCode).toBe(200);
    expect((await heartbeat(deviceKey)).ota).toBeNull();

    // 管理端能看见卡在哪一步
    const list = await app.inject({ method: "GET", url: "/v1/admin/firmware", headers: admin });
    expect(list.json().devices.find((d: { id: string }) => d.id === "evt-a"))
      .toMatchObject({ otaState: "failed", otaProgressPct: 37, otaError: "下载中断" });

    // 晾够 30 分钟再推
    await repository.updateDevice("evt-a", { otaUpdatedAt: new Date(Date.now() - 31 * 60_000).toISOString() });
    expect((await heartbeat(deviceKey)).ota).not.toBeNull();
  });

  it("固件要设备密钥才能下，下到的就是传上去的那个文件", async () => {
    const bin = fakeImage("v7.1.0");
    const release = (await upload(bin)).json().release;
    const anonymous = await app.inject({ method: "GET", url: `/v1/device-firmware/${release.id}` });
    expect(anonymous.statusCode).toBe(401);

    const r = await app.inject({ method: "GET", url: `/v1/device-firmware/${release.id}`,
      headers: { "x-device-key": deviceKey } });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.length).toBe(bin.length);
    expect(createHash("sha256").update(r.rawPayload).digest("hex")).toBe(release.sha256);
    expect(readFirmwareImage(r.rawPayload).version).toBe("v7.1.0");
  });

  it("分段下载：Range 请求只给那一段，拼起来和原文件一样", async () => {
    const bin = fakeImage("v7.1.0");
    const release = (await upload(bin)).json().release;
    const get = (range: string) => app.inject({ method: "GET", url: `/v1/device-firmware/${release.id}`,
      headers: { "x-device-key": deviceKey, range } });
    const mid = Math.floor(bin.length / 2);
    const a = await get(`bytes=0-${mid - 1}`);
    const b = await get(`bytes=${mid}-`);
    expect(a.statusCode).toBe(206);
    expect(a.headers["content-range"]).toBe(`bytes 0-${mid - 1}/${bin.length}`);
    expect(b.statusCode).toBe(206);
    expect(Buffer.concat([a.rawPayload, b.rawPayload]).equals(bin)).toBe(true);
    expect((await get(`bytes=${bin.length}-`)).statusCode).toBe(416);
  });

  it("还在推的版本删不掉", async () => {
    const release = (await upload(fakeImage("v7.1.0"))).json().release;
    await app.inject({ method: "PATCH", url: `/v1/admin/firmware/${release.id}`, headers: admin,
      payload: { rollout: "all", deviceIds: [] } });
    expect((await app.inject({ method: "DELETE", url: `/v1/admin/firmware/${release.id}`, headers: admin })).statusCode).toBe(409);

    await app.inject({ method: "PATCH", url: `/v1/admin/firmware/${release.id}`, headers: admin,
      payload: { rollout: "none", deviceIds: [] } });
    expect((await app.inject({ method: "DELETE", url: `/v1/admin/firmware/${release.id}`, headers: admin })).statusCode).toBe(200);
    expect((await heartbeat(deviceKey)).ota).toBeNull();
  });

  it("普通成员碰不了固件", async () => {
    await app.inject({ method: "POST", url: "/v1/users", headers: admin,
      payload: { email: "m@voxmind.local", displayName: "成员", password: "fixture-member-pw", role: "member" } });
    const login = await app.inject({ method: "POST", url: "/v1/auth/login",
      payload: { email: "m@voxmind.local", password: "fixture-member-pw" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    expect((await app.inject({ method: "GET", url: "/v1/admin/firmware", headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/admin/firmware", headers: { cookie, "content-type": "application/octet-stream" },
      payload: fakeImage("v9.9.9") })).statusCode).toBe(403);
  });
  it("重启后心跳版本对上才算升级成功；对不上说明回滚了", async () => {
    const release = (await upload(fakeImage("v7.1.0"))).json().release;
    await app.inject({ method: "PATCH", url: `/v1/admin/firmware/${release.id}`, headers: admin,
      payload: { rollout: "all", deviceIds: [] } });
    const rebooting = { releaseId: release.id, state: "rebooting", progressPct: 100 };
    await app.inject({ method: "POST", url: "/v1/device-ota", headers: { "x-device-key": deviceKey }, payload: rebooting });
    await heartbeat(deviceKey, { firmware: "v7.1.0" });
    expect(await repository.getDevice("evt-a")).toMatchObject({ otaState: "done", firmware: "v7.1.0" });

    await app.inject({ method: "POST", url: "/v1/device-ota", headers: { "x-device-key": otherKey }, payload: rebooting });
    await heartbeat(otherKey, { firmware: "v7.0.0" });
    expect(await repository.getDevice("evt-b")).toMatchObject({ otaState: "failed" });
  });
  it("不降级：设备已经跑着更新的版本，就不推旧版", async () => {
    const release = (await upload(fakeImage("0.8.1"))).json().release;
    await app.inject({ method: "PATCH", url: `/v1/admin/firmware/${release.id}`, headers: admin,
      payload: { rollout: "all", deviceIds: [] } });
    expect((await heartbeat(deviceKey, { firmware: "0.9.0" })).ota).toBeNull();
    expect((await heartbeat(deviceKey, { firmware: "0.8.0" })).ota).not.toBeNull();
    // 老设备报的是 git 短哈希，分不出新旧：照旧推
    expect((await heartbeat(deviceKey, { firmware: "ceedcc7" })).ota).not.toBeNull();
  });

  it("推给全部时先只给一台；它用新版本回来之前，别的设备不下载", async () => {
    const release = (await upload(fakeImage("0.9.5"))).json().release;
    await app.inject({ method: "PATCH", url: `/v1/admin/firmware/${release.id}`, headers: admin,
      payload: { rollout: "all", deviceIds: [] } });
    expect((await heartbeat(deviceKey, { firmware: "0.9.4" })).ota).not.toBeNull();
    expect((await heartbeat(otherKey, { firmware: "0.9.4" })).ota).toBeNull();
    // 先头那台升上去了，别的才开始
    await app.inject({ method: "POST", url: "/v1/device-ota", headers: { "x-device-key": deviceKey },
      payload: { releaseId: release.id, state: "rebooting", progressPct: 100 } });
    await heartbeat(deviceKey, { firmware: "0.9.5" });
    expect((await heartbeat(otherKey, { firmware: "0.9.4" })).ota).not.toBeNull();
  });

  it("升完 10 分钟没回来：自动停推这一版；它后来用新版回来了，改回成功", async () => {
    const release = (await upload(fakeImage("0.9.6"))).json().release;
    await app.inject({ method: "PATCH", url: `/v1/admin/firmware/${release.id}`, headers: admin,
      payload: { rollout: "all", deviceIds: [] } });
    await heartbeat(deviceKey, { firmware: "0.9.4" });
    await app.inject({ method: "POST", url: "/v1/device-ota", headers: { "x-device-key": deviceKey },
      payload: { releaseId: release.id, state: "rebooting", progressPct: 100 } });
    const { OtaService } = await import("../src/services/ota.js");
    const watch = new OtaService(repository, new FileObjectStore(dir), "https://voxmind.example");
    expect(await watch.watchdog(Date.now() + 5 * 60_000)).toEqual([]);          // 5 分钟：还在等
    const stopped = await watch.watchdog(Date.now() + 11 * 60_000);
    expect(stopped).toMatchObject([{ deviceId: "evt-a", version: "0.9.6" }]);
    expect((await repository.getFirmware(release.id))?.rollout).toBe("none");
    expect(await repository.getDevice("evt-a")).toMatchObject({ otaState: "failed" });
    expect((await heartbeat(otherKey, { firmware: "0.9.4" })).ota).toBeNull();   // 别的设备不会再拿到
    await heartbeat(deviceKey, { firmware: "0.9.6" });
    expect(await repository.getDevice("evt-a")).toMatchObject({ otaState: "done" });
  });

  it("升级失败后设备换上了更新的版本：失败状态自动清掉，不再报警", async () => {
    const release = (await upload(fakeImage("0.9.7"))).json().release;
    await app.inject({ method: "PATCH", url: `/v1/admin/firmware/${release.id}`, headers: admin, payload: { rollout: "all", deviceIds: [] } });
    await app.inject({ method: "POST", url: "/v1/device-ota", headers: { "x-device-key": deviceKey },
      payload: { releaseId: release.id, state: "rebooting", progressPct: 100 } });
    await heartbeat(deviceKey, { firmware: "0.9.6" });
    expect(await repository.getDevice("evt-a")).toMatchObject({ otaState: "failed" });
    await heartbeat(deviceKey, { firmware: "0.9.8" });
    expect(await repository.getDevice("evt-a")).toMatchObject({ otaState: "idle", otaError: null });
  });
});

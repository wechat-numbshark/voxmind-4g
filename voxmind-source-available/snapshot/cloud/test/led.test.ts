import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MockToolExecutor } from "../src/connectors/mock.js";
import { MemoryRepository } from "../src/store/memory.js";

/* 指示灯三档只能由管理员改：录音灯是对旁人的告知，关不关是部署方的决定，
 * 不能让戴设备的人自己悄悄关掉。设备从心跳配置里拿到这一档。*/

const ADMIN_KEY = "test-admin-key-123456";

describe("指示灯设置", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  const admin = { authorization: `Bearer ${ADMIN_KEY}` };

  beforeEach(async () => {
    app = await createApp({
      config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: "test-device-key-123456", ADMIN_API_KEY: ADMIN_KEY,
        BOOTSTRAP_ADMIN_PASSWORD: "fixture-owner-pw" }),
      repository: new MemoryRepository(), executor: new MockToolExecutor(),
    });
  });
  afterEach(async () => { await app.close(); });

  it("默认按状态变色；管理员改了，设备配置里跟着变", async () => {
    const before = await app.inject({ method: "GET", url: "/v1/device-config", headers: { "x-device-key": "test-device-key-123456" } });
    expect(before.json().ledMode).toBe("designed");
    const put = await app.inject({ method: "PUT", url: "/v1/settings", headers: admin, payload: { ledMode: "dark_while_recording" } });
    expect(put.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/v1/device-config", headers: { "x-device-key": "test-device-key-123456" } });
    expect(after.json().ledMode).toBe("dark_while_recording");
  });

  it("成员改不了指示灯，但带着原值保存其他设置不受影响", async () => {
    await app.inject({ method: "POST", url: "/v1/users", headers: admin,
      payload: { email: "m@voxmind.local", displayName: "成员", password: "fixture-member-pw", role: "member" } });
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "m@voxmind.local", password: "fixture-member-pw" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const denied = await app.inject({ method: "PUT", url: "/v1/settings", headers: { cookie }, payload: { ledMode: "off" } });
    expect(denied.statusCode).toBe(403);
    const same = await app.inject({ method: "PUT", url: "/v1/settings", headers: { cookie }, payload: { ledMode: "designed", retentionDays: 30 } });
    expect(same.statusCode).toBe(200);
    expect(same.json().settings).toMatchObject({ ledMode: "designed", retentionDays: 30 });
  });
});

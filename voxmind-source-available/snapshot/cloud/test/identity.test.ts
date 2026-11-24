import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { FileObjectStore } from "../src/storage/file-store.js";
import { MemoryRepository } from "../src/store/memory.js";
import { MockToolExecutor } from "../src/connectors/mock.js";

/* 这组测试盯的是一件事：一个普通成员绝对不能读到别人的录音和卡片。
 * 改这一层之前，userId 是 URL 查询参数——加个 ?userId=别人 就全看见了。
 * 所以这里不测"登录能不能成功"，而是测"越权会不会被挡住"。*/

const DEVICE_KEY = "test-device-key-123456";
const ADMIN_KEY = "test-admin-key-123456";
const OWNER_PASSWORD = "fixture-owner-pw";

describe("账号隔离与登录", () => {
  let dir: string;
  let repository: MemoryRepository;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "voxmind-identity-"));
    repository = new MemoryRepository();
    app = await createApp({
      config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: DEVICE_KEY, ADMIN_API_KEY: ADMIN_KEY,
        AUDIO_STORAGE_DIR: dir, BOOTSTRAP_ADMIN_PASSWORD: OWNER_PASSWORD }),
      repository,
      objects: new FileObjectStore(dir),
      executor: new MockToolExecutor(),
    });
  });

  afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  /** 登录并拿回 cookie 头，后续请求直接带上 */
  async function login(email: string, password: string) {
    const response = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
    expect(response.statusCode, response.body).toBe(200);
    const cookie = String(response.headers["set-cookie"]).split(";")[0]!;
    return { cookie };
  }

  async function createMember(email: string, password: string) {
    const created = await app.inject({ method: "POST", url: "/v1/users",
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { email, displayName: email, password, role: "member" } });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().user as { id: string };
  }

  it("库里没人时自动建出初始管理员，并且能用它登录", async () => {
    const { cookie } = await login("owner@voxmind.local", OWNER_PASSWORD);
    const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.role).toBe("admin");
    // 首个管理员必须是 "owner"，否则历史录音的 user_id 认不回来
    expect(me.json().user.id).toBe("owner");
  });

  it("密码错了不给登录", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/auth/login",
      payload: { email: "owner@voxmind.local", password: "fixture-wrong-pw" } });
    expect(response.statusCode).toBe(401);
  });

  it("没登录的请求一律 401", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/sessions" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/auth/me" })).statusCode).toBe(401);
  });

  it("成员加 ?userId= 也读不到别人的录音", async () => {
    await createMember("member@voxmind.local", "member-pw-123456");
    const member = await login("member@voxmind.local", "member-pw-123456");

    // owner 名下有一段录音
    const session = await app.inject({ method: "POST", url: "/v1/device-sessions",
      headers: { "x-device-key": DEVICE_KEY }, payload: { deviceId: "demo-voxmind-not-a-real-device", userId: "owner" } });
    expect(session.statusCode).toBe(201);
    const sessionId = session.json().session.id as string;

    // 列表里看不到
    const list = await app.inject({ method: "GET", url: "/v1/sessions?userId=owner", headers: { cookie: member.cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().sessions).toHaveLength(0);

    // 直接拿 id 去查时间线也不行，而且回 404 不回 403——不泄露这个 id 是否存在
    const timeline = await app.inject({ method: "GET", url: `/v1/sessions/${sessionId}/timeline`,
      headers: { cookie: member.cookie } });
    expect(timeline.statusCode).toBe(404);
  });

  it("成员碰不到用户管理和审计日志", async () => {
    await createMember("member2@voxmind.local", "member-pw-123456");
    const member = await login("member2@voxmind.local", "member-pw-123456");
    expect((await app.inject({ method: "GET", url: "/v1/users", headers: { cookie: member.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/audit", headers: { cookie: member.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/devices", headers: { cookie: member.cookie },
      payload: { id: "x", name: "x" } })).statusCode).toBe(403);
  });

  it("管理员能看别人的，但要显式指定 userId", async () => {
    const owner = await login("owner@voxmind.local", OWNER_PASSWORD);
    const member = await createMember("member3@voxmind.local", "member-pw-123456");
    const list = await app.inject({ method: "GET", url: `/v1/sessions?userId=${member.id}`, headers: { cookie: owner.cookie } });
    expect(list.statusCode).toBe(200);
  });

  it("发出去的设备密钥能用来鉴权，吊销后立刻失效", async () => {
    const issued = await app.inject({ method: "POST", url: "/v1/devices",
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { id: "evt-v9-002", name: "二号机", userId: "owner" } });
    expect(issued.statusCode, issued.body).toBe(201);
    const key = issued.json().key as string;
    // 明文密钥只在这一次响应里出现，列表里只剩前缀
    expect(key).toMatch(/^vmd_/);
    const listed = await app.inject({ method: "GET", url: "/v1/devices", headers: { authorization: `Bearer ${ADMIN_KEY}` } });
    expect(JSON.stringify(listed.json())).not.toContain(key);

    const ok = await app.inject({ method: "POST", url: "/v1/device-sessions",
      headers: { "x-device-key": key }, payload: { deviceId: "evt-v9-002", userId: "owner" } });
    expect(ok.statusCode).toBe(201);

    await app.inject({ method: "POST", url: "/v1/devices/evt-v9-002/revoke",
      headers: { authorization: `Bearer ${ADMIN_KEY}` } });
    const afterRevoke = await app.inject({ method: "POST", url: "/v1/device-sessions",
      headers: { "x-device-key": key }, payload: { deviceId: "evt-v9-002", userId: "owner" } });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it("退出登录后 cookie 立刻失效", async () => {
    const { cookie } = await login("owner@voxmind.local", OWNER_PASSWORD);
    await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { cookie } });
    expect((await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } })).statusCode).toBe(401);
  });

  it("确认卡片会留下审计记录", async () => {
    const owner = await login("owner@voxmind.local", OWNER_PASSWORD);
    const session = await app.inject({ method: "POST", url: "/v1/device-sessions",
      headers: { "x-device-key": DEVICE_KEY }, payload: { deviceId: "demo-voxmind-not-a-real-device", userId: "owner" } });
    const sessionId = session.json().session.id as string;
    const draft = await app.inject({ method: "POST", url: "/v1/action-drafts", headers: { cookie: owner.cookie },
      payload: { sessionId, userId: "owner", tool: "feishu.message.send", title: "发消息",
        args: {}, confidence: 0.9, mode: "explicit", risk: "external_write" } });
    expect(draft.statusCode, draft.body).toBe(201);
    const draftId = draft.json().draft.id as string;

    await app.inject({ method: "POST", url: `/v1/action-drafts/${draftId}/confirm`, headers: { cookie: owner.cookie } });
    const audit = await app.inject({ method: "GET", url: "/v1/audit?action=draft.confirm",
      headers: { cookie: owner.cookie } });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().entries[0]).toMatchObject({ action: "draft.confirm", targetId: draftId, actorId: "owner" });
  });
});

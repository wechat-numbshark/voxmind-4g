import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MockToolExecutor } from "../src/connectors/mock.js";
import { ActionService } from "../src/services/actions.js";
import { checkChanges, TOOL_NAMES } from "../src/services/settings-tool.js";
import { FileObjectStore } from "../src/storage/file-store.js";
import { MemoryRepository } from "../src/store/memory.js";

/* 用说话 / 聊天改设置：只认清单里的项，取值不对的丢掉；放宽确认的一律等人点头 */

const ADMIN = { authorization: "Bearer test-admin-key-123456" };

describe("改设置这个动作", () => {
  it("只认清单里的项，取值不合法的挑出来，念给人听的一句话写清楚", () => {
    const r = checkChanges([
      { key: "screenOffSec", value: 30 },
      { key: "theme", value: "dopamine" },
      { key: "screenOffSec", value: 99999 },
      { key: "launchRocket", value: true },
    ], TOOL_NAMES);
    expect(r.ok).toEqual([{ key: "screenOffSec", value: 30 }, { key: "theme", value: "dopamine" }]);
    expect(r.summary).toBe("熄屏时间：30 秒；屏幕主题：多巴胺");
    expect(r.errors).toHaveLength(2);
    expect(r.loosens).toBe(false);
  });

  it("把某类动作改成不用问，算放宽；改成每次都问不算", () => {
    expect(checkChanges([{ key: "rule", value: { tool: "feishu.message.send", confirmation: "never" } }], TOOL_NAMES).loosens).toBe(true);
    expect(checkChanges([{ key: "rule", value: { tool: "feishu.message.send", confirmation: "always" } }], TOOL_NAMES).loosens).toBe(false);
    expect(checkChanges([{ key: "rule", value: { tool: "no.such.tool", confirmation: "always" } }], TOOL_NAMES).ok).toEqual([]);
  });

  it("放宽确认的卡片不管规则怎么设都先等人点头", async () => {
    const repo = new MemoryRepository();
    const actions = new ActionService(repo);
    const base = { sessionId: randomUUID(), userId: "owner", tool: "settings.update", title: "改设置", args: {},
      confidence: 1, mode: "explicit" as const, risk: "personal_write" as const };
    expect((await actions.createDraft(base)).status).toBe("confirmed");
    expect((await actions.createDraft({ ...base, args: { x: 1 }, forceConfirm: true })).status).toBe("pending");
  });

  describe("执行", () => {
    let dir: string;
    let repository: MemoryRepository;
    let app: Awaited<ReturnType<typeof createApp>>;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "voxmind-set-"));
      repository = new MemoryRepository();
      app = await createApp({
        config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: "test-device-key-123456", ADMIN_API_KEY: "test-admin-key-123456",
          AUDIO_STORAGE_DIR: dir, BOOTSTRAP_ADMIN_PASSWORD: "fixture-owner-pw" }),
        repository, objects: new FileObjectStore(dir), executor: new MockToolExecutor(),
      });
    });
    afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

    it("明说的改动直接生效，设置和执行规则都改了，设备收到同步指令", async () => {
      const sessionId = randomUUID();
      await repository.createSession({ id: sessionId, deviceId: "web-console", userId: "owner", startedAt: new Date().toISOString() });
      const r = await app.inject({ method: "POST", url: "/v1/action-drafts", headers: ADMIN, payload: {
        sessionId, userId: "owner", tool: "settings.update", title: "改设置", confidence: 1, mode: "explicit", risk: "personal_write",
        args: { changes: [{ key: "screenOffSec", value: 45 }, { key: "intentMode", value: "push_to_talk" }, { key: "vocabularyAdd", value: ["沃克斯"] },
          { key: "rule", value: { tool: "feishu.message.send", confirmation: "always", notifyDevice: false } }] } } });
      expect(r.statusCode).toBe(201);
      expect(r.json().execution.status).toBe("succeeded");
      const prefs = (await app.inject({ method: "GET", url: "/v1/settings", headers: ADMIN })).json().settings.prefs;
      expect(prefs.screenOffSec).toBe(45);
      expect(prefs.ai.intentMode).toBe("push_to_talk");
      expect(prefs.vocabulary).toContain("沃克斯");
      expect((await repository.getToolPolicy("owner", "feishu.message.send"))).toMatchObject({ confirmation: "always", notifyDevice: false });
      expect(repository.commands.some((c) => c.command === "sync_config")).toBe(true);
    });

    it("改动全不合法就执行失败，什么都不改", async () => {
      const sessionId = randomUUID();
      await repository.createSession({ id: sessionId, deviceId: "web-console", userId: "owner", startedAt: new Date().toISOString() });
      const r = await app.inject({ method: "POST", url: "/v1/action-drafts", headers: ADMIN, payload: {
        sessionId, userId: "owner", tool: "settings.update", title: "改设置", confidence: 1, mode: "explicit", risk: "personal_write",
        args: { changes: [{ key: "screenOffSec", value: -5 }] } } });
      expect(r.statusCode).toBe(500);
      const prefs = (await app.inject({ method: "GET", url: "/v1/settings", headers: ADMIN })).json().settings.prefs;
      expect(prefs.screenOffSec).toBe(20);
    });
  });
});

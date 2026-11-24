import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MockToolExecutor } from "../src/connectors/mock.js";
import { FileObjectStore } from "../src/storage/file-store.js";
import { MemoryRepository } from "../src/store/memory.js";

/* 录音页按开机分组、按段/按天删除；建议批量忽略；聊天快捷问题可改 */

const ADMIN = { authorization: "Bearer test-admin-key-123456" };
const DEVICE = { "x-device-key": "test-device-key-123456" };

describe("录音管理与批量操作", () => {
  let dir: string;
  let repository: MemoryRepository;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "voxmind-rec-"));
    repository = new MemoryRepository();
    app = await createApp({
      config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: "test-device-key-123456", ADMIN_API_KEY: "test-admin-key-123456",
        AUDIO_STORAGE_DIR: dir, BOOTSTRAP_ADMIN_PASSWORD: "fixture-owner-pw" }),
      repository, objects: new FileObjectStore(dir), executor: new MockToolExecutor(),
    });
  });
  afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  async function session(bootId?: string, startedAt = new Date().toISOString()) {
    const r = await app.inject({ method: "POST", url: "/v1/device-sessions", headers: DEVICE,
      payload: { deviceId: "evt-1", startedAt, ...(bootId ? { bootId } : {}) } });
    expect(r.statusCode).toBe(201);
    return r.json().session.id as string;
  }
  async function chunk(id: string, sequence: number) {
    const body = Buffer.from(`audio-${id}-${sequence}`);
    const r = await app.inject({ method: "PUT", url: `/v1/device-sessions/${id}/chunks/${sequence}`,
      headers: { ...DEVICE, "content-type": "audio/ogg", "x-duration-ms": "15000",
        "x-content-sha256": createHash("sha256").update(body).digest("hex") }, payload: body });
    expect(r.statusCode).toBe(201);
  }
  const list = async () => (await app.inject({ method: "GET", url: "/v1/sessions", headers: ADMIN })).json().sessions as
    { id: string; bootId: string | null; durationMs: number }[];

  it("开机号随会话存下来，列表里带出来", async () => {
    const a = await session("boot-1");
    const b = await session("boot-1");
    const legacy = await session();
    const rows = await list();
    expect(rows.find((s) => s.id === a)?.bootId).toBe("boot-1");
    expect(rows.find((s) => s.id === b)?.bootId).toBe("boot-1");
    expect(rows.find((s) => s.id === legacy)?.bootId).toBeNull();
  });

  it("删录音：音频没了、列表里不再出现；正在录的那段删不了", async () => {
    const old = await session("boot-1", new Date(Date.now() - 3600_000).toISOString());
    await chunk(old, 0);
    await repository.updateSessionStatus(old, "ended", new Date().toISOString());
    const live = await session("boot-2");
    await chunk(live, 0);

    const refused = await app.inject({ method: "POST", url: "/v1/sessions/delete", headers: ADMIN, payload: { ids: [live] } });
    expect(refused.statusCode).toBe(409);

    const r = await app.inject({ method: "POST", url: "/v1/sessions/delete", headers: ADMIN, payload: { ids: [old] } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ deleted: 1, chunks: 1 });
    expect((await list()).map((s) => s.id)).toEqual([live]);
    expect(await repository.chunksInRange(old, 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it("建议可以按勾选或按天批量忽略", async () => {
    const sid = await session();
    const now = new Date().toISOString();
    const mk = (title: string, createdAt: string) => ({ id: randomUUID(), userId: "owner", sessionId: sid, topicId: null,
      tool: "note.create", title, detail: "", args: {}, evidence: "", evidenceStartMs: null, evidenceEndMs: null,
      confidence: 0.7, status: "open" as const, draftId: null, createdAt, updatedAt: createdAt });
    const today = [mk("今天一", now), mk("今天二", now)];
    const yesterday = mk("昨天", new Date(Date.now() - 86_400_000).toISOString());
    await repository.createSuggestions([...today, yesterday]);

    const byIds = await app.inject({ method: "POST", url: "/v1/suggestions/dismiss", headers: ADMIN, payload: { ids: [today[0]!.id] } });
    expect(byIds.json()).toEqual({ dismissed: 1 });

    const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const byDay = await app.inject({ method: "POST", url: "/v1/suggestions/dismiss", headers: ADMIN, payload: { day } });
    expect(byDay.json()).toEqual({ dismissed: 1 });
    const open = (await app.inject({ method: "GET", url: "/v1/suggestions?status=open", headers: ADMIN })).json().suggestions;
    expect(open.map((x: { title: string }) => x.title)).toEqual(["昨天"]);
  });

  it("聊天快捷问题有默认值，可以改", async () => {
    const before = (await app.inject({ method: "GET", url: "/v1/settings", headers: ADMIN })).json().settings.prefs.chatPrompts;
    expect(before.length).toBeGreaterThan(0);
    const r = await app.inject({ method: "PUT", url: "/v1/settings", headers: ADMIN,
      payload: { prefs: { chatPrompts: ["这周和李总聊了什么？", "今天记了哪些账？"] } } });
    expect(r.statusCode).toBe(200);
    expect(r.json().settings.prefs.chatPrompts).toEqual(["这周和李总聊了什么？", "今天记了哪些账？"]);
  });
});

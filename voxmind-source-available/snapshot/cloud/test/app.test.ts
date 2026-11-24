import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { FileObjectStore } from "../src/storage/file-store.js";
import { MemoryRepository } from "../src/store/memory.js";
import { MockToolExecutor } from "../src/connectors/mock.js";

const DEVICE_KEY = "test-device-key-123456";
const ADMIN_KEY = "test-admin-key-123456";

describe("VoxMind v1 API", () => {
  let dir: string;
  let repository: MemoryRepository;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "voxmind-test-"));
    repository = new MemoryRepository();
    app = await createApp({
      config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: DEVICE_KEY, ADMIN_API_KEY: ADMIN_KEY, AUDIO_STORAGE_DIR: dir }),
      repository,
      objects: new FileObjectStore(dir),
      executor: new MockToolExecutor(),
      intent: { name: "test-intent", async extract(text) { return text.includes("任务") ? [{ tool: "feishu.task.create" as const,
        title: "整理需求", detail: "明天下午", args: { summary: "整理需求" }, evidence: text,
        confidence: 0.96, mode: "explicit" as const, risk: "personal_write" as const }] : []; } },
    });
  });

  afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  async function createSession() {
    const response = await app.inject({ method: "POST", url: "/v1/device-sessions", headers: { "x-device-key": DEVICE_KEY }, payload: { deviceId: "demo-voxmind-not-a-real-device", userId: "owner" } });
    expect(response.statusCode).toBe(201);
    return response.json().session as { id: string };
  }

  it("rejects unauthenticated device calls", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/device-sessions", payload: { deviceId: "x" } });
    expect(response.statusCode).toBe(401);
  });

  it("accepts an offline-generated session UUID idempotently", async () => {
    const sessionId = randomUUID();
    const request = { method: "POST" as const, url: "/v1/device-sessions", headers: { "x-device-key": DEVICE_KEY }, payload: { sessionId, deviceId: "offline-device", userId: "owner" } };
    const first = await app.inject(request);
    const retry = await app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(first.json().session.id).toBe(sessionId);
    expect(retry.json()).toMatchObject({ session: { id: sessionId }, duplicate: true });
  });

  it("stores chunks durably and makes exact retries idempotent", async () => {
    const session = await createSession();
    const audio = Buffer.from("fake-opus-frame");
    const hash = createHash("sha256").update(audio).digest("hex");
    const request = { method: "PUT" as const, url: `/v1/device-sessions/${session.id}/chunks/0`, headers: { "x-device-key": DEVICE_KEY, "content-type": "audio/opus", "x-content-sha256": hash, "x-duration-ms": "5000", "x-start-ms": "0" }, payload: audio };
    const first = await app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ duplicate: false, durable: true });
    const retry = await app.inject(request);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ duplicate: true, durable: true });
    expect(repository.chunks.size).toBe(1);
  });

  it("wraps device PCM in a playable WAV response", async () => {
    const session = await createSession(); const pcm = Buffer.alloc(3200, 7);
    await app.inject({ method: "PUT", url: `/v1/device-sessions/${session.id}/chunks/0`, headers: { "x-device-key": DEVICE_KEY,
      "content-type": "audio/pcm", "x-content-sha256": createHash("sha256").update(pcm).digest("hex"), "x-duration-ms": "100" }, payload: pcm });
    const audio = await app.inject({ method: "GET", url: `/v1/sessions/${session.id}/chunks/0/audio`, headers: { authorization: `Bearer ${ADMIN_KEY}` } });
    expect(audio.statusCode).toBe(200); expect(audio.headers["content-type"]).toContain("audio/wav");
    expect(audio.rawPayload.subarray(0, 4).toString()).toBe("RIFF"); expect(audio.rawPayload.length).toBe(pcm.length + 44);
  });

  it("rejects corrupt data and sequence reuse with different content", async () => {
    const session = await createSession();
    const firstAudio = Buffer.from("first");
    const firstHash = createHash("sha256").update(firstAudio).digest("hex");
    const common = { "x-device-key": DEVICE_KEY, "content-type": "audio/opus", "x-duration-ms": "5000" };
    const corrupt = await app.inject({ method: "PUT", url: `/v1/device-sessions/${session.id}/chunks/0`, headers: { ...common, "x-content-sha256": "0".repeat(64) }, payload: firstAudio });
    expect(corrupt.statusCode).toBe(422);
    await app.inject({ method: "PUT", url: `/v1/device-sessions/${session.id}/chunks/0`, headers: { ...common, "x-content-sha256": firstHash }, payload: firstAudio });
    const other = Buffer.from("other");
    const conflict = await app.inject({ method: "PUT", url: `/v1/device-sessions/${session.id}/chunks/0`, headers: { ...common, "x-content-sha256": createHash("sha256").update(other).digest("hex") }, payload: other });
    expect(conflict.statusCode).toBe(409);
  });

  it("ends sessions idempotently and rejects later chunks", async () => {
    const session = await createSession();
    const end = await app.inject({ method: "POST", url: `/v1/device-sessions/${session.id}/end`, headers: { "x-device-key": DEVICE_KEY }, payload: {} });
    expect(end.statusCode).toBe(200);
    expect(end.json().duplicate).toBe(false);
    const retry = await app.inject({ method: "POST", url: `/v1/device-sessions/${session.id}/end`, headers: { "x-device-key": DEVICE_KEY }, payload: {} });
    expect(retry.json().duplicate).toBe(true);
    const audio = Buffer.from("late");
    const late = await app.inject({ method: "PUT", url: `/v1/device-sessions/${session.id}/chunks/1`, headers: { "x-device-key": DEVICE_KEY, "content-type": "audio/opus", "x-content-sha256": createHash("sha256").update(audio).digest("hex"), "x-duration-ms": "5000" }, payload: audio });
    expect(late.statusCode).toBe(409);
  });

  it("applies confirmation policy and supports revision plus idempotent confirmation", async () => {
    const session = await createSession();
    const auth = { authorization: `Bearer ${ADMIN_KEY}` };
    const base = { sessionId: session.id, userId: "owner", tool: "feishu.task.create", title: "整理需求", detail: "明天完成", args: { due: "tomorrow" }, evidence: "明天整理需求", confidence: 0.95, risk: "personal_write" };
    const suggested = await app.inject({ method: "POST", url: "/v1/action-drafts", headers: auth, payload: { ...base, mode: "suggested" } });
    expect(suggested.statusCode).toBe(201);
    expect(suggested.json().draft.status).toBe("pending");
    const id = suggested.json().draft.id as string;
    const revised = await app.inject({ method: "POST", url: `/v1/action-drafts/${id}/revise`, headers: auth, payload: { detail: "后天下午完成", args: { due: "day_after_tomorrow" } } });
    expect(revised.json().draft).toMatchObject({ revision: 2, detail: "后天下午完成", args: { due: "day_after_tomorrow" } });
    const confirmed = await app.inject({ method: "POST", url: `/v1/action-drafts/${id}/confirm`, headers: auth });
    expect(confirmed.json()).toMatchObject({ duplicate: false, draft: { status: "executed" }, execution: { status: "succeeded" } });
    const duplicate = await app.inject({ method: "POST", url: `/v1/action-drafts/${id}/confirm`, headers: auth });
    expect(duplicate.json().duplicate).toBe(true);
    const explicit = await app.inject({ method: "POST", url: "/v1/action-drafts", headers: auth, payload: { ...base, evidence: "直接创建任务", mode: "explicit" } });
    expect(explicit.json()).toMatchObject({ draft: { status: "executed" }, execution: { status: "succeeded", provider: "mock" } });
    const explicitRetry = await app.inject({ method: "POST", url: "/v1/action-drafts", headers: auth, payload: { ...base, evidence: "直接创建任务", mode: "explicit" } });
    expect(explicitRetry.json().draft.id).toBe(explicit.json().draft.id);
    expect(repository.executions.size).toBe(2);
  });

  it("lists effective policies and persists per-tool overrides", async () => {
    const auth = { authorization: `Bearer ${ADMIN_KEY}` };
    const initial = await app.inject({ method: "GET", url: "/v1/tool-policies?userId=owner", headers: auth });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().policies).toHaveLength(16);  // 原有动作 + 5 个 EVA 农场/家居语义工具 + 改设置
    expect(initial.json().policies.find((x: { tool: string }) => x.tool === "feishu.task.create")).toMatchObject({ confirmation: "explicit_only", configured: false });
    const saved = await app.inject({ method: "PUT", url: "/v1/tool-policies/feishu.task.create", headers: auth,
      payload: { userId: "owner", confirmation: "always", maxDraftAgeSec: 3600 } });
    expect(saved.statusCode).toBe(200);
    const next = await app.inject({ method: "GET", url: "/v1/tool-policies?userId=owner", headers: auth });
    expect(next.json().policies.find((x: { tool: string }) => x.tool === "feishu.task.create")).toMatchObject({ confirmation: "always", configured: true });
  });

  it("runs typed commands through the same intent and action pipeline", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/text-commands", headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { text: "帮我创建一个整理需求的任务" } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ provider: "test-intent", actions: [{ draft: { tool: "feishu.task.create", status: "executed" }, execution: { provider: "mock", status: "succeeded" } }] });
    expect(repository.sessions.size).toBe(1);
  });

  it("lets an authenticated device read and resolve the head of its action queue", async () => {
    const session = await createSession();
    const created = await app.inject({ method: "POST", url: "/v1/action-drafts", headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { sessionId: session.id, userId: "owner", tool: "webhook.call", title: "通知团队", args: { url: "https://example.com" },
        evidence: "可以通知一下团队", confidence: 0.7, mode: "suggested", risk: "external_write" } });
    const id = created.json().draft.id as string;
    const queue = await app.inject({ method: "GET", url: "/v1/device-actions?userId=owner", headers: { "x-device-key": DEVICE_KEY } });
    expect(queue.json()).toMatchObject({ pendingCount: 1, action: { id, title: "通知团队" } });
    const cancelled = await app.inject({ method: "POST", url: `/v1/device-actions/${id}/cancel`, headers: { "x-device-key": DEVICE_KEY } });
    expect(cancelled.json()).toMatchObject({ draft: { status: "cancelled" } });
    const empty = await app.inject({ method: "GET", url: "/v1/device-actions?userId=owner", headers: { "x-device-key": DEVICE_KEY } });
    expect(empty.json()).toMatchObject({ pendingCount: 0, action: null, command: null });
  });
});

describe("网页轮询的 ETag", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  const admin = { authorization: `Bearer ${ADMIN_KEY}` };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "voxmind-etag-"));
    app = await createApp({
      config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: DEVICE_KEY, ADMIN_API_KEY: ADMIN_KEY, AUDIO_STORAGE_DIR: dir }),
      repository: new MemoryRepository(), objects: new FileObjectStore(dir), executor: new MockToolExecutor(),
    });
  });
  afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  it("内容没变回 304；变了就换一个 ETag 并回整包", async () => {
    const first = await app.inject({ method: "GET", url: "/v1/action-drafts", headers: admin });
    expect(first.statusCode).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();
    // 没有 no-cache 的话浏览器压根不会带 If-None-Match，ETag 等于白设
    expect(first.headers["cache-control"]).toContain("no-cache");

    const again = await app.inject({ method: "GET", url: "/v1/action-drafts",
      headers: { ...admin, "if-none-match": etag } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");

    const session = await app.inject({ method: "POST", url: "/v1/device-sessions",
      headers: { "x-device-key": DEVICE_KEY }, payload: { deviceId: "evt", userId: "owner" } });
    await app.inject({ method: "POST", url: "/v1/action-drafts", headers: admin, payload: {
      sessionId: session.json().session.id, userId: "owner", tool: "note.create", title: "换点东西",
      args: { title: "换点东西", content: "" }, confidence: 1, mode: "explicit", risk: "record" } });

    const changed = await app.inject({ method: "GET", url: "/v1/action-drafts",
      headers: { ...admin, "if-none-match": etag } });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
  });

  it("设备接口不做 ETag：它有自己的 feedVersion，再算一次哈希是白费", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/device-actions", headers: { "x-device-key": DEVICE_KEY } });
    expect(r.statusCode).toBe(200);
    expect(r.headers.etag).toBeUndefined();
  });
});

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MockToolExecutor } from "../src/connectors/mock.js";
import { FileObjectStore } from "../src/storage/file-store.js";
import { MemoryRepository } from "../src/store/memory.js";

/* 复制给 AI：带密钥的只读链接。不用登录就能读这一段的文字；撤销、过期、录音删了都失效 */

const ADMIN = { authorization: "Bearer test-admin-key-123456" };

describe("复制给 AI 的分享链接", () => {
  let dir: string;
  let repository: MemoryRepository;
  let app: Awaited<ReturnType<typeof createApp>>;
  let sessionId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "voxmind-share-"));
    repository = new MemoryRepository();
    app = await createApp({
      config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: "test-device-key-123456", ADMIN_API_KEY: "test-admin-key-123456",
        AUDIO_STORAGE_DIR: dir, BOOTSTRAP_ADMIN_PASSWORD: "fixture-owner-pw", PUBLIC_BASE_URL: "https://voxmind.example" }),
      repository, objects: new FileObjectStore(dir), executor: new MockToolExecutor(),
    });
    sessionId = randomUUID();
    await repository.createSession({ id: sessionId, deviceId: "evt-1", userId: "owner", startedAt: "2026-10-07T02:00:00.000Z" });
    const now = new Date().toISOString();
    for (const [seq, text] of [[0, "下周三之前把报价单发给采购"], [1, "预算先按六十万报"], [2, "这句在范围外"]] as const) {
      await repository.finishTranscript({ sessionId, sequence: seq, text, startMs: seq * 15_000, endMs: seq * 15_000 + 15_000,
        provider: "test", status: "succeeded", error: null, kind: "speech", endSequence: null, createdAt: now, updatedAt: now });
    }
  });
  afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  const share = (payload: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: `/v1/sessions/${sessionId}/share`, headers: ADMIN, payload });
  const read = (url: string) => app.inject({ method: "GET", url: new URL(url).pathname + new URL(url).search });

  it("生成的链接不用登录就能读全文，带时间；可以只分享其中一截", async () => {
    const r = await share({ to: 30_000 });
    expect(r.statusCode).toBe(201);
    const { url, expiresAt } = r.json();
    expect(url).toMatch(/^https:\/\/voxmind\.example\/v1\/share\/[\w-]{30,}$/);
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);   // 默认 7 天
    const page = await read(url);
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/plain");
    expect(page.body).toContain("下周三之前把报价单发给采购");
    expect(page.body).toContain("预算先按六十万报");
    expect(page.body).not.toContain("这句在范围外");
    expect(page.body).toMatch(/2026\/10\/7 10:00:00/);
    const json = (await read(`${url}?format=json`)).json();
    expect(json.lines).toHaveLength(2);
  });

  it("库里不存密钥本身；撤销后、过期后、密钥不对都读不到", async () => {
    const { url, id } = (await share()).json();
    const token = url.split("/").pop()!;
    expect([...repository.shareLinks.values()].some((l) => l.tokenHash.includes(token))).toBe(false);
    expect((await read(url.replace(token, "x".repeat(32)))).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/v1/shares/${id}`, headers: ADMIN })).statusCode).toBe(200);
    expect((await read(url)).statusCode).toBe(404);

    const second = (await share({ days: 1 })).json();
    const link = repository.shareLinks.get(second.id)!;
    repository.shareLinks.set(second.id, { ...link, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await read(second.url)).statusCode).toBe(404);
  });

  it("删了录音，链接跟着失效；读一次记一次", async () => {
    const { url, id } = (await share()).json();
    await read(url);
    expect(repository.shareLinks.get(id)!.uses).toBe(1);
    await app.inject({ method: "POST", url: "/v1/sessions/delete", headers: ADMIN, payload: { ids: [sessionId] } });
    expect((await read(url)).statusCode).toBe(404);
  });
});

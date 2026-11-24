import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { ChatMessage, LlmClient, LlmReply, ToolSpec } from "../src/ai/llm.js";
import { loadConfig } from "../src/config.js";
import { MockToolExecutor } from "../src/connectors/mock.js";
import { MemoryRepository } from "../src/store/memory.js";

/* 收藏：录音加星、放进自己建的文件夹（一段能进几个文件夹）；聊天里的 AI 也能整理 */

const ADMIN = { authorization: "Bearer test-admin-key-123456" };

class ScriptedLlm implements LlmClient {
  readonly enabled = true;
  constructor(private readonly script: Partial<LlmReply>[]) {}
  modelFor() { return "qwen-flash"; }
  async chat(_model: string, _messages: ChatMessage[], _options: { tools?: ToolSpec[] } = {}): Promise<LlmReply> {
    const next = this.script.shift() ?? { content: "好了" };
    return { content: next.content ?? "", toolCalls: next.toolCalls ?? [], usage: { inputTokens: 1, outputTokens: 1 }, model: "qwen-flash" };
  }
}

describe("收藏", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  afterEach(async () => { await app?.close(); });

  async function start(repository: MemoryRepository, script: Partial<LlmReply>[] = []) {
    app = await createApp({
      config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: "test-device-key-123456", ADMIN_API_KEY: "test-admin-key-123456",
        BOOTSTRAP_ADMIN_PASSWORD: "fixture-owner-pw" }),
      repository, executor: new MockToolExecutor(), llm: new ScriptedLlm(script),
    });
  }
  async function session(repository: MemoryRepository) {
    const id = randomUUID();
    await repository.createSession({ id, deviceId: "evt", userId: "owner", startedAt: new Date().toISOString() });
    return id;
  }
  const req = (method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, headers: ADMIN, ...(payload ? { payload } : {}) });

  it("加星、建文件夹、一段放进两个文件夹；删文件夹不删收藏；取消收藏连文件夹里的也拿掉", async () => {
    const repository = new MemoryRepository();
    const a = await session(repository), b = await session(repository);
    await start(repository);
    expect((await req("PUT", `/v1/favorites/${a}`)).statusCode).toBe(200);
    const f1 = (await req("POST", "/v1/favorite-folders", { name: "张总项目" })).json().folder.id;
    const f2 = (await req("POST", "/v1/favorite-folders", { name: "报价" })).json().folder.id;
    await req("PUT", `/v1/favorite-folders/${f1}/items/${b}`);
    await req("PUT", `/v1/favorite-folders/${f2}/items/${b}`);
    let fav = (await req("GET", "/v1/favorites")).json();
    expect(fav.folders.map((f: { name: string; count: number }) => [f.name, f.count])).toEqual([["张总项目", 1], ["报价", 1]]);
    expect(fav.items.find((i: { sessionId: string }) => i.sessionId === b).folderIds.sort()).toEqual([f1, f2].sort());
    expect(fav.sessions).toHaveLength(2);

    await req("DELETE", `/v1/favorite-folders/${f2}`);
    fav = (await req("GET", "/v1/favorites")).json();
    expect(fav.items).toHaveLength(2);
    expect(fav.items.find((i: { sessionId: string }) => i.sessionId === b).folderIds).toEqual([f1]);

    await req("DELETE", `/v1/favorites/${b}`);
    fav = (await req("GET", "/v1/favorites")).json();
    expect(fav.items.map((i: { sessionId: string }) => i.sessionId)).toEqual([a]);
    expect(fav.folders[0].count).toBe(0);
  });

  it("删了的录音不出现在收藏里；文件夹名不能空", async () => {
    const repository = new MemoryRepository();
    const a = await session(repository);
    await start(repository);
    await req("PUT", `/v1/favorites/${a}`);
    await repository.updateSessionStatus(a, "ended", new Date().toISOString());
    await req("POST", "/v1/sessions/delete", { ids: [a] });
    expect((await req("GET", "/v1/favorites")).json().items).toEqual([]);
    expect((await req("POST", "/v1/favorite-folders", { name: "  " })).statusCode).toBe(400);
  });

  it("聊天里让 AI 把相关的录音放进新文件夹", async () => {
    const repository = new MemoryRepository();
    const a = await session(repository), b = await session(repository);
    const call = (name: string, args: object) => ({ id: randomUUID(), type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
    await start(repository, [{ toolCalls: [call("organize_favorites", { folder: "张总项目", add: [a, b, "not-a-uuid"] })] },
      { content: "放好了：两段录音放进了「张总项目」。" }]);
    const r = await req("POST", "/v1/chat", { messages: [{ role: "user", content: "把和张总相关的录音放进收藏里新建一个文件夹" }] });
    expect(r.statusCode).toBe(200);
    const fav = (await req("GET", "/v1/favorites")).json();
    expect(fav.folders.map((f: { name: string; count: number }) => [f.name, f.count])).toEqual([["张总项目", 2]]);
  });

  async function said(repository: MemoryRepository, sessionId: string, text: string) {
    const now = new Date().toISOString();
    await repository.finishTranscript({ sessionId, sequence: 0, text, startMs: 0, endMs: 5000, provider: "t", status: "succeeded",
      error: null, kind: "speech", endSequence: null, createdAt: now, updatedAt: now });
  }

  it("自动归档：设了关键词，提到的录音马上收进来；手动拿出来的不再放回", async () => {
    const repository = new MemoryRepository();
    const a = await session(repository), b = await session(repository), c = await session(repository);
    await said(repository, a, "明天去见张总谈续约");
    await said(repository, b, "中午吃面");
    await said(repository, c, "张总那边的合同改好了");
    await start(repository);
    const f = (await req("POST", "/v1/favorite-folders", { name: "张总项目" })).json().folder.id;
    const r = await req("PATCH", `/v1/favorite-folders/${f}`, { keywords: ["张总"] });
    expect(r.json().added).toBe(2);
    let fav = (await req("GET", "/v1/favorites")).json();
    expect(fav.folders[0]).toMatchObject({ keywords: ["张总"], count: 2 });

    await req("DELETE", `/v1/favorite-folders/${f}/items/${c}`);          // 手动拿出来
    expect(await repository.applyFolderRules()).toBe(0);                    // 不放回
    const d = await session(repository);
    await said(repository, d, "张总又来电话了");
    expect(await repository.applyFolderRules()).toBe(1);                    // 新录音照样收
    fav = (await req("GET", "/v1/favorites")).json();
    expect(fav.folders[0].count).toBe(2);
  });

  it("整个文件夹复制给 AI：一个链接里是每段录音的全文，按时间排", async () => {
    const repository = new MemoryRepository();
    const a = randomUUID(), b = randomUUID();
    await repository.createSession({ id: a, deviceId: "evt", userId: "owner", startedAt: "2026-10-07T01:00:00.000Z" });
    await repository.createSession({ id: b, deviceId: "evt", userId: "owner", startedAt: "2026-10-06T01:00:00.000Z" });
    await said(repository, a, "第二次沟通：报价六十万");
    await said(repository, b, "第一次见面：先了解需求");
    await start(repository);
    const f = (await req("POST", "/v1/favorite-folders", { name: "张总项目" })).json().folder.id;
    await req("PUT", `/v1/favorite-folders/${f}/items/${a}`);
    await req("PUT", `/v1/favorite-folders/${f}/items/${b}`);
    const { url } = (await req("POST", `/v1/favorite-folders/${f}/share`, {})).json();
    const page = await app.inject({ method: "GET", url: new URL(url).pathname });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("收藏夹「张总项目」");
    expect(page.body.indexOf("先了解需求")).toBeLessThan(page.body.indexOf("报价六十万"));   // 按时间排
    await req("DELETE", `/v1/favorite-folders/${f}`);
    expect((await app.inject({ method: "GET", url: new URL(url).pathname })).statusCode).toBe(404);   // 文件夹删了链接失效
  });

  it("收藏的录音不会被保留期清理删掉", async () => {
    const repository = new MemoryRepository();
    const kept = await session(repository), gone = await session(repository);
    for (const id of [kept, gone]) {
      await repository.putChunk({ sessionId: id, sequence: 0, sha256: "x".repeat(64), objectKey: `k/${id}`, contentType: "audio/ogg",
        byteLength: 10, startMs: 0, durationMs: 15000, uploadedAt: "2026-01-01T00:00:00.000Z" });
    }
    await repository.setFavorite("owner", kept, true);
    const expired = await repository.expiredChunks(new Date().toISOString(), ["owner"], 100);
    expect(expired.map((c) => c.sessionId)).toEqual([gone]);
  });
});

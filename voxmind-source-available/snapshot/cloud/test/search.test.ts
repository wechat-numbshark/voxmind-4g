import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MockToolExecutor } from "../src/connectors/mock.js";
import { normalize, type EmbeddingProvider, type EmbeddingResult } from "../src/search/embeddings.js";
import { MemoryRepository } from "../src/store/memory.js";

/* 混合搜索：先给逐字命中的，再给意思相近的。
 *
 * 这里不连真的嵌入模型——把句子按话题映射成两维向量就够验排序和阈值了：
 * 真模型换了，这些断言仍然该成立。*/

const ADMIN_KEY = "test-admin-key-123456";

/** 话题向量：合同类 = (1,0)，午饭类 = (0,1)，两者正交 */
function topicVector(text: string) {
  const contract = /合同|协议|签/.test(text) ? 1 : 0;
  const lunch = /午饭|吃|外卖/.test(text) ? 1 : 0;
  return normalize([contract || 0.02, lunch || 0.02]);
}

class TopicEmbeddings implements EmbeddingProvider {
  readonly name = "topic";
  readonly model = "topic-test";
  readonly dimensions = 2;
  calls = 0;
  async embed(texts: string[]): Promise<EmbeddingResult> {
    this.calls++;
    return { vectors: texts.map(topicVector), inputTokens: texts.length, model: this.model };
  }
}

describe("混合搜索", () => {
  let repository: MemoryRepository;
  let embeddings: TopicEmbeddings;
  let app: Awaited<ReturnType<typeof createApp>>;
  const admin = { authorization: `Bearer ${ADMIN_KEY}` };
  const sessionId = randomUUID();

  async function seed(sequence: number, text: string, withVector = true) {
    const now = new Date().toISOString();
    await repository.finishTranscript({ sessionId, sequence, text, startMs: sequence * 5000, endMs: sequence * 5000 + 5000,
      provider: "test", status: "succeeded", error: null, kind: "speech", endSequence: null, createdAt: now, updatedAt: now });
    if (withVector) await repository.saveEmbedding(sessionId, sequence, topicVector(text));
  }

  async function search(q: string, extra = "") {
    const r = await app.inject({ method: "GET", url: `/v1/search?q=${encodeURIComponent(q)}${extra}`, headers: admin });
    expect(r.statusCode).toBe(200);
    return r.json() as { hits: { text: string; score: number; match: "text" | "semantic" }[]; semanticReady: boolean };
  }

  beforeEach(async () => {
    repository = new MemoryRepository();
    embeddings = new TopicEmbeddings();
    app = await createApp({
      config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: "test-device-key-123456", ADMIN_API_KEY: ADMIN_KEY,
        BOOTSTRAP_ADMIN_PASSWORD: "fixture-owner-pw" }),
      repository, executor: new MockToolExecutor(), embeddings,
    });
    await repository.createSession({ id: sessionId, deviceId: "demo-voxmind-not-a-real-device", userId: "owner", startedAt: new Date().toISOString() });
    await seed(0, "合同下周一之前必须签完");
    await seed(1, "那个协议对方回了没");
    await seed(2, "中午吃什么，点个外卖吧");
  });

  afterEach(async () => { await app.close(); });

  it("逐字命中排在意思相近的前面", async () => {
    const { hits, semanticReady } = await search("合同");
    expect(semanticReady).toBe(true);
    expect(hits[0]).toMatchObject({ text: "合同下周一之前必须签完", match: "text", score: 1 });
    expect(hits[1]).toMatchObject({ text: "那个协议对方回了没", match: "semantic" });
    expect(hits.map((h) => h.text)).not.toContain("中午吃什么，点个外卖吧");
  });

  it("换个说法也能找到，同一句不会出现两次", async () => {
    const { hits } = await search("那份文件签字了吗");
    expect(hits.every((h) => h.match === "semantic")).toBe(true);
    expect(new Set(hits.map((h) => h.text)).size).toBe(hits.length);
    expect(hits.map((h) => h.text)).toEqual(["合同下周一之前必须签完", "那个协议对方回了没"]);
  });

  it("话题不同的不会被拉进来", async () => {
    const { hits } = await search("晚上想点个外卖");
    expect(hits.map((h) => h.text)).toEqual(["中午吃什么，点个外卖吧"]);
  });

  it("mode=text 时一个向量都不算", async () => {
    const { hits } = await search("合同", "&mode=text");
    expect(embeddings.calls).toBe(0);
    expect(hits).toHaveLength(1);
  });

  it("还没算出向量的句子只能靠字面搜到", async () => {
    await seed(3, "合同附件我放在群里了", false);
    const { hits } = await search("合同");
    expect(hits.filter((h) => h.text === "合同附件我放在群里了")).toHaveLength(1);
    const paraphrase = await search("那份文件签字了吗");
    expect(paraphrase.hits.map((h) => h.text)).not.toContain("合同附件我放在群里了");
  });

  it("没配嵌入模型时退回逐字搜索，并且说清楚", async () => {
    await app.close();
    app = await createApp({
      config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: "test-device-key-123456", ADMIN_API_KEY: ADMIN_KEY,
        BOOTSTRAP_ADMIN_PASSWORD: "fixture-owner-pw" }),
      repository, executor: new MockToolExecutor(),
    });
    const { hits, semanticReady } = await search("那份文件签字了吗");
    expect(semanticReady).toBe(false);
    expect(hits).toHaveLength(0);
  });
});

/* 百炼的 /embeddings 一次最多 10 条，第 11 条会让整批 400（实测：
 * InternalError.Algo.InvalidParameter: batch size ... not be larger than 10）。
 * 流水线一次认领 16 句，所以切批必须在这一层做对。*/
describe("百炼嵌入模型的批量上限", () => {
  it("超过 10 条自动切批，顺序和 token 计数都对得上", async () => {
    const batches: string[][] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { input: string[] };
      batches.push(body.input);
      return {
        ok: true,
        json: async () => ({
          // 故意乱序返回，逼着实现按 index 排回去
          data: body.input.map((text, index) => ({ index, embedding: [Number(text), 0] })).reverse(),
          usage: { total_tokens: body.input.length },
        }),
      };
    }) as unknown as typeof fetch;

    const { DashScopeEmbeddingProvider } = await import("../src/search/embeddings.js");
    const provider = new DashScopeEmbeddingProvider({ apiKey: "k", baseUrl: "https://example.com/v1",
      model: "text-embedding-v4", dimensions: 512, fetchImpl });

    const texts = Array.from({ length: 23 }, (_, i) => String(i + 1));
    const { vectors, inputTokens } = await provider.embed(texts);

    expect(batches.map((b) => b.length)).toEqual([10, 10, 3]);
    expect(vectors).toHaveLength(23);
    expect(vectors[0]![0]).toBeCloseTo(1);     // 归一化后仍是第 1 条
    expect(vectors[22]![0]).toBeCloseTo(1);
    expect(inputTokens).toBe(23);
  });
});

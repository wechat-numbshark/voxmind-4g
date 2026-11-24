import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DiarizeService, speakerTranscript } from "../src/ai/diarize.js";
import { signClipToken, verifyClipToken } from "../src/security/clip-token.js";
import { PricingService } from "../src/services/pricing.js";
import { MemoryRepository } from "../src/store/memory.js";

/* 分角色转写：把一段音频整体交给带说话人分离的接口，跑完存下来。
 * 盯的是：临时链接不能被改、不能过期还有效；结果的时间要换算回整次录音的时间轴；
 * 跑过一次就不再重复花钱。*/

const SECRET = "k".repeat(64);

describe("临时音频链接", () => {
  it("签名对得上才认；改一个字节就失效", () => {
    const token = signClipToken(SECRET, { sessionId: "s1", fromMs: 0, toMs: 5000 });
    expect(verifyClipToken(SECRET, token)).toMatchObject({ sessionId: "s1", fromMs: 0, toMs: 5000 });
    expect(verifyClipToken(SECRET, `${token}x`)).toBeNull();
    expect(verifyClipToken("别的密钥".repeat(8), token)).toBeNull();
  });

  it("30 分钟后过期", () => {
    const now = Date.now();
    const token = signClipToken(SECRET, { sessionId: "s1", fromMs: 0, toMs: 5000 }, now);
    expect(verifyClipToken(SECRET, token, now + 29 * 60_000)).not.toBeNull();
    expect(verifyClipToken(SECRET, token, now + 31 * 60_000)).toBeNull();
  });

  it("只指向那一段：换个会话或时间就得重新签", () => {
    const a = signClipToken(SECRET, { sessionId: "s1", fromMs: 0, toMs: 5000 });
    const claim = verifyClipToken(SECRET, a)!;
    expect(claim.sessionId).toBe("s1");
    expect(claim.toMs).toBe(5000);
  });
});

describe("分角色转写", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  async function fakeDashScope(sentences: unknown[]) {
    let polls = 0;
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url!.includes("/transcription")) {
        res.end(JSON.stringify({ output: { task_id: "task-1", task_status: "PENDING" } }));
      } else if (req.url!.includes("/tasks/")) {
        polls++;
        // 第一次还在跑，第二次才好——真实接口就是要轮询的
        if (polls < 2) return res.end(JSON.stringify({ output: { task_status: "RUNNING" } }));
        res.end(JSON.stringify({ output: { task_status: "SUCCEEDED",
          results: [{ subtask_status: "SUCCEEDED", transcription_url: `http://127.0.0.1:${port}/result.json` }] } }));
      } else {
        res.end(JSON.stringify({ transcripts: [{ sentences }] }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
    const port = address.port;
    close = () => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    return `http://127.0.0.1:${port}`;
  }

  it("结果的时间换算回整次录音的时间轴，并按目标存起来", async () => {
    const base = await fakeDashScope([
      { text: "张总您好", begin_time: 0, end_time: 1500, speaker_id: 0 },
      { text: "你好你好", begin_time: 1600, end_time: 3000, speaker_id: 1 },
      { text: "", begin_time: 3100, end_time: 3200, speaker_id: 1 },
    ]);
    const repository = new MemoryRepository();
    const topicId = randomUUID();
    const service = new DiarizeService({ repository, pricing: new PricingService(repository),
      apiKey: "k", baseUrl: base, pollMs: 10, clipUrl: () => `${base}/clip.wav` });

    const lines = await service.run({ userId: "owner", sessionId: randomUUID(), fromMs: 600_000, toMs: 900_000,
      targetType: "topic", targetId: topicId, tier: "high" });

    expect(lines).toEqual([
      { speaker: "0", text: "张总您好", startMs: 600_000, endMs: 601_500 },
      { speaker: "1", text: "你好你好", startMs: 601_600, endMs: 603_000 },
    ]);
    // 空句子丢掉，不进纪要
    expect(lines).toHaveLength(2);
    // 存成 speakers 产出，下次直接拿
    expect(await service.cached(topicId)).toEqual(lines);
    // 按音频时长记账，功能标成 speakers
    const usage = await repository.usageRollup("2026-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z");
    expect(usage.find((r) => r.feature === "speakers")?.audioMs).toBe(300_000);
  });

  it("接口报错时如实抛出来，让调用方退回不带角色的纪要", async () => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: "InvalidFile.DownloadFailed" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
    close = () => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    const repository = new MemoryRepository();
    const service = new DiarizeService({ repository, pricing: new PricingService(repository),
      apiKey: "k", baseUrl: `http://127.0.0.1:${address.port}`, pollMs: 10, clipUrl: () => "http://x/clip.wav" });
    await expect(service.run({ userId: "owner", sessionId: randomUUID(), fromMs: 0, toMs: 1000,
      targetType: "topic", targetId: randomUUID(), tier: "high" })).rejects.toThrow("DownloadFailed");
  });

  it("排成给模型看的文本：说话人按出场顺序叫 A、B", () => {
    const text = speakerTranscript([
      { speaker: "2", text: "先开个头", startMs: 0, endMs: 1000 },
      { speaker: "0", text: "我接一句", startMs: 60_000, endMs: 61_000 },
      { speaker: "2", text: "再说一句", startMs: 120_000, endMs: 121_000 },
    ], "2026-09-20T01:00:00.000Z");
    expect(text.split("\n")).toEqual([
      "说话人A 09:00 先开个头",
      "说话人B 09:01 我接一句",
      "说话人A 09:02 再说一句",
    ]);
  });
});

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ChatMessage, LlmClient, LlmReply } from "../src/ai/llm.js";
import { SuggestService, sameThing, worthScanning } from "../src/ai/suggest.js";
import { DEFAULT_PREFS, type Topic } from "../src/domain.js";
import { PricingService } from "../src/services/pricing.js";
import { MemoryRepository } from "../src/store/memory.js";

/* 漏网检查：没按确认键说过、但像是要办的事，挑出来等用户点一下才建。
 * 盯的是三件事：闲聊不花钱去问模型、已经建过的不重复提、模型乱给的条目挡在外面。*/

class ScriptedLlm implements LlmClient {
  readonly enabled = true;
  calls: ChatMessage[][] = [];
  constructor(private readonly script: string[]) {}
  modelFor() { return "qwen-flash"; }
  async chat(_model: string, messages: ChatMessage[]): Promise<LlmReply> {
    this.calls.push([...messages]);
    return { content: this.script.shift() ?? '{"items":[]}', toolCalls: [], usage: { inputTokens: 200, outputTokens: 30 }, model: "qwen-flash" };
  }
}

async function seed(lines: [number, string][]) {
  const repository = new MemoryRepository();
  const sessionId = randomUUID();
  await repository.createSession({ id: sessionId, deviceId: "evt", userId: "owner", startedAt: "2026-09-20T01:00:00.000Z" });
  const now = new Date().toISOString();
  for (const [i, [startMs, text]] of lines.entries()) {
    await repository.finishTranscript({ sessionId, sequence: i, text, startMs, endMs: startMs + 5000, provider: "t",
      status: "succeeded", error: null, kind: "speech", endSequence: null, createdAt: now, updatedAt: now });
  }
  const topic: Topic = { id: randomUUID(), sessionId, userId: "owner", startMs: 0, endMs: 3_600_000,
    title: "上午和张总", summary: "聊续约", source: "ai", createdAt: now, updatedAt: now };
  await repository.createTopic(topic);
  return { repository, sessionId, topic };
}

const service = (repository: MemoryRepository, llm: LlmClient) =>
  new SuggestService({ repository, llm, pricing: new PricingService(repository) });

describe("先粗筛再花钱", () => {
  it("有钱数或时间承诺才值得看", () => {
    expect(worthScanning("午饭花了68")).toBe(true);
    expect(worthScanning("明天十点给张总打电话")).toBe(true);
    expect(worthScanning("今天天气不错啊，风挺大的")).toBe(false);
  });

  it("一段纯闲聊：一次模型都不调，也不记账单", async () => {
    const { repository, topic } = await seed([[0, "今天天气不错"], [60_000, "风挺大的"]]);
    const llm = new ScriptedLlm([]);
    expect(await service(repository, llm).scanTopic(topic, DEFAULT_PREFS, "economy")).toEqual([]);
    expect(llm.calls).toHaveLength(0);
    expect(await repository.usageRollup("2026-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z")).toEqual([]);
  });
});

describe("挑出漏网的事", () => {
  it("存成建议而不是直接建卡片；记在「漏网检查」的账上", async () => {
    const { repository, topic } = await seed([[0, "明天十点给张总打电话"], [60_000, "午饭花了68"]]);
    const llm = new ScriptedLlm([JSON.stringify({ items: [
      { tool: "feishu.task.create", title: "明天十点给张总打电话", args: { summary: "给张总打电话", due: "2026-09-21 10:00" }, evidence: "明天十点给张总打电话", confidence: 0.9 },
      { tool: "expense.record", title: "午饭 68 元", args: { amount: 68, category: "餐饮", note: "午饭" }, evidence: "午饭花了68", confidence: 0.85 },
    ] })]);
    const made = await service(repository, llm).scanTopic(topic, DEFAULT_PREFS, "economy");
    expect(made.map((s) => [s.tool, s.title, s.status])).toEqual([
      ["feishu.task.create", "明天十点给张总打电话", "open"],
      ["expense.record", "午饭 68 元", "open"],
    ]);
    // 建议不是卡片：这时候一张待办卡片都不该有
    expect(await repository.listDrafts("owner")).toHaveLength(0);
    // 时间过了和语音同一套换算：不留模型自己编的时间戳
    expect(made[0]!.args.dueTimestampMs).toBe(Date.parse("2026-09-21T02:00:00.000Z"));
    const usage = await repository.usageRollup("2026-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z");
    expect(usage.find((r) => r.feature === "suggest")).toBeTruthy();
  });

  it("按键当时已经建过的，不再重复提", async () => {
    const { repository, sessionId, topic } = await seed([[0, "明天十点给张总打电话"]]);
    const now = new Date().toISOString();
    await repository.createDraft({ id: randomUUID(), sessionId, userId: "owner", tool: "feishu.task.create",
      title: "明天十点给张总打电话", detail: "", args: {}, evidence: "", evidenceStartMs: 0, evidenceEndMs: 5000,
      confidence: 1, mode: "explicit", risk: "personal_write", status: "executed", revision: 1,
      idempotencyKey: randomUUID(), createdAt: now, updatedAt: now });
    const llm = new ScriptedLlm([JSON.stringify({ items: [
      { tool: "feishu.task.create", title: "给张总打电话", args: { summary: "给张总打电话" }, evidence: "", confidence: 0.9 },
    ] })]);
    expect(await service(repository, llm).scanTopic(topic, DEFAULT_PREFS, "economy")).toEqual([]);
  });

  it("模型给的没把握的、工具不认识的，一律挡在外面", async () => {
    const { repository, topic } = await seed([[0, "明天十点给张总打电话"]]);
    const llm = new ScriptedLlm([JSON.stringify({ items: [
      { tool: "feishu.task.create", title: "也许要跟进一下", args: {}, confidence: 0.3 },
      { tool: "feishu.message.send", title: "给张总发消息", args: { text: "在吗" }, confidence: 0.95 },
      { tool: "note.create", title: "", args: {}, confidence: 0.9 },
    ] })]);
    expect(await service(repository, llm).scanTopic(topic, DEFAULT_PREFS, "economy")).toEqual([]);
  });

  it("关掉之后不再扫", async () => {
    const { repository, topic } = await seed([[0, "午饭花了68"]]);
    const llm = new ScriptedLlm([]);
    const prefs = { ...DEFAULT_PREFS, ai: { ...DEFAULT_PREFS.ai, suggest: false } };
    expect(await service(repository, llm).scanTopic(topic, prefs, "economy")).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it("判重：标题互相包含，或同类型同金额", () => {
    expect(sameThing({ tool: "note.create", title: "给张总打电话", args: {} },
                     { tool: "feishu.task.create", title: "明天十点给张总打电话", args: {} })).toBe(true);
    expect(sameThing({ tool: "expense.record", title: "午饭", args: { amount: 68 } },
                     { tool: "expense.record", title: "吃饭", args: { amount: 68 } })).toBe(true);
    expect(sameThing({ tool: "expense.record", title: "午饭", args: { amount: 68 } },
                     { tool: "expense.record", title: "打车", args: { amount: 25 } })).toBe(false);
  });
});

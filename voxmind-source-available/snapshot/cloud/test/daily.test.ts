import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DailyService, dailyTargetId, todoLines } from "../src/ai/daily.js";
import type { ChatMessage, LlmClient, LlmReply } from "../src/ai/llm.js";
import { ActionService } from "../src/services/actions.js";
import { PricingService } from "../src/services/pricing.js";
import { SettingsService } from "../src/services/settings.js";
import { MemoryRepository } from "../src/store/memory.js";

/* 每日小结和纪要待办转任务。模型用脚本替身，测的是喂给它的材料对不对、结果怎么落库、任务走不走确认规则。*/

class ScriptedLlm implements LlmClient {
  readonly enabled = true;
  calls: ChatMessage[][] = [];
  constructor(private readonly script: string[]) {}
  modelFor() { return "qwen-flash"; }
  async chat(_model: string, messages: ChatMessage[]): Promise<LlmReply> {
    this.calls.push([...messages]);
    return { content: this.script.shift() ?? "", toolCalls: [], usage: { inputTokens: 100, outputTokens: 20 }, model: "qwen-flash" };
  }
}

async function seed(repository: MemoryRepository) {
  const sessionId = randomUUID();
  // 北京时间 2026-09-19 09:00 开机
  await repository.createSession({ id: sessionId, deviceId: "evt", userId: "owner", startedAt: "2026-09-19T01:00:00.000Z" });
  const now = new Date().toISOString();
  const topic = await repository.createTopic({ id: randomUUID(), sessionId, userId: "owner", startMs: 0, endMs: 1_800_000,
    title: "拜访张总：谈续约", summary: "谈了续约价格，张总要周五前看报价", source: "ai", createdAt: now, updatedAt: now });
  await repository.createOutput({ id: randomUUID(), userId: "owner", targetType: "topic", targetId: topic.id, kind: "minutes",
    template: "general", content: "## 概要\n谈续约\n## 待办（负责人 · 截止时间）\n- 我 · 周五前把报价发给张总\n- 小李 · 整理去年合同\n## 原话摘录\n无",
    model: "m", createdAt: now });
  await repository.finishTranscript({ sessionId, sequence: 0, text: "张总您好", startMs: 0, endMs: 5000, provider: "t",
    status: "succeeded", error: null, kind: "speech", endSequence: null, createdAt: now, updatedAt: now });
  return { sessionId, topic };
}

function service(repository: MemoryRepository, llm: LlmClient) {
  return new DailyService({ repository, llm, pricing: new PricingService(repository),
    settings: new SettingsService(repository, "high"), actions: new ActionService(repository) });
}

describe("每日小结", () => {
  it("从纪要里取出待办那一节，空的「无」不算", () => {
    expect(todoLines("## 待办\n- 甲 · 做 A\n2. 乙做 B\n## 原话\n- 不是待办")).toEqual(["甲 · 做 A", "乙做 B"]);
    expect(todoLines("## 待办（负责人）\n无\n")).toEqual([]);
    expect(todoLines("没有这一节")).toEqual([]);
  });

  it("喂给模型的是当天的主题和纪要待办，结果按天存一份、记在「每日小结」的账上", async () => {
    const repository = new MemoryRepository();
    await seed(repository);
    const llm = new ScriptedLlm(["## 今天概览\n见了张总"]);
    const out = await service(repository, llm).generate("owner", "2026-09-19", "high");
    const prompt = llm.calls[0]![1]!.content;
    expect(prompt).toContain("09:00 拜访张总：谈续约");
    expect(prompt).toContain("我 · 周五前把报价发给张总");
    expect(out).toMatchObject({ kind: "daily", targetType: "day", targetId: dailyTargetId("owner", "2026-09-19"), template: "2026-09-19" });
    expect(await service(repository, llm).get("owner", "2026-09-19")).toMatchObject({ content: "## 今天概览\n见了张总" });
    const usage = await repository.usageRollup("2026-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z");
    expect(usage.find((r) => r.feature === "daily")).toBeTruthy();
  });

  it("别的日子没有材料就不生成，也不花钱", async () => {
    const repository = new MemoryRepository();
    await seed(repository);
    const llm = new ScriptedLlm([]);
    await expect(service(repository, llm).generate("owner", "2026-09-18", "high")).rejects.toThrow("没什么可总结");
    expect(llm.calls).toHaveLength(0);
  });

  it("定时：21:30 前不写；打开了才写；写过不重写", async () => {
    const repository = new MemoryRepository();
    await seed(repository);
    const llm = new ScriptedLlm(["小结"]);
    const now = new Date().toISOString();
    await repository.createUser({ id: "owner", email: "o@example.com", displayName: "o", role: "admin", status: "active",
      createdAt: now, updatedAt: now, passwordHash: "x" } as never);
    const s = service(repository, llm);
    const at = (hhmm: string) => Date.parse(`2026-09-19T${hhmm}:00.000Z`) - 8 * 3_600_000;
    expect(await s.tick(at("22:00"))).toBe(0);                     // 没打开
    const settings = new SettingsService(repository, "high");
    const cur = await settings.get("owner");
    await repository.saveUserSettings({ ...cur, prefs: { ...cur.prefs, ai: { ...cur.prefs.ai, daily: true } } });
    expect(await s.tick(at("21:00"))).toBe(0);                     // 还没到点
    expect(await s.tick(at("21:40"))).toBe(1);
    expect(await s.tick(at("22:40"))).toBe(0);                     // 今天写过了
  });
});

describe("纪要待办转飞书任务", () => {
  it("一条待办一张飞书任务卡，时间按北京时间换算，要不要先问照执行规则", async () => {
    const repository = new MemoryRepository();
    const { topic } = await seed(repository);
    const [minutes] = await repository.listOutputs([topic.id]);
    const llm = new ScriptedLlm([JSON.stringify({ tasks: [
      { summary: "把报价发给张总", description: "我负责", due: "2026-09-25 18:00" },
      { summary: "整理去年合同", description: "小李负责", due: "" },
    ] })]);
    const drafts = await service(repository, llm).todosToTasks(minutes!.id, "owner", "high");
    expect(drafts.map((d) => [d.tool, d.title])).toEqual([["feishu.task.create", "把报价发给张总"], ["feishu.task.create", "整理去年合同"]]);
    expect(drafts[0]!.evidence).toContain("周五前把报价发给张总");
    expect(drafts[0]!.args.dueTimestampMs).toBe(Date.parse("2026-09-25T10:00:00.000Z"));
    expect(drafts[1]!.args.dueTimestampMs).toBeUndefined();
    // 别人的纪要：当作不存在
    await expect(service(repository, llm).todosToTasks(minutes!.id, "someone-else", "high")).rejects.toThrow("纪要不存在");
  });
});

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { OutputService, cleanTree } from "../src/ai/outputs.js";
import { TopicService, normalize } from "../src/ai/topics.js";
import type { ChatMessage, LlmClient, LlmReply, ToolSpec } from "../src/ai/llm.js";
import { loadConfig } from "../src/config.js";
import { MockToolExecutor } from "../src/connectors/mock.js";
import { PricingService } from "../src/services/pricing.js";
import { SettingsService } from "../src/services/settings.js";
import { MemoryRepository } from "../src/store/memory.js";

/* AI 主题、纪要、导图、聊天。大模型用脚本替身：按顺序吐出预设的回答，
 * 测的是我们怎么用它的结果——行号换算成时间、人工主题不被覆盖、聊天办事走确认规则。*/

class ScriptedLlm implements LlmClient {
  readonly enabled = true;
  calls: { messages: ChatMessage[]; tools?: ToolSpec[] }[] = [];
  constructor(private readonly script: Partial<LlmReply>[]) {}
  modelFor() { return "qwen-flash"; }
  async chat(_model: string, messages: ChatMessage[], options: { tools?: ToolSpec[] } = {}): Promise<LlmReply> {
    this.calls.push({ messages: [...messages], tools: options.tools });
    const next = this.script.shift() ?? { content: "（脚本用完）" };
    return { content: next.content ?? "", toolCalls: next.toolCalls ?? [], usage: { inputTokens: 100, outputTokens: 20 }, model: "qwen-flash" };
  }
}

const ADMIN = { authorization: "Bearer test-admin-key-123456" };

async function seedSession(repository: MemoryRepository, lines: [number, string][]) {
  const sessionId = randomUUID();
  await repository.createSession({ id: sessionId, deviceId: "evt", userId: "owner", startedAt: "2026-09-19T01:00:00.000Z" });
  const now = new Date().toISOString();
  for (const [i, [startMs, text]] of lines.entries()) {
    await repository.finishTranscript({ sessionId, sequence: i, text, startMs, endMs: startMs + 5000, provider: "t",
      status: "succeeded", error: null, kind: "speech", endSequence: null, createdAt: now, updatedAt: now });
  }
  return sessionId;
}

describe("拆主题", () => {
  it("模型回的行号换算成录音里的毫秒，首尾相接", async () => {
    const repository = new MemoryRepository();
    const id = await seedSession(repository, [[0, "张总您好"], [600_000, "续约价格"], [3_600_000, "中午吃什么"], [4_200_000, "面条吧"]]);
    const llm = new ScriptedLlm([{ content: JSON.stringify({ topics: [
      { from: 0, to: 1, title: "拜访张总：谈续约", summary: "谈续约价格" },
      { from: 2, to: 3, title: "午饭", summary: "决定吃面" },
    ] }) }]);
    const service = new TopicService({ repository, llm, settings: new SettingsService(repository, "high"), pricing: new PricingService(repository) });
    const topics = await service.analyze(id, 0, Number.MAX_SAFE_INTEGER, "high");
    expect(topics.map((t) => [t.title, t.startMs, t.endMs])).toEqual([["拜访张总：谈续约", 0, 605_000], ["午饭", 3_600_000, 4_205_000]]);
    // 给模型看的是带行号和北京时间的转写
    expect(llm.calls[0]!.messages[1]!.content).toContain("[0] 09:00:00 张总您好");
    // 记了账
    expect((await repository.usageRollup("2026-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z")).some((r) => r.kind === "llm")).toBe(true);
  });

  it("人改过的主题重新拆分时不被覆盖，AI 的不和它重叠", async () => {
    const repository = new MemoryRepository();
    const id = await seedSession(repository, [[0, "a"], [60_000, "b"], [120_000, "c"]]);
    const now = new Date().toISOString();
    await repository.createTopic({ id: randomUUID(), sessionId: id, userId: "owner", startMs: 0, endMs: 65_000, title: "我自己划的",
      summary: "", source: "user", createdAt: now, updatedAt: now });
    const llm = new ScriptedLlm([{ content: JSON.stringify({ topics: [{ from: 0, to: 1, title: "AI 觉得的" }, { from: 2, to: 2, title: "第二段" }] }) }]);
    const service = new TopicService({ repository, llm, settings: new SettingsService(repository, "high"), pricing: new PricingService(repository) });
    await service.analyze(id, 0, Number.MAX_SAFE_INTEGER, "high");
    expect((await repository.listTopics(id)).map((t) => t.title)).toEqual(["我自己划的", "第二段"]);
  });

  it("接着上一段聊的，延长上一个主题而不是另起一段", async () => {
    const repository = new MemoryRepository();
    const id = await seedSession(repository, [[0, "会议开始"], [60_000, "继续讨论"]]);
    const settings = new SettingsService(repository, "high");
    const pricing = new PricingService(repository);
    const first = new TopicService({ repository, settings, pricing,
      llm: new ScriptedLlm([{ content: JSON.stringify({ topics: [{ from: 0, to: 0, title: "周会" }] }) }]) });
    await first.analyze(id, 0, 30_000, "high");
    const second = new TopicService({ repository, settings, pricing,
      llm: new ScriptedLlm([{ content: JSON.stringify({ topics: [{ from: 0, to: 0, title: "周会（续）", continues: true }] }) }]) });
    await second.analyze(id, 30_000, Number.MAX_SAFE_INTEGER, "high");
    const topics = await repository.listTopics(id);
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({ title: "周会", endMs: 65_000 });
  });

  it("关掉自动拆主题就不拆；长时间开机按用户设的小时数拆", async () => {
    const repository = new MemoryRepository();
    const id = await seedSession(repository, [[0, "a"], [3_600_000, "一小时后"]]);
    // 让它看起来还在录（刚刚有上传）
    await repository.putChunk({ sessionId: id, sequence: 0, sha256: "x".repeat(64), objectKey: "k", contentType: "audio/pcm",
      byteLength: 1, startMs: 0, durationMs: 5000, uploadedAt: new Date().toISOString() });
    const settings = new SettingsService(repository, "high");
    const llm = new ScriptedLlm([{ content: JSON.stringify({ topics: [{ from: 0, to: 1, title: "一段" }] }) }]);
    const service = new TopicService({ repository, llm, settings, pricing: new PricingService(repository) });
    expect(await service.tick()).toBe(0);                  // 默认 2 小时，才录了 1 小时
    const s = await settings.get("owner");
    await settings.save({ ...s, prefs: { ...s.prefs, topicIntervalHours: 1 } });
    expect(await service.tick()).toBe(1);
    await settings.save({ ...s, prefs: { ...s.prefs, topicIntervalHours: 1, ai: { ...s.prefs.ai, topics: false } } });
    await repository.setTopicsUntil(id, 0);
    expect(await service.tick()).toBe(0);
  });

  it("模型给的区间乱七八糟时也能规整成首尾相接", () => {
    expect(normalize([{ from: 3, to: 9, title: "b" }, { from: 0, to: 1, title: "a" }], 6).map((t) => [t.from, t.to]))
      .toEqual([[0, 1], [2, 5]]);        // 缝里的行归给后一个主题
    expect(normalize([], 4)).toEqual([expect.objectContaining({ from: 0, to: 3 })]);
  });
});

describe("纪要与导图", () => {
  it("导图树截到 3 层、每层 7 个", () => {
    const wide = { title: "根", children: Array.from({ length: 10 }, (_, i) => ({ title: `枝${i}`,
      children: [{ title: "叶", children: [{ title: "孙", children: [{ title: "太深了" }] }] }] })) };
    const tree = cleanTree(wide);
    expect(tree.children).toHaveLength(7);
    expect(tree.children![0]!.children![0]!.children![0]!.children).toBeUndefined();
  });

  it("录音还在继续时，最后一个主题先不生成；结束后补上", async () => {
    const repository = new MemoryRepository();
    const id = await seedSession(repository, [[0, "甲"], [60_000, "乙"]]);
    const now = new Date().toISOString();
    for (const [i, title] of ["上午", "下午"].entries()) {
      await repository.createTopic({ id: randomUUID(), sessionId: id, userId: "owner", startMs: i * 60_000, endMs: i * 60_000 + 5000,
        title, summary: "", source: "ai", createdAt: now, updatedAt: now });
    }
    const llm = new ScriptedLlm([{ content: "## 概要\n上午" }, { content: "## 概要\n下午" }]);
    const outputs = new OutputService({ repository, llm, pricing: new PricingService(repository) });
    const prefs = { minutes: true, mindmap: false, scope: "topic" as const };
    expect(await outputs.autoGenerate(prefs, "high", id, false)).toBe(1);
    expect(await outputs.autoGenerate(prefs, "high", id, true)).toBe(1);      // 只补"下午"
    expect(await outputs.autoGenerate(prefs, "high", id, true)).toBe(0);      // 都有了
  });
});

describe("AI 聊天", () => {
  let repository: MemoryRepository;
  let app: Awaited<ReturnType<typeof createApp>>;
  afterEach(async () => { await app?.close(); });

  async function start(script: Partial<LlmReply>[]) {
    repository = new MemoryRepository();
    app = await createApp({
      config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: "test-device-key-123456", ADMIN_API_KEY: "test-admin-key-123456",
        BOOTSTRAP_ADMIN_PASSWORD: "fixture-owner-pw" }),
      repository, executor: new MockToolExecutor(), llm: new ScriptedLlm(script),
    });
  }
  const call = (name: string, args: object) => ({ id: randomUUID(), type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

  it("聊天和语音共用登记设备提示，物理控制仍生成待确认卡片", async () => {
    repository = new MemoryRepository();
    const hints = "空调：deviceId=home-ac-ir；command=cool_25";
    const llm = new ScriptedLlm([{ toolCalls: [call("create_action", { tool: "iot.ir.send", title: "打开空调",
      args: { deviceId: "home-ac-ir", command: "cool_25" } })] }, { content: "请确认" }]);
    app = await createApp({ config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: "test-device-key-123456",
      ADMIN_API_KEY: "test-admin-key-123456", BOOTSTRAP_ADMIN_PASSWORD: "fixture-owner-pw", EVA_DEVICE_HINTS: hints }),
      repository, executor: new MockToolExecutor(), llm });
    await repository.upsertToolPolicy({ userId: "owner", tool: "iot.ir.send", confirmation: "always",
      extract: "follow", maxDraftAgeSec: 60, notifyDevice: true, updatedAt: new Date().toISOString() });
    const r = await app.inject({ method: "POST", url: "/v1/chat", headers: ADMIN,
      payload: { messages: [{ role: "user", content: "打开空调" }] } });
    expect(r.statusCode).toBe(200);
    expect(r.json().actions[0]).toMatchObject({ tool: "iot.ir.send", status: "pending" });
    expect(llm.calls[0]!.messages.some((m) => m.role === "system" && m.content?.includes(hints))).toBe(true);
  });

  it("查录音：答案带出处，出处能定位到那一句", async () => {
    await start([{ toolCalls: [call("search_recordings", { query: "预算" })] }, { content: "客户说预算八十万 [1]" }]);
    await seedSession(repository, [[0, "客户说预算上限是八十万"]]);
    const r = await app.inject({ method: "POST", url: "/v1/chat", headers: ADMIN, payload: { messages: [{ role: "user", content: "客户预算多少" }] } });
    expect(r.statusCode).toBe(200);
    expect(r.json().reply).toContain("[1]");
    expect(r.json().citations[0]).toMatchObject({ startMs: 0 });
  });

  it("让它发飞书消息：只生成卡片等确认（对外动作默认每次都要签）", async () => {
    await start([{ toolCalls: [call("create_action", { tool: "feishu.message.send", title: "告诉王总合同周五签",
      args: { receiveId: "ou_x", receiveIdType: "open_id", text: "合同周五签" } })] }, { content: "已生成卡片，等你确认" }]);
    const r = await app.inject({ method: "POST", url: "/v1/chat", headers: ADMIN, payload: { messages: [{ role: "user", content: "跟王总说合同周五签" }] } });
    expect(r.json().actions[0]).toMatchObject({ tool: "feishu.message.send", status: "pending" });
    expect((await repository.listDrafts("owner", "pending"))).toHaveLength(1);
  });

  it("记笔记这种只记录的动作按规则直接执行", async () => {
    await start([{ toolCalls: [call("create_action", { tool: "note.create", title: "预算八十万", args: { title: "预算", content: "八十万" } })] },
      { content: "记好了" }]);
    const r = await app.inject({ method: "POST", url: "/v1/chat", headers: ADMIN, payload: { messages: [{ role: "user", content: "记一下预算八十万" }] } });
    expect(r.json().actions[0]).toMatchObject({ status: "executed" });
  });

  it("在「我的」里关掉聊天就不能用", async () => {
    await start([]);
    await app.inject({ method: "PUT", url: "/v1/settings", headers: ADMIN, payload: { prefs: { ai: { chat: false } } } });
    const r = await app.inject({ method: "POST", url: "/v1/chat", headers: ADMIN, payload: { messages: [{ role: "user", content: "你好" }] } });
    expect(r.statusCode).toBe(403);
  });
});

describe("主题接口", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let repository: MemoryRepository;
  beforeEach(async () => {
    repository = new MemoryRepository();
    app = await createApp({
      config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: "test-device-key-123456", ADMIN_API_KEY: "test-admin-key-123456",
        BOOTSTRAP_ADMIN_PASSWORD: "fixture-owner-pw" }),
      repository, executor: new MockToolExecutor(), llm: new ScriptedLlm([{ content: "## 概要\n测试" }]),
    });
  });
  afterEach(async () => { await app.close(); });

  it("人工建、改（改完标成人工）、删，都能用；搜索命中标出所属主题", async () => {
    const id = await seedSession(repository, [[0, "客户说预算上限是八十万"]]);
    const created = await app.inject({ method: "POST", url: `/v1/sessions/${id}/topics`, headers: ADMIN,
      payload: { startMs: 0, endMs: 10_000, title: "拜访张总" } });
    expect(created.statusCode).toBe(201);
    const topicId = created.json().topic.id;
    const search = await app.inject({ method: "GET", url: `/v1/search?q=${encodeURIComponent("预算")}`, headers: ADMIN });
    expect(search.json().hits[0].topic).toMatchObject({ title: "拜访张总" });
    expect(search.json().topics).toHaveLength(0);
    const byTitle = await app.inject({ method: "GET", url: `/v1/search?q=${encodeURIComponent("张总")}`, headers: ADMIN });
    expect(byTitle.json().topics[0]).toMatchObject({ title: "拜访张总" });

    const bad = await app.inject({ method: "PATCH", url: `/v1/topics/${topicId}`, headers: ADMIN, payload: { endMs: 0 } });
    expect(bad.statusCode).toBe(400);
    const minutes = await app.inject({ method: "POST", url: "/v1/outputs", headers: ADMIN,
      payload: { kind: "minutes", targetType: "topic", targetId: topicId, template: "sales" } });
    expect(minutes.statusCode).toBe(201);
    const list = await app.inject({ method: "GET", url: `/v1/sessions/${id}/topics`, headers: ADMIN });
    expect(list.json().outputs[0]).toMatchObject({ kind: "minutes", template: "sales" });
    expect((await app.inject({ method: "DELETE", url: `/v1/topics/${topicId}`, headers: ADMIN })).statusCode).toBe(200);
  });
});

describe("短主题合并", () => {
  it("短于 3 分钟的并进前一个，标题用长的那个", async () => {
    const { mergeShort } = await import("../src/ai/topics.js");
    const m = 60_000;
    const out = mergeShort([
      { startMs: 0, endMs: 20 * m, title: "上午会议", summary: "" },
      { startMs: 20 * m, endMs: 21 * m, title: "咳嗽", summary: "" },
      { startMs: 21 * m, endMs: 40 * m, title: "午饭", summary: "" },
    ], 3 * m);
    expect(out.map((t) => [t.title, t.startMs / m, t.endMs / m])).toEqual([["上午会议", 0, 21], ["午饭", 21, 40]]);
    // 第一个就很短：并进后一个
    const first = mergeShort([{ startMs: 0, endMs: m, title: "开头", summary: "" }, { startMs: m, endMs: 30 * m, title: "正事", summary: "" }], 3 * m);
    expect(first.map((t) => t.title)).toEqual(["正事"]);
  });
});

describe("主题文字把关", () => {
  it("脏话从标题和概要里去掉", async () => {
    const { clean } = await import("../src/ai/topics.js");
    expect(clean("出现情绪爆发，如“我他妈”“没钱了”，内容断续")).not.toContain("他妈");
  });
});

describe("主题文字把关（评价词）", () => {
  it("带评价的分句整句去掉；同名相邻主题合并", async () => {
    const { clean, mergeSameTitle } = await import("../src/ai/topics.js");
    expect(clean("提到孩子上课、租房，内容杂乱，缺乏连贯性。")).toBe("提到孩子上课、租房。");
    const m = mergeSameTitle([{ startMs: 0, endMs: 10, title: "A", summary: "x" }, { startMs: 10, endMs: 20, title: "A", summary: "长一点" }]);
    expect(m).toEqual([{ startMs: 0, endMs: 20, title: "A", summary: "长一点" }]);
  });
});

describe("AI 聊天（健壮性）", () => {
  it("模型给了坏 JSON 参数不会整轮失败；回答里只留引用到的出处并重新编号", async () => {
    const repository = new MemoryRepository();
    const llm = new ScriptedLlm([
      { toolCalls: [{ id: "a", type: "function", function: { name: "search_recordings", arguments: "{query: 预算" } }] },
      { toolCalls: [{ id: "b", type: "function", function: { name: "search_recordings", arguments: JSON.stringify({ query: "预算" }) } }] },
      { content: "预算八十万 [2]" },
    ]);
    const app = await createApp({
      config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: "test-device-key-123456", ADMIN_API_KEY: "test-admin-key-123456",
        BOOTSTRAP_ADMIN_PASSWORD: "fixture-owner-pw" }),
      repository, executor: new MockToolExecutor(), llm,
    });
    await seedSession(repository, [[0, "客户说预算上限是八十万"], [60_000, "预算要走审批"]]);
    const r = await app.inject({ method: "POST", url: "/v1/chat", headers: ADMIN, payload: { messages: [{ role: "user", content: "预算" }] } });
    expect(r.statusCode).toBe(200);
    expect(r.json().reply).toBe("预算八十万 [1]");
    expect(r.json().citations).toHaveLength(1);
    // 回传给模型的 tool_calls 参数都是合法 JSON
    for (const call of llm.calls) for (const m of call.messages) for (const tc of m.tool_calls ?? []) expect(() => JSON.parse(tc.function.arguments)).not.toThrow();
    await app.close();
  });
});

describe("AI 聊天（模型假装调用工具）", () => {
  it("把写成文本的调用当成真的执行，并且不把 JSON 留在回答里", async () => {
    const repository = new MemoryRepository();
    const app = await createApp({
      config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: "test-device-key-123456", ADMIN_API_KEY: "test-admin-key-123456",
        BOOTSTRAP_ADMIN_PASSWORD: "fixture-owner-pw" }),
      repository, executor: new MockToolExecutor(),
      llm: new ScriptedLlm([
        { content: '已创建笔记。\n\n{"name": "note.create", "arguments": {"title": "亮度调节", "content": "AI入口板要加亮度调节"}}' },
        { content: "已经记下来了。" },
      ]),
    });
    const r = await app.inject({ method: "POST", url: "/v1/chat", headers: ADMIN, payload: { messages: [{ role: "user", content: "帮我记个笔记" }] } });
    expect(r.json().actions[0]).toMatchObject({ tool: "note.create", status: "executed" });
    expect(r.json().reply).not.toContain("arguments");
    await app.close();
  });
});

describe("AI 聊天（不许谎报办好了）", () => {
  it("声称办好了却没调工具：先顶回去，还不调就在回答里说实话", async () => {
    const repository = new MemoryRepository();
    const llm = new ScriptedLlm([{ content: "已为您创建笔记。" }, { content: "已为您创建笔记。" }]);
    const app = await createApp({
      config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: "test-device-key-123456", ADMIN_API_KEY: "test-admin-key-123456",
        BOOTSTRAP_ADMIN_PASSWORD: "fixture-owner-pw" }),
      repository, executor: new MockToolExecutor(), llm,
    });
    const r = await app.inject({ method: "POST", url: "/v1/chat", headers: ADMIN, payload: { messages: [{ role: "user", content: "记个笔记" }] } });
    expect(llm.calls).toHaveLength(2);                       // 顶回去问了第二次
    expect(r.json().reply).toContain("实际上没有执行任何动作");
    expect(r.json().actions).toHaveLength(0);
    await app.close();
  });
});

describe("拆主题进度", () => {
  it("手动整段重拆之后，后面新录的内容还会被自动拆", async () => {
    const repository = new MemoryRepository();
    const id = await seedSession(repository, [[0, "早上好"], [600_000, "继续说"]]);
    const settings = new SettingsService(repository, "high");
    const service = new TopicService({ repository, settings, pricing: new PricingService(repository),
      llm: new ScriptedLlm([{ content: JSON.stringify({ topics: [{ from: 0, to: 1, title: "上午" }] }) },
        { content: JSON.stringify({ topics: [{ from: 0, to: 0, title: "下午" }] }) }]) });
    await service.analyze(id, 0, Number.MAX_SAFE_INTEGER, "high");           // 手动重拆
    const now = new Date().toISOString();
    await repository.finishTranscript({ sessionId: id, sequence: 9, text: "下午又说了话", startMs: 4 * 3_600_000,
      endMs: 4 * 3_600_000 + 5000, provider: "t", status: "succeeded", error: null, kind: "speech", endSequence: null,
      createdAt: now, updatedAt: now });
    expect((await repository.topicCandidates())).toHaveLength(1);            // 新内容还在待拆队列里
    expect(await service.tick()).toBe(1);
  });
});

describe("按住说话", () => {
  it("只分析按住那几句；没按的照常转写但不抽意图", async () => {
    const { TranscriptionService } = await import("../src/services/transcription.js");
    const { ActionService } = await import("../src/services/actions.js");
    const { ExecutionService } = await import("../src/services/execution.js");
    const { AsrRouter, MockAsrProvider } = await import("../src/asr/index.js");
    const { IntentRouter } = await import("../src/intent/provider.js");
    const { FileObjectStore } = await import("../src/storage/file-store.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const repository = new MemoryRepository();
    const dir = await mkdtemp(join(tmpdir(), "voxmind-ptt-"));
    const settings = new SettingsService(repository, "high");
    const asked: string[] = [];
    const intent = { name: "fake",
      async extract() { return []; },
      async extractMetered(text: string) { asked.push(text); return { actions: [], usage: { inputTokens: 10, outputTokens: 1 }, model: "fake" }; } };
    const service = new TranscriptionService({
      repository, objects: new FileObjectStore(dir), asr: new AsrRouter({ high: new MockAsrProvider(), economy: new MockAsrProvider() }),
      intent: new IntentRouter({ high: intent, economy: intent }), actions: new ActionService(repository),
      executions: new ExecutionService(repository, new MockToolExecutor()), settings, pricing: new PricingService(repository),
    });

    const sessionId = randomUUID();
    await repository.createSession({ id: sessionId, deviceId: "evt", userId: "owner", startedAt: new Date().toISOString() });
    const now = new Date().toISOString();
    for (const [i, [startMs, text]] of ([[0, "随便聊两句"], [60_000, "帮我建个飞书任务"]] as [number, string][]).entries()) {
      await repository.finishTranscript({ sessionId, sequence: i, text, startMs, endMs: startMs + 5000, provider: "t",
        status: "succeeded", error: null, kind: "speech", endSequence: null, createdAt: now, updatedAt: now });
      repository.intentStatus.set(`${sessionId}:${i}`, "pending");      // 正常流程里由识别阶段置上
    }
    // 用户在第 60 秒按住 OK 说的那句
    await repository.addSpeechMark(sessionId, 59_000, 66_000);
    const s = await settings.get("owner");
    await settings.save({ ...s, prefs: { ...s.prefs, ai: { ...s.prefs.ai, intentMode: "push_to_talk" } } });

    await service.drain(3);
    expect(asked).toEqual(["帮我建个飞书任务"]);          // 没按的那句没送大模型

    // 换回全自动：剩下那句也会被分析
    await settings.save({ ...s, prefs: { ...s.prefs, ai: { ...s.prefs.ai, intentMode: "auto" } } });
    repository.intentStatus.set(`${sessionId}:0`, "pending");
    await service.drain(3);
    expect(asked).toContain("随便聊两句");
    await rm(dir, { recursive: true, force: true });
  });

  it("按住标记比那句话晚到也不丢；等够 20 秒还没标记才当闲聊；全自动不等", async () => {
    const { TranscriptionService } = await import("../src/services/transcription.js");
    const { ActionService } = await import("../src/services/actions.js");
    const { ExecutionService } = await import("../src/services/execution.js");
    const { AsrRouter, MockAsrProvider } = await import("../src/asr/index.js");
    const { IntentRouter } = await import("../src/intent/provider.js");
    const { FileObjectStore } = await import("../src/storage/file-store.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const repository = new MemoryRepository();
    const dir = await mkdtemp(join(tmpdir(), "voxmind-ptt-late-"));
    const settings = new SettingsService(repository, "high");
    const asked: string[] = [];
    const intent = { name: "fake",
      async extract() { return []; },
      async extractMetered(text: string) { asked.push(text); return { actions: [], usage: { inputTokens: 10, outputTokens: 1 }, model: "fake" }; } };
    const service = new TranscriptionService({
      repository, objects: new FileObjectStore(dir), asr: new AsrRouter({ high: new MockAsrProvider(), economy: new MockAsrProvider() }),
      intent: new IntentRouter({ high: intent, economy: intent }), actions: new ActionService(repository),
      executions: new ExecutionService(repository, new MockToolExecutor()), settings, pricing: new PricingService(repository),
    });
    const sessionId = randomUUID();
    await repository.createSession({ id: sessionId, deviceId: "evt", userId: "owner", startedAt: new Date().toISOString() });
    const segment = async (sequence: number, startMs: number, text: string, createdAt: string) => {
      await repository.finishTranscript({ sessionId, sequence, text, startMs, endMs: startMs + 4000, provider: "t",
        status: "succeeded", error: null, kind: "speech", endSequence: null, createdAt, updatedAt: createdAt });
      repository.intentStatus.set(`${sessionId}:${sequence}`, "pending");
    };
    const s = await settings.get("owner");
    await settings.save({ ...s, prefs: { ...s.prefs, ai: { ...s.prefs.ai, intentMode: "push_to_talk" } } });

    // 按着说完了，但还没松手：话先转出来了，标记还没到
    await segment(0, 10_000, "帮我建个任务明天交周报", new Date().toISOString());
    expect(await service.drain(3)).toBe(0);              // 放回去等，而且不算干了活（否则处理循环会空转）
    expect(asked).toEqual([]);
    expect(repository.intentStatus.get(`${sessionId}:0`)).toBe("pending");
    // 松手，标记到了：下一轮就分析
    await repository.addSpeechMark(sessionId, 9_000, 22_000);
    await service.drain(3);
    expect(asked).toEqual(["帮我建个任务明天交周报"]);

    // 半分钟前的话，一直没标记：真的是闲聊，跳过
    await segment(1, 40_000, "今天天气不错", new Date(Date.now() - 30_000).toISOString());
    await service.drain(3);
    expect(asked).not.toContain("今天天气不错");
    expect(repository.intentStatus.get(`${sessionId}:1`)).toBe("skipped");

    // 全自动模式：没标记也立刻分析，不等
    await settings.save({ ...s, prefs: { ...s.prefs, ai: { ...s.prefs.ai, intentMode: "auto" } } });
    await segment(2, 80_000, "记一下买了咖啡", new Date().toISOString());
    await service.drain(3);
    expect(asked).toContain("记一下买了咖啡");
    await rm(dir, { recursive: true, force: true });
  });
});

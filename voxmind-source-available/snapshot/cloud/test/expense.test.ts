import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AsrRouter, MockAsrProvider } from "../src/asr/index.js";
import { FeishuUserExecutor } from "../src/connectors/feishu-user.js";
import { MockToolExecutor } from "../src/connectors/mock.js";
import type { ActionDraft } from "../src/domain.js";
import { IntentRouter, type IntentCandidate } from "../src/intent/provider.js";
import { SecretBox } from "../src/security/secrets.js";
import { ActionService } from "../src/services/actions.js";
import { ExecutionService } from "../src/services/execution.js";
import { PricingService } from "../src/services/pricing.js";
import { SettingsService } from "../src/services/settings.js";
import { TranscriptionService } from "../src/services/transcription.js";
import { FileObjectStore } from "../src/storage/file-store.js";
import { MemoryRepository } from "../src/store/memory.js";

/* 记账：说「午饭花了68」→ 写进飞书多维表格的消费记录表 → 给自己发一条飞书消息。
 * 盯的是：表没配好时不生成注定失败的卡片、类别只认用户表里有的、每类动作能单独设抽不抽。*/

const EXPENSE = {
  enabled: true, appToken: "appX", tableId: "tblX",
  fields: { note: "备注", dateText: "日期文本", date: "日期", amount: "金额", category: "类别" },
  categories: ["餐饮", "交通", "其他"], notifyFeishu: true,
};

async function pipeline(candidates: IntentCandidate[]) {
  const repository = new MemoryRepository();
  const dir = await mkdtemp(join(tmpdir(), "voxmind-expense-"));
  const settings = new SettingsService(repository, "high");
  const done: ActionDraft[] = [];
  const executor = { async execute(draft: ActionDraft) { done.push(draft); return { provider: "t", externalId: "r1", result: {} }; } };
  const intent = { name: "fake", async extract() { return candidates; },
    async extractMetered() { return { actions: candidates, usage: { inputTokens: 10, outputTokens: 1 }, model: "fake" }; } };
  const service = new TranscriptionService({
    repository, objects: new FileObjectStore(dir), asr: new AsrRouter({ high: new MockAsrProvider(), economy: new MockAsrProvider() }),
    intent: new IntentRouter({ high: intent, economy: intent }), actions: new ActionService(repository),
    executions: new ExecutionService(repository, executor), settings, pricing: new PricingService(repository),
  });
  const sessionId = randomUUID();
  await repository.createSession({ id: sessionId, deviceId: "evt", userId: "owner", startedAt: "2026-09-20T01:00:00.000Z" });
  const now = new Date().toISOString();
  await repository.finishTranscript({ sessionId, sequence: 0, text: "午饭花了68", startMs: 0, endMs: 5000, provider: "t",
    status: "succeeded", error: null, kind: "speech", endSequence: null, createdAt: now, updatedAt: now });
  repository.intentStatus.set(`${sessionId}:0`, "pending");
  return { repository, settings, service, done, dir, sessionId };
}

const candidate = (args: Record<string, unknown>): IntentCandidate => ({
  tool: "expense.record", title: "午饭 68 元", detail: "", args, evidence: "午饭花了68",
  confidence: 0.95, mode: "explicit", risk: "personal_write",
});

describe("记账", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => { await cleanup?.(); cleanup = undefined; });

  it("说「午饭花了68」：带上表、字段、日期写成一张卡片", async () => {
    const { settings, service, done, dir } = await pipeline([candidate({ amount: 68, category: "餐饮", note: "午饭" })]);
    cleanup = () => rm(dir, { recursive: true, force: true });
    const s = await settings.get("owner");
    await settings.save({ ...s, prefs: { ...s.prefs, expense: EXPENSE } });
    await service.drain(3);
    expect(done).toHaveLength(1);
    expect(done[0]!.args).toMatchObject({ appToken: "appX", tableId: "tblX", amount: 68, category: "餐饮", note: "午饭", notify: true });
    // 没说哪天：按这句话录下来的时刻算（北京时间 9 月 20 日上午 9 点）
    expect(new Date(Number(done[0]!.args.atMs) + 8 * 3600_000).toISOString().slice(0, 10)).toBe("2026-09-20");
  });

  it("表没配好就不生成卡片——不留一张注定失败的", async () => {
    const { service, done, dir } = await pipeline([candidate({ amount: 68, category: "餐饮" })]);
    cleanup = () => rm(dir, { recursive: true, force: true });
    await service.drain(3);           // 默认 enabled=false
    expect(done).toHaveLength(0);
  });

  it("模型给的类别不在你表里就算「其他」；金额不对的整条丢掉", async () => {
    const { settings, service, done, dir } = await pipeline([
      candidate({ amount: 20, category: "宠物", note: "猫粮" }),
      candidate({ amount: "不知道", category: "餐饮" }),
    ]);
    cleanup = () => rm(dir, { recursive: true, force: true });
    const s = await settings.get("owner");
    await settings.save({ ...s, prefs: { ...s.prefs, expense: EXPENSE } });
    await service.drain(3);
    expect(done.map((d) => d.args.category)).toEqual(["其他"]);
  });

  it("这一类可以单独关掉，别的类型不受影响", async () => {
    const { repository, settings, service, done, dir } = await pipeline([candidate({ amount: 68, category: "餐饮" })]);
    cleanup = () => rm(dir, { recursive: true, force: true });
    const s = await settings.get("owner");
    await settings.save({ ...s, prefs: { ...s.prefs, expense: EXPENSE } });
    await repository.upsertToolPolicy({ userId: "owner", tool: "expense.record", confirmation: "explicit_only",
      maxDraftAgeSec: 86_400, notifyDevice: true, extract: "off", updatedAt: new Date().toISOString() });
    await service.drain(3);
    expect(done).toHaveLength(0);
  });
});

describe("写进飞书多维表格", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it("一条记录写进消费记录表，并给自己发一条带表格链接的消息", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => raw += c);
      req.on("end", () => {
        seen.push({ url: req.url!, body: raw ? JSON.parse(raw) as Record<string, unknown> : {} });
        res.setHeader("content-type", "application/json");
        if (req.url!.includes("/authen/v1/user_info")) res.end(JSON.stringify({ code: 0, data: { open_id: "ou_me" } }));
        else if (req.url!.includes("/records")) res.end(JSON.stringify({ code: 0, data: { record: { record_id: "rec1" } } }));
        else res.end(JSON.stringify({ code: 0, data: { message_id: "om_1" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
    close = () => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));

    const repository = new MemoryRepository();
    const secrets = new SecretBox("0".repeat(64));
    await repository.upsertIntegration("owner", "feishu", secrets.encrypt({ appId: "cli_x", appSecret: "s",
      accessToken: "u-token", accessExpiresAt: Math.floor(Date.now() / 1000) + 3600 }));
    const executor = new FeishuUserExecutor(repository, secrets, `http://127.0.0.1:${address.port}`);
    const now = new Date().toISOString();
    const draft: ActionDraft = { id: randomUUID(), sessionId: randomUUID(), userId: "owner", tool: "expense.record",
      title: "午饭 68 元", detail: "", evidence: "午饭花了68", evidenceStartMs: null, evidenceEndMs: null, confidence: 1,
      mode: "explicit", risk: "personal_write", status: "confirmed", revision: 1, idempotencyKey: "k".repeat(10),
      createdAt: now, updatedAt: now,
      args: { appToken: "appX", tableId: "tblX", amount: 68, category: "餐饮", note: "午饭",
        atMs: Date.parse("2026-09-20T04:00:00.000Z"), fields: EXPENSE.fields, notify: true } };

    const receipt = await executor.execute(draft);
    expect(receipt).toMatchObject({ externalId: "rec1" });
    const write = seen.find((r) => r.url.includes("/records"))!;
    expect(write.url).toBe("/open-apis/bitable/v1/apps/appX/tables/tblX/records");
    expect(write.body.fields).toMatchObject({ 备注: "午饭", 金额: 68, 类别: "餐饮", 日期文本: "2026-09-20" });
    const msg = seen.find((r) => r.url.includes("/im/v1/messages"))!;
    expect(String((msg.body as { content: string }).content)).toContain("已记一笔：68 元");
    expect(String((msg.body as { content: string }).content)).toContain("https://feishu.cn/base/appX?table=tblX");
  });

  it("不要通知时就只写表，不发消息", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.url!);
      let raw = ""; req.on("data", (c) => raw += c);
      req.on("end", () => { res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ code: 0, data: { record: { record_id: "rec2" } } })); });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
    close = () => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    const repository = new MemoryRepository();
    const secrets = new SecretBox("0".repeat(64));
    await repository.upsertIntegration("owner", "feishu", secrets.encrypt({ appId: "cli_x", appSecret: "s",
      accessToken: "u-token", accessExpiresAt: Math.floor(Date.now() / 1000) + 3600 }));
    const executor = new FeishuUserExecutor(repository, secrets, `http://127.0.0.1:${address.port}`);
    const now = new Date().toISOString();
    await executor.execute({ id: randomUUID(), sessionId: randomUUID(), userId: "owner", tool: "expense.record",
      title: "打车 25", detail: "", evidence: "", evidenceStartMs: null, evidenceEndMs: null, confidence: 1,
      mode: "explicit", risk: "personal_write", status: "confirmed", revision: 1, idempotencyKey: "k".repeat(10),
      createdAt: now, updatedAt: now,
      args: { appToken: "appX", tableId: "tblX", amount: 25, category: "交通", note: "打车",
        atMs: Date.now(), fields: EXPENSE.fields, notify: false } });
    expect(seen.some((u) => u.includes("/im/v1/messages"))).toBe(false);
  });
});

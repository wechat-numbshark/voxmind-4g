import { createHash, randomUUID } from "node:crypto";
import type { AiOutput, QualityTier } from "../domain.js";
import { normalizeActionArgs } from "../intent/time.js";
import type { ActionService } from "../services/actions.js";
import type { PricingService } from "../services/pricing.js";
import type { SettingsService } from "../services/settings.js";
import type { Repository } from "../store/repository.js";
import { parseJson, type LlmClient } from "./llm.js";

/* 每日小结 + 纪要待办转飞书任务。
 *
 * 小结：晚上把今天拆出的主题、纪要里的待办、今天的动作卡片汇成一页——
 * 见了谁、定了什么、还有什么没做。只用已经有的主题和概要，不再把整天的原文喂一遍（那样一天要几块钱）。
 * 默认关，用户在「我的 → AI」里打开；打开后每天 21:30 以后生成一次，也可以随时手动生成。*/

const DAY_MS = 86_400_000;
const BJ = 8 * 3_600_000;

/** 北京时间的日期 YYYY-MM-DD */
export function beijingDay(ms = Date.now()) {
  return new Date(ms + BJ).toISOString().slice(0, 10);
}
/** 这一天北京时间 00:00 的时间戳 */
export function dayStartMs(day: string) {
  return Date.parse(`${day}T00:00:00.000Z`) - BJ;
}
/** 一个用户一天一份：用 用户+日期 算出固定的 id，存在输出表里 */
export function dailyTargetId(userId: string, day: string) {
  const h = createHash("sha1").update(`daily:${userId}:${day}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => { const d = new Date(ms + BJ); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };

/** 从纪要 Markdown 里取出「待办」那一节的条目 */
export function todoLines(markdown: string) {
  const m = markdown.match(/##\s*[^\n]*待办[^\n]*\n([\s\S]*?)(?=\n##\s|$)/);
  if (!m) return [];
  return m[1]!.split("\n").map((l) => l.replace(/^\s*(?:[-*]|\d+[.、)])\s*/, "").trim())
    .filter((l) => l && l !== "无" && !/^[（(]?无[)）]?$/.test(l));
}

export class DailyService {
  constructor(private readonly deps: { repository: Repository; llm: LlmClient; pricing: PricingService;
    settings: SettingsService; actions: ActionService }) {}

  async get(userId: string, day: string): Promise<AiOutput | null> {
    const [latest] = await this.deps.repository.listOutputs([dailyTargetId(userId, day)]);
    return latest ?? null;
  }

  /** 收集这一天的材料：主题（带时间）、纪要里的待办、动作卡片 */
  private async material(userId: string, day: string) {
    const from = dayStartMs(day), to = from + DAY_MS;
    const sessions = (await this.deps.repository.listSessionSummaries(300, userId))
      .filter((s) => Date.parse(s.startedAt) < to && Date.parse(s.startedAt) + s.durationMs + 3_600_000 >= from);
    const started = new Map(sessions.map((s) => [s.id, Date.parse(s.startedAt)]));
    const topics = (await this.deps.repository.topicsForSessions(sessions.map((s) => s.id)))
      .map((t) => ({ ...t, at: (started.get(t.sessionId) ?? 0) + t.startMs }))
      .filter((t) => t.at >= from && t.at < to)
      .sort((a, b) => a.at - b.at);
    const minutes = (await this.deps.repository.listOutputs(topics.map((t) => t.id))).filter((o) => o.kind === "minutes");
    const todos = topics.flatMap((t) => {
      const latest = minutes.find((o) => o.targetId === t.id);
      return latest ? todoLines(latest.content).map((line) => `${t.title}：${line}`) : [];
    });
    const drafts = (await this.deps.repository.listDrafts(userId))
      .filter((d) => Date.parse(d.createdAt) >= from && Date.parse(d.createdAt) < to);
    const totals = await this.deps.repository.dayTotals(userId, new Date(from).toISOString());
    return { topics, todos, drafts, totals };
  }

  async generate(userId: string, day: string, tier: QualityTier): Promise<AiOutput> {
    const m = await this.material(userId, day);
    if (!m.topics.length && !m.drafts.length) throw new Error("这一天还没有拆出主题，也没有动作，没什么可总结的");
    const status: Record<string, string> = { executed: "已办", failed: "失败", pending: "等确认", cancelled: "退回",
      expired: "作废", confirmed: "执行中", executing: "执行中" };
    const lines = [
      `日期：${day}，录了 ${Math.round(m.totals.recordedMs / 60_000)} 分钟，${m.totals.sentences} 句话`,
      "", "主题（时间 标题：概要）：",
      ...m.topics.map((t) => `- ${clock(t.at)} ${t.title}：${t.summary}`),
      "", "纪要里的待办：", ...(m.todos.length ? m.todos.map((t) => `- ${t}`) : ["- 无"]),
      "", "今天生成的动作：", ...(m.drafts.length ? m.drafts.map((d) => `- [${status[d.status] ?? d.status}] ${d.title}${d.detail ? `（${d.detail}）` : ""}`) : ["- 无"]),
    ];
    const model = this.deps.llm.modelFor(tier);
    const reply = await this.deps.llm.chat(model, [
      { role: "system", content: `你根据随身录音设备一天的记录，给用户写今天的小结。用中文 Markdown，按下面结构，没有内容的小节写"无"：
## 今天概览（两三句话）
## 见了谁、聊了什么（按时间，每条一行：时间 + 一句话）
## 定下来的事
## 还没做的事（纪要待办 + 等确认/失败的动作；写清谁、什么时候，没说就写"未提"）
## 已经办了的
要求：只用给你的材料，不编人名、数字和日期；语气平实，不评价人；不要开场白。` },
      { role: "user", content: lines.join("\n") },
    ], { timeoutMs: 120_000 });
    await this.deps.repository.recordUsage({ at: new Date().toISOString(), userId, sessionId: null, kind: "llm", feature: "daily",
      provider: "dashscope", model, tier, audioMs: 0, inputTokens: reply.usage.inputTokens, outputTokens: reply.usage.outputTokens,
      costYuan: await this.deps.pricing.llmCost(model, reply.usage.inputTokens, reply.usage.outputTokens) });
    return this.deps.repository.createOutput({ id: randomUUID(), userId, targetType: "day", targetId: dailyTargetId(userId, day),
      kind: "daily", template: day, content: reply.content.trim(), model, createdAt: new Date().toISOString() });
  }

  /** 定时：打开了每日小结的用户，21:30 以后、今天还没有、今天确实说过话，就生成一份 */
  async tick(now = Date.now()) {
    const bj = new Date(now + BJ);
    if (bj.getUTCHours() * 60 + bj.getUTCMinutes() < 21 * 60 + 30) return 0;
    const day = beijingDay(now);
    let made = 0;
    for (const user of await this.deps.repository.listUsers()) {
      const s = await this.deps.settings.get(user.id);
      if (!s.prefs.ai.daily || await this.get(user.id, day)) continue;
      const totals = await this.deps.repository.dayTotals(user.id, new Date(dayStartMs(day)).toISOString());
      if (!totals.sentences) continue;
      await this.generate(user.id, day, s.tier).then(() => made++).catch(() => {});
    }
    return made;
  }

  /** 把一份纪要里的待办变成飞书任务卡片。要不要先问用户，照「执行规则」来——和说话、聊天里建的任务一样 */
  async todosToTasks(outputId: string, userId: string, tier: QualityTier) {
    const output = (await this.findOutput(outputId, userId));
    if (!output || output.kind !== "minutes") throw new Error("纪要不存在");
    const todos = todoLines(output.content);
    if (!todos.length) throw new Error("这份纪要里没有待办");
    const topic = output.targetType === "topic" ? await this.deps.repository.getTopic(output.targetId) : null;
    const sessionId = topic?.sessionId ?? output.targetId;
    const session = await this.deps.repository.getSession(sessionId);
    const recordedAt = new Date(Date.parse(session?.startedAt ?? output.createdAt) + (topic?.startMs ?? 0)).toISOString();
    /* 待办的原文是"张三 · 周五前给报价"这种半结构化的句子；用模型拆出标题和截止时间，
     * 时间再过一遍和语音建任务同一套北京时间换算，不让模型直接给时间戳 */
    const model = this.deps.llm.modelFor(tier);
    const reply = await this.deps.llm.chat(model, [
      { role: "system", content: `把会议纪要里的待办整理成任务。只输出 JSON：{"tasks":[{"summary":"动词开头的任务标题，20字内","description":"谁负责、背景","due":"北京时间 YYYY-MM-DD HH:mm，没说时间就留空"}]}。
录音时间是 ${recordedAt}（UTC），"明天""周五"按这个时间换算。一条待办对应一个任务，不要合并、不要新增。` },
      { role: "user", content: todos.map((t, i) => `${i + 1}. ${t}`).join("\n") },
    ], { json: true, timeoutMs: 60_000 });
    await this.deps.repository.recordUsage({ at: new Date().toISOString(), userId, sessionId, kind: "llm", feature: "minutes",
      provider: "dashscope", model, tier, audioMs: 0, inputTokens: reply.usage.inputTokens, outputTokens: reply.usage.outputTokens,
      costYuan: await this.deps.pricing.llmCost(model, reply.usage.inputTokens, reply.usage.outputTokens) });
    const tasks = (parseJson<{ tasks?: { summary?: string; description?: string; due?: string }[] }>(reply.content).tasks ?? [])
      .filter((t) => t.summary?.trim()).slice(0, 20);
    const made = [];
    for (const [i, t] of tasks.entries()) {
      const { args, notes } = normalizeActionArgs("feishu.task.create",
        { summary: t.summary, description: t.description ?? "", ...(t.due ? { due: t.due } : {}) }, recordedAt);
      made.push(await this.deps.actions.createDraft({ sessionId, userId, tool: "feishu.task.create",
        title: String(t.summary).slice(0, 80), detail: [t.description ?? "", ...notes].filter(Boolean).join("；").slice(0, 500),
        args, evidence: `（纪要待办）${todos[i] ?? t.summary}`.slice(0, 1000),
        evidenceStartMs: topic?.startMs ?? null, evidenceEndMs: topic?.endMs ?? null,
        confidence: 1, mode: "explicit", risk: "personal_write" }));
    }
    return made;
  }

  private async findOutput(id: string, userId: string) {
    const out = await this.deps.repository.getOutput(id);
    return out && out.userId === userId ? out : null;
  }
}

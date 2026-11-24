import { randomUUID } from "node:crypto";
import type { QualityTier, Suggestion, Topic, UserPrefs } from "../domain.js";
import { normalizeActionArgs } from "../intent/time.js";
import type { PricingService } from "../services/pricing.js";
import type { Repository } from "../store/repository.js";
import { parseJson, type LlmClient } from "./llm.js";

/* 漏网检查：拆完一个主题，顺手看一遍这一段里有没有"像是要办的事、要记的账"。
 *
 * 为什么要有：用户把模式设成「只分析按住确认键说的」，忘了按的那些话就彻底没人管。
 * 这里不替他动手——只把看出来的东西列出来，等他在网页上点一下才真的建。
 *
 * 怎么做到便宜：
 * 1. 一个主题只问一次模型（不是逐句问），而且用经济档模型；
 * 2. 先用关键词粗筛：这一段里连钱数、时间词、承诺词都没有，直接跳过，连模型都不调；
 * 3. 已经建过的（用户当时按了键、或者全自动模式建过的）不再重复提。*/

/** 粗筛：像不像"有事要办/有账要记"。宁可多放过，也别为一段闲聊花钱 */
const MONEY = /(\d+(\.\d+)?\s*(块|元|毛|角|万)|花了|付了|买了|充值|消费|报销|多少钱|转账|收款)/;
const COMMIT = /(明天|后天|下周|下个月|周[一二三四五六日天]|礼拜[一二三四五六日天]|今晚|上午|下午|晚上|点钟|之前|截止|记得|别忘|提醒|安排|约了|约个|联系|回电|发给|交给|要给|得给|跟进|落实)/;
export function worthScanning(text: string) {
  return MONEY.test(text) || COMMIT.test(text);
}

const MAX_PER_TOPIC = 5;
const MAX_CHARS = 12_000;

const pad = (n: number) => String(n).padStart(2, "0");
function clock(startedAt: string, ms: number) {
  const d = new Date(Date.parse(startedAt) + ms + 8 * 3_600_000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 两条说的是不是同一件事：标题互相包含，或者同一类动作＋同一个金额 */
export function sameThing(a: { tool: string; title: string; args: Record<string, unknown> }, b: { tool: string; title: string; args: Record<string, unknown> }) {
  const x = a.title.replace(/\s/g, ""), y = b.title.replace(/\s/g, "");
  if (x && y && (x.includes(y) || y.includes(x))) return true;
  if (a.tool !== b.tool) return false;
  const amount = (v: Record<string, unknown>) => Number(v.amount ?? NaN);
  return Number.isFinite(amount(a.args)) && amount(a.args) === amount(b.args);
}

export class SuggestService {
  constructor(private readonly deps: { repository: Repository; llm: LlmClient; pricing: PricingService;
    logger?: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void } }) {}

  /** 扫一个主题。返回新存下来的建议（已经去过重、截过条数）。*/
  async scanTopic(topic: Topic, prefs: UserPrefs, tier: QualityTier): Promise<Suggestion[]> {
    if (!prefs.ai.suggest) return [];
    const session = await this.deps.repository.getSession(topic.sessionId);
    if (!session) return [];
    const segments = (await this.deps.repository.listTranscripts(topic.sessionId))
      .filter((t) => t.kind === "speech" && t.status === "succeeded" && t.text.trim()
        && t.startMs >= topic.startMs && t.startMs < topic.endMs)
      .sort((a, b) => a.startMs - b.startMs);
    if (!segments.length) return [];

    const text = segments.map((s) => `${clock(session.startedAt, s.startMs)} ${s.text.trim()}`).join("\n").slice(0, MAX_CHARS);
    if (!worthScanning(text)) return [];

    /* 已经建过的：同一次录音里、时间落在这一段之内的卡片 */
    const existing = (await this.deps.repository.listDrafts(topic.userId))
      .filter((d) => d.sessionId === topic.sessionId && d.evidenceStartMs !== null
        && d.evidenceStartMs >= topic.startMs && d.evidenceStartMs < topic.endMs);
    const already = (await this.deps.repository.listSuggestions(topic.userId, { sessionId: topic.sessionId, limit: 200 }))
      .filter((s) => s.topicId === topic.id);

    const model = this.deps.llm.modelFor(tier);
    const categories = prefs.expense.categories.join("、");
    const reply = await this.deps.llm.chat(model, [
      { role: "system", content: `你从随身录音的一段转写里，挑出"说过、但可能还没处理"的事。只输出 JSON：
{"items":[{"tool":"feishu.task.create|feishu.calendar.create|note.create|expense.record","title":"事情本身，20字内","args":{},"evidence":"原话","at":"HH:mm","confidence":0.0-1.0}]}
规则：
- 只挑真的要办的事和真的花了的钱：有明确动作和对象，或者有金额。"改天聚聚""有空再说"这种不算。
- tool 选法：要做的事→feishu.task.create（args: summary, due 可选 "YYYY-MM-DD HH:mm"）；
  约定了时间地点的会面→feishu.calendar.create（args: summary, start, end 可选）；
  花钱了→expense.record（args: amount 数字, category 从「${categories}」里选, note）；
  只是想记下来→note.create（args: title, content）。
- 最多 ${MAX_PER_TOPIC} 条，按重要程度排。没有就返回 {"items":[]}。
- 时间按转写里每行开头的时刻推算，今天是 ${clock(session.startedAt, topic.startMs).slice(0, 5)} 那天。不确定的时间就不写。
- confidence 低于 0.6 的不要输出。不要编造人名、金额、时间。` },
      { role: "user", content: `这一段的主题是「${topic.title}」。转写：\n${text}` },
    ], { json: true, timeoutMs: 90_000 });

    await this.deps.repository.recordUsage({ at: new Date().toISOString(), userId: topic.userId, sessionId: topic.sessionId,
      kind: "llm", feature: "suggest", provider: "dashscope", model, tier, audioMs: 0,
      inputTokens: reply.usage.inputTokens, outputTokens: reply.usage.outputTokens,
      costYuan: await this.deps.pricing.llmCost(model, reply.usage.inputTokens, reply.usage.outputTokens) });

    const items = parseJson<{ items?: { tool?: string; title?: string; args?: Record<string, unknown>; evidence?: string; confidence?: number }[] }>(reply.content).items ?? [];
    const recordedAt = new Date(Date.parse(session.startedAt) + topic.startMs).toISOString();
    const now = new Date().toISOString();
    const out: Suggestion[] = [];
    for (const item of items) {
      const tool = String(item.tool ?? "");
      if (!["feishu.task.create", "feishu.calendar.create", "note.create", "expense.record"].includes(tool)) continue;
      const title = String(item.title ?? "").trim().slice(0, 80);
      if (!title) continue;
      if ((item.confidence ?? 0.7) < 0.6) continue;
      const raw = item.args && typeof item.args === "object" ? item.args : {};
      const { args } = normalizeActionArgs(tool, raw, recordedAt);
      const candidate = { tool, title, args };
      if (existing.some((d) => sameThing(candidate, d))) continue;          // 已经建过
      if (already.some((s) => sameThing(candidate, s))) continue;           // 上次扫过同一段
      if (out.some((s) => sameThing(candidate, s))) continue;               // 这一批里重复
      out.push({ id: randomUUID(), userId: topic.userId, sessionId: topic.sessionId, topicId: topic.id,
        tool, title, detail: "", args, evidence: String(item.evidence ?? "").slice(0, 1000),
        evidenceStartMs: topic.startMs, evidenceEndMs: topic.endMs,
        confidence: Math.min(1, Math.max(0, item.confidence ?? 0.7)), status: "open", draftId: null,
        createdAt: now, updatedAt: now });
      if (out.length >= MAX_PER_TOPIC) break;
    }
    if (out.length) await this.deps.repository.createSuggestions(out);
    return out;
  }

  /** 拆完一批主题之后扫一遍。出错只记日志——漏网检查失败不该影响拆主题本身 */
  async scanTopics(topics: Topic[], prefs: UserPrefs, tier: QualityTier) {
    let made = 0;
    for (const topic of topics) {
      try { made += (await this.scanTopic(topic, prefs, tier)).length; }
      catch (error) { this.deps.logger?.warn({ topicId: topic.id, error: String(error) }, "漏网检查失败"); }
    }
    return made;
  }
}

import { randomUUID } from "node:crypto";
import type { QualityTier, Topic, TranscriptSegment } from "../domain.js";
import type { PricingService } from "../services/pricing.js";
import type { SettingsService } from "../services/settings.js";
import type { Repository } from "../store/repository.js";
import { parseJson, type LlmClient } from "./llm.js";

/* 自动拆主题。
 *
 * 一次开机可能录一整天：上午拜访客户 A、中午吃饭、下午客户 B。这里把转写按话题切开，
 * 每段给标题和一两句概要。
 *
 * 什么时候拆：
 *   - 录音结束（20 分钟没有新上传）：把没拆过的部分拆掉；
 *   - 一直开着：每攒够用户设置的小时数（默认 2 小时）拆一次。
 * 窗口之间靠 continues 衔接：上一窗最后一个主题还没聊完，下一窗第一个主题接着它，不会从中间劈开。
 *
 * 给模型的是带行号的转写，它回的是行号区间——行号直接对应录音时间，不会像让它写时间那样写错。*/

const ENDED_AFTER_MS = 20 * 60_000;
const MAX_CHARS = 40_000;            // 一次喂给模型的上限；超了按段分批
/* 实测（2026-09-19，2 小时 15 分录音）：只靠提示词，模型切出 19 段，其中好几段 0~2 分钟，
 * 连"咳嗽与短暂停顿"都成了一个主题。所以模型切完这里再并一次：短于 3 分钟的并进前一个。*/
const MIN_TOPIC_MS = 3 * 60_000;

const SYSTEM = `你把一段随身录音的转写按"话题/活动"切成若干主题。录音来自一个整天佩戴的录音设备，
内容可能是会议、客户拜访、电话、吃饭闲聊、独自工作时的自言自语。

切分原则：
- 一个主题是一段连续的、围绕同一件事的对话或活动，比如"拜访客户张总谈续约"、"午饭闲聊"、"和财务对报销"。
- 宁粗勿细：一般 10~30 分钟一个主题，两小时的录音通常切成 3~8 个。同一个会议里换了议题，仍算同一个主题。
- 少于 5 分钟的片段、咳嗽、停顿、零碎的几句话，并进前后相邻的主题，不要单独成段。
- 背景里在播放的视频、播客、课程，合成一个主题，标题写明，比如"在看视频：超音速飞机"。
- 长时间安静（行与行之间隔了十几分钟）通常是自然的分界。
- 每一行都必须属于某个主题，主题按时间顺序排列、首尾相接、不重叠。

标题：16 字以内，写"谁/做什么"，例如"拜访客户王总：谈续约价格"，不要写"主题一"。
概要：60 字以内，说清这段谈了什么、有什么结论。
标题和概要用中性、客观的说法：只说做了什么、谈了什么。这是用户自己的录音，他会看到这些字：
- 不要写"情绪波动""情绪宣泄""情绪失控""精神压力""焦虑""懊悔""缺乏连贯性"这类对人的评价或诊断；
- 不要引用脏话和骂人的话；
- 零散的自言自语，概要只列出提到了哪几件事，比如"提到孩子上课、产品售价、加班"。
- 先判断每一段是谁在说：明显是视频、新闻、节目、课程的内容（主持人口吻、播报腔、讲课），
  标题写"在看视频：……"或"在听课：……"，不要算成用户自己说的话。

只输出 JSON：{"topics":[{"from":起始行号,"to":结束行号,"title":"...","summary":"...","continues":false}]}
如果给了"上一个主题"，并且这一段开头明显是在接着聊它，把第一个主题的 continues 设为 true。`;

interface RawTopic { from: number; to: number; title: string; summary?: string; continues?: boolean }

const pad = (n: number) => String(n).padStart(2, "0");
function clock(startedAt: string, ms: number) {
  const d = new Date(Date.parse(startedAt) + ms + 8 * 3_600_000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export class TopicService {
  private busy = false;
  constructor(private readonly deps: {
    repository: Repository; llm: LlmClient; settings: SettingsService; pricing: PricingService;
    logger?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
    /** 新主题拆出来之后（自动纪要/导图在这里挂） */
    onTopics?: (userId: string, sessionId: string, topics: Topic[], sessionEnded: boolean) => Promise<void>;
  }) {}

  /** 拆 [fromMs, toMs) 这一段。返回新写入的 AI 主题 */
  async analyze(sessionId: string, fromMs: number, toMs: number, tier: QualityTier): Promise<Topic[]> {
    const session = await this.deps.repository.getSession(sessionId);
    if (!session) return [];
    const segs = (await this.deps.repository.listTranscripts(sessionId))
      .filter((t) => t.kind === "speech" && t.status === "succeeded" && t.text.trim() && t.startMs >= fromMs && t.startMs < toMs)
      .sort((a, b) => a.startMs - b.startMs);
    if (!segs.length) { await this.deps.repository.setTopicsUntil(sessionId, toMs); return []; }

    const existing = await this.deps.repository.listTopics(sessionId);
    const userTopics = existing.filter((t) => t.source === "user");
    let previous = existing.filter((t) => t.endMs <= fromMs + 60_000).at(-1) ?? null;

    const created: Topic[] = [];
    for (const batch of batches(segs)) {
      const lines = batch.map((s, i) => `[${i}] ${clock(session.startedAt, s.startMs)} ${s.text.trim()}`).join("\n");
      const model = this.deps.llm.modelFor(tier);
      const reply = await this.deps.llm.chat(model, [
        { role: "system", content: SYSTEM },
        { role: "user", content: `${previous ? `上一个主题：${previous.title}（${previous.summary}）\n\n` : ""}转写（共 ${batch.length} 行）：\n${lines}` },
      ], { json: true, timeoutMs: 180_000 });
      await this.meter(session.userId, sessionId, tier, reply.model, reply.usage.inputTokens, reply.usage.outputTokens);

      const raw = parseJson<{ topics?: RawTopic[] }>(reply.content).topics ?? [];
      const now = new Date().toISOString();
      for (const [k, t] of normalize(raw, batch.length).entries()) {
        const startMs = batch[t.from]!.startMs;
        const endMs = batch[t.to]!.endMs;
        // 接着上一个 AI 主题聊的：把上一个延长，不另起一段
        if (k === 0 && t.continues && previous && previous.source === "ai") {
          const pending = created.find((c) => c.id === previous!.id);
          if (pending) pending.endMs = endMs;             // 同一次拆分里上一批刚建的，还没落库
          else previous = (await this.deps.repository.updateTopic(previous.id, { endMs, updatedAt: now })) ?? previous;
          continue;
        }
        // 和人工主题重叠一半以上的不要：人已经划好了
        const overlapsUser = userTopics.some((u) => overlap(u, startMs, endMs) > (endMs - startMs) / 2);
        if (overlapsUser) continue;
        const topic: Topic = { id: randomUUID(), sessionId, userId: session.userId, startMs, endMs,
          title: cleanTitle(t.title).slice(0, 80), summary: clean(t.summary ?? "").slice(0, 500),
          label: "", source: "ai", createdAt: now, updatedAt: now };
        created.push(topic);
        previous = topic;
      }
    }
    const merged = mergeSameTitle(mergeShort(created, MIN_TOPIC_MS));
    created.length = 0;
    created.push(...merged);
    await this.deps.repository.replaceAiTopics(sessionId, fromMs, toMs, created);
    /* 记"拆到哪儿"用真实的最后一句，而不是调用方给的上界：手动整段重拆时上界是无穷大，
     * 直接存下去的话，这次录音之后再录的内容永远不会被自动拆。*/
    await this.deps.repository.setTopicsUntil(sessionId, Math.min(toMs, segs[segs.length - 1]!.endMs + 1));
    this.deps.logger?.info({ sessionId, topics: created.length, lines: segs.length }, "拆主题完成");
    return created;
  }

  /** 定时推进：按每个用户的设置决定哪些会话该拆了 */
  async tick() {
    if (this.busy || !this.deps.llm.enabled) return 0;
    this.busy = true;
    let done = 0;
    try {
      for (const c of await this.deps.repository.topicCandidates()) {
        const settings = await this.deps.settings.get(c.userId);
        const ai = settings.prefs.ai;
        const ended = Date.now() - Date.parse(c.lastUploadAt) > ENDED_AFTER_MS;
        // 不拆主题、但要"每次录音一份"纪要/导图的：录音结束时照样要触发一次
        const sessionOutputs = ai.scope === "session" && (ai.minutes || ai.mindmap);
        if (!ai.topics && !(sessionOutputs && ended)) continue;
        const intervalMs = settings.prefs.topicIntervalHours * 3_600_000;
        if (ai.topics && !ended && c.speechEndMs - c.topicsUntilMs < intervalMs) continue;
        try {
          const topics = ai.topics ? await this.analyze(c.sessionId, c.topicsUntilMs, c.speechEndMs + 1, settings.tier) : [];
          if (!ai.topics) await this.deps.repository.setTopicsUntil(c.sessionId, c.speechEndMs + 1);
          await this.deps.onTopics?.(c.userId, c.sessionId, topics, ended);
          done++;
        } catch (error) {
          this.deps.logger?.warn({ sessionId: c.sessionId, error: String(error) }, "拆主题失败，下一轮重试");
        }
      }
    } finally { this.busy = false; }
    return done;
  }

  private async meter(userId: string, sessionId: string, tier: QualityTier, model: string, input: number, output: number) {
    await this.deps.repository.recordUsage({ at: new Date().toISOString(), userId, sessionId, kind: "llm", feature: "topics", provider: "dashscope",
      model, tier, audioMs: 0, inputTokens: input, outputTokens: output, costYuan: await this.deps.pricing.llmCost(model, input, output) });
  }
}

function overlap(t: { startMs: number; endMs: number }, from: number, to: number) {
  return Math.max(0, Math.min(t.endMs, to) - Math.max(t.startMs, from));
}

/** 太长的转写按字数切成几批，每批单独拆，靠 continues 接起来 */
function batches(segs: TranscriptSegment[]) {
  const out: TranscriptSegment[][] = [];
  let cur: TranscriptSegment[] = [];
  let chars = 0;
  for (const s of segs) {
    if (chars + s.text.length > MAX_CHARS && cur.length) { out.push(cur); cur = []; chars = 0; }
    cur.push(s); chars += s.text.length + 12;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** 模型回的行号区间不一定规整：排序、裁到范围内、补齐缝隙，保证首尾相接覆盖全部行 */
export function normalize(raw: RawTopic[], lineCount: number): RawTopic[] {
  const valid = raw.filter((t) => Number.isInteger(t.from) && Number.isInteger(t.to) && typeof t.title === "string")
    .map((t) => ({ ...t, from: Math.max(0, Math.min(lineCount - 1, t.from)), to: Math.max(0, Math.min(lineCount - 1, t.to)) }))
    .filter((t) => t.to >= t.from)
    .sort((a, b) => a.from - b.from);
  if (!valid.length) return [{ from: 0, to: lineCount - 1, title: "未分主题的录音", summary: "", continues: false }];
  const out: RawTopic[] = [];
  for (const t of valid) {
    const last = out.at(-1);
    const from = last ? last.to + 1 : 0;
    if (from > t.to) continue;                       // 被前一个完全盖住
    out.push({ ...t, from });
  }
  out[out.length - 1]!.to = lineCount - 1;           // 最后一个延到结尾
  // 相邻之间的缝：前一个延到后一个开头
  for (let i = 0; i < out.length - 1; i++) out[i]!.to = out[i + 1]!.from - 1;
  return out;
}

/** 短于 minMs 的主题并进前一个（第一个太短就并进后一个）。标题用时长更长的那个 */
export function mergeShort<T extends { startMs: number; endMs: number; title: string; summary: string }>(topics: T[], minMs: number): T[] {
  const out: T[] = [];
  for (const t of topics) {
    const prev = out.at(-1);
    const short = t.endMs - t.startMs < minMs;
    const prevShort = prev ? prev.endMs - prev.startMs < minMs : false;
    if (prev && (short || prevShort)) {
      const keep = prev.endMs - prev.startMs >= t.endMs - t.startMs ? prev : t;
      out[out.length - 1] = { ...prev, endMs: Math.max(prev.endMs, t.endMs), title: keep.title, summary: keep.summary };
    } else {
      out.push({ ...t });
    }
  }
  return out;
}

/* 兜底：模型偶尔还是会把脏话引进概要里（实测"我他妈"被原样引用），或者评价说话人
 * （"情绪波动""缺乏连贯性"）。用户自己会看这些字：脏话去掉，带评价词的分句整句去掉。*/
const PROFANITY = /[“"「']?(我他妈|他妈的|他妈|妈的|卧槽|我操|操你|傻逼|傻B|sb|tmd|nmsl)[”"」']?/gi;
const JUDGING = /情绪|精神|焦虑|懊悔|压力大|失控|宣泄|连贯|杂乱|碎片化|无明确主线|语无伦次|混乱/;
export function clean(text: string) {
  const noSwear = text.replace(PROFANITY, "");
  const clauses = noSwear.split(/(?<=[，,。；;])/).filter((c) => !JUDGING.test(c));
  return clauses.join("").replace(/[，,、]\s*[，,、]/g, "，").replace(/[，,、；;]$/, "。").replace(/\s{2,}/g, " ").trim();
}

/** 相邻两个标题一样的主题合成一个（模型有时把同一件事切成好几段、起同一个名字） */
export function mergeSameTitle<T extends { startMs: number; endMs: number; title: string; summary: string }>(topics: T[]): T[] {
  const out: T[] = [];
  for (const t of topics) {
    const prev = out.at(-1);
    if (prev && prev.title === t.title) {
      out[out.length - 1] = { ...prev, endMs: Math.max(prev.endMs, t.endMs),
        summary: prev.summary.length >= t.summary.length ? prev.summary : t.summary };
    } else out.push({ ...t });
  }
  return out;
}

/** 标题不能整句删（删了就只剩"未命名"）：带评价词的标题换成中性的"零散自语" */
export function cleanTitle(title: string) {
  const t = title.replace(PROFANITY, "").trim();
  if (!t) return "零散自语";
  return JUDGING.test(t) ? "零散自语" : t;
}

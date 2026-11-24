import { randomUUID } from "node:crypto";
import type { AiOutput, MindNode, QualityTier } from "../domain.js";
import type { PricingService } from "../services/pricing.js";
import type { Repository } from "../store/repository.js";
import { parseJson, type LlmClient } from "./llm.js";
import { speakerTranscript, type DiarizeService } from "./diarize.js";

/* 会议纪要和思维导图。
 *
 * 目标可以是一个主题，也可以是整次开机录音（用户在「我的」里选默认按哪个自动生成；
 * 手动点「生成」时两种都能选）。原文按时间逐句喂给模型，带时间戳，纪要里的待办要写清谁、什么时候。*/

/* 纪要模板：不同场合要看的东西完全不同。销售要的是预算和决策人，医患沟通要的是主诉和医嘱，
 * 一对一要的是情绪和阻塞点。模板只是提示词，加一个几乎零成本——市面上钉钉给到 200+，
 * 这里先铺常用的十几个场景。*/
export const MINUTES_TEMPLATES = {
  general: { label: "通用会议", guide: "## 概要\n## 讨论要点\n## 结论\n## 待办（负责人 · 截止时间）\n## 原话摘录（2–4 句关键原话）" },
  sales: { label: "销售拜访", guide: "## 客户与场景\n## 客户需求与痛点\n## 预算、决策人与时间线\n## 异议与我方回应\n## 下一步（负责人 · 时间）\n## 原话摘录" },
  interview: { label: "访谈", guide: "## 受访者与背景\n## 主要观点（逐条）\n## 值得追问的点\n## 原话摘录" },
  memo: { label: "个人备忘", guide: "## 今天做了什么\n## 想到的事\n## 要做的事" },
  hiring: { label: "面试", guide: "## 候选人与岗位\n## 经历与项目（逐条，带量化结果）\n## 能力判断（优势 / 存疑）\n## 候选人的问题与关注点\n## 结论与下一步\n## 原话摘录" },
  one_on_one: { label: "一对一沟通", guide: "## 对方在意的事\n## 进展与阻塞\n## 我承诺的事（负责人 · 时间）\n## 对方承诺的事\n## 需要我跟进的信号" },
  standup: { label: "站会 / 日会", guide: "## 昨天完成\n## 今天计划\n## 阻塞与需要的支持\n## 需要谁跟进（人 · 事 · 时间）" },
  review: { label: "需求评审", guide: "## 需求背景\n## 方案与取舍\n## 确定下来的范围\n## 悬而未决（谁来定 · 什么时候定）\n## 待办" },
  retro: { label: "复盘", guide: "## 目标与实际结果\n## 做得好的\n## 做得不好的（就事不评价人）\n## 根因\n## 下次怎么改（负责人 · 时间）" },
  brainstorm: { label: "头脑风暴", guide: "## 要解决的问题\n## 点子清单（逐条，一句话）\n## 被否掉的点子和理由\n## 值得往下做的（谁来推进）" },
  consult: { label: "咨询 / 顾问", guide: "## 客户现状\n## 客户的问题\n## 我给的建议（逐条）\n## 客户的顾虑\n## 交付物与时间\n## 原话摘录" },
  clinic: { label: "医患沟通", guide: "## 主诉与病史（只记对方说的）\n## 现有用药与过敏\n## 医生的判断与建议\n## 医嘱与复诊安排\n## 患者的疑问\n\n注意：不做诊断推断，只整理双方说过的话。" },
  legal: { label: "法律咨询", guide: "## 当事人与诉求\n## 事实经过（按时间）\n## 关键证据与材料\n## 律师意见\n## 下一步与时限\n## 原话摘录（尽量逐字）" },
  lecture: { label: "课堂 / 讲座", guide: "## 主题与讲者\n## 知识点（分层列出）\n## 重点与易错点\n## 作业 / 要求\n## 延伸阅读" },
  research: { label: "用户研究", guide: "## 受访者画像\n## 现在怎么做这件事（真实流程）\n## 痛点（带原话）\n## 期望与替代方案\n## 对我们的启发" },
  standup_family: { label: "家事与生活", guide: "## 说好的事\n## 要买 / 要办的\n## 时间安排\n## 别忘了的" },
} as const;
export type MinutesTemplate = keyof typeof MINUTES_TEMPLATES;

const MAX_CHARS = 60_000;

const pad = (n: number) => String(n).padStart(2, "0");
function clock(startedAt: string, ms: number) {
  const d = new Date(Date.parse(startedAt) + ms + 8 * 3_600_000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export class OutputService {
  constructor(private readonly deps: { repository: Repository; llm: LlmClient; pricing: PricingService;
    /** 分角色转写。没配就照旧出不带角色的纪要——宁可少个角色，也不能因为它挂了就没纪要 */
    diarize?: DiarizeService;
    logger?: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void } }) {}

  /** 取目标的转写原文（带时间），太长时只保留头尾——并在文本里说明，模型不会以为那就是全部 */
  private async source(targetType: "topic" | "session", targetId: string) {
    let sessionId: string, from = 0, to = Number.MAX_SAFE_INTEGER, label: string, userId: string;
    if (targetType === "topic") {
      const topic = await this.deps.repository.getTopic(targetId);
      if (!topic) throw new Error("主题不存在");
      ({ sessionId, startMs: from, endMs: to, title: label, userId } = topic);
    } else {
      const session = await this.deps.repository.getSession(targetId);
      if (!session) throw new Error("录音不存在");
      sessionId = session.id; userId = session.userId; label = "整次录音";
    }
    const session = (await this.deps.repository.getSession(sessionId))!;
    const segs = (await this.deps.repository.listTranscripts(sessionId))
      .filter((t) => t.kind === "speech" && t.status === "succeeded" && t.text.trim() && t.startMs >= from && t.startMs < to)
      .sort((a, b) => a.startMs - b.startMs);
    let text = segs.map((s) => `${clock(session.startedAt, s.startMs)} ${s.text.trim()}`).join("\n");
    if (text.length > MAX_CHARS) {
      const half = MAX_CHARS / 2;
      text = `${text.slice(0, half)}\n……（中间内容太长，已省略）……\n${text.slice(-half)}`;
    }
    const topics = targetType === "session" ? await this.deps.repository.listTopics(sessionId) : [];
    /* 分角色转写要知道这一段的起止：整次录音时 to 是最后一块的末尾 */
    const lastEnd = segs.length ? segs[segs.length - 1]!.endMs : 0;
    return { sessionId, userId, label, text, topics, startedAt: session.startedAt, lineCount: segs.length,
      fromMs: from, toMs: to === Number.MAX_SAFE_INTEGER ? lastEnd : to };
  }

  async generate(input: { kind: "minutes" | "mindmap"; targetType: "topic" | "session"; targetId: string;
                          template?: MinutesTemplate | undefined; tier: QualityTier;
                          /** 纪要要不要先做一次分角色转写（多花一份转写钱） */
                          speakers?: boolean }): Promise<AiOutput> {
    const src = await this.source(input.targetType, input.targetId);
    if (!src.lineCount) throw new Error("这一段没有识别出说话内容，没法生成");
    /* 分角色：平时的转写是 5 秒一段独立识别的，跨段对不上人，所以纪要要角色就得整段再转一次。
     * 存下来复用；失败就退回没有角色的稿子，不让纪要本身失败。*/
    let roleText = "";
    if (input.kind === "minutes" && input.speakers && this.deps.diarize) {
      try {
        const cached = await this.deps.diarize.cached(input.targetId);
        const lines = cached ?? await this.deps.diarize.run({ userId: src.userId, sessionId: src.sessionId,
          fromMs: src.fromMs, toMs: src.toMs, targetType: input.targetType, targetId: input.targetId, tier: input.tier });
        if (lines.length) roleText = speakerTranscript(lines, src.startedAt);
      } catch (error) {
        this.deps.logger?.warn({ targetId: input.targetId, error: String(error) }, "分角色转写失败，用不带角色的转写生成纪要");
      }
    }
    const model = this.deps.llm.modelFor(input.tier);
    const outline = src.topics.length
      ? `\n这次录音已拆出的主题：\n${src.topics.map((t) => `- ${clock(src.startedAt, t.startMs)} ${t.title}：${t.summary}`).join("\n")}\n`
      : "";
    let content: string;
    let usage;
    if (input.kind === "minutes") {
      const template = MINUTES_TEMPLATES[input.template ?? "general"];
      const reply = await this.deps.llm.chat(model, [
        { role: "system", content: `${roleText ? "转写已经按说话人分好了角色（说话人A/B/…），写纪要时要写清是谁说的、谁负责；同一个人的观点归到一起。\n" : ""}你根据随身录音的转写写${template.label}纪要。用中文 Markdown，按下面的结构写，没有内容的小节写"无"：\n${template.guide}\n
要求：只写转写里真有的内容，不编人名、数字和日期；转写是语音识别结果，有错别字时按上下文理解；
待办写清谁、做什么、什么时候（谁或时间没说就写"未提"）；一条待办都没有就只写一行"无"，不要写空条目。
原话摘录用引号并注明时间。不要写开场白。` },
        { role: "user", content: `${src.label === "整次录音" ? "范围：整次开机录音" : `主题：${src.label}`}${outline}\n转写：\n${roleText || src.text}` },
      ], { timeoutMs: 180_000 });
      content = reply.content.trim();
      usage = reply.usage;
    } else {
      const reply = await this.deps.llm.chat(model, [
        { role: "system", content: `你把随身录音的转写整理成思维导图。只输出 JSON：{"title":"中心主题","children":[{"title":"分支","children":[...]}]}。
规则：
- 中心是这段的主题；一级分支 3~6 个，是这段谈到的几个方面；每个一级分支下面要有 2~5 个具体的点，必要时再往下一层。
- 节点文字 20 字以内，写具体内容：数字、结论、做法、人名。"硬件功能""应用场景""其他"这种只有类别没有内容的词不能单独做叶子。
- 最多 3 层；只写转写里真有的内容。
示例：{"title":"用AI设计语音硬件","children":[{"title":"设计流程","children":[{"title":"AI画原理图"},{"title":"AI自动布线"},{"title":"打板、贴片已完成"}]},
{"title":"功能设想","children":[{"title":"语音实时识别意图"},{"title":"自动建日程和任务"}]}]}` },
        { role: "user", content: `${src.label === "整次录音" ? "范围：整次开机录音" : `主题：${src.label}`}${outline}\n转写：\n${src.text}` },
      ], { json: true, timeoutMs: 180_000 });
      content = JSON.stringify(cleanTree(parseJson<MindNode>(reply.content)));
      usage = reply.usage;
    }
    await this.deps.repository.recordUsage({ at: new Date().toISOString(), userId: src.userId, sessionId: src.sessionId, kind: "llm", feature: input.kind,
      provider: "dashscope", model, tier: input.tier, audioMs: 0, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      costYuan: await this.deps.pricing.llmCost(model, usage.inputTokens, usage.outputTokens) });
    return this.deps.repository.createOutput({ id: randomUUID(), userId: src.userId, targetType: input.targetType,
      targetId: input.targetId, kind: input.kind, template: input.kind === "minutes" ? (input.template ?? "general") : "",
      content, model, createdAt: new Date().toISOString() });
  }

  /** 按用户设置自动生成：拆出新主题后（按主题）或录音结束时（按整次）。
   *  按主题时，给所有"已经结束、还没有这种产出"的主题补上——录音还在继续时，最后一个主题可能还没聊完，先不生成。*/
  async autoGenerate(prefs: { minutes: boolean; mindmap: boolean; scope: "topic" | "session" }, tier: QualityTier,
                     sessionId: string, sessionEnded: boolean) {
    const kinds = [prefs.minutes && "minutes", prefs.mindmap && "mindmap"].filter(Boolean) as ("minutes" | "mindmap")[];
    if (!kinds.length) return 0;
    let targets: { type: "topic" | "session"; id: string }[];
    if (prefs.scope === "topic") {
      const topics = await this.deps.repository.listTopics(sessionId);
      targets = (sessionEnded ? topics : topics.slice(0, -1)).map((t) => ({ type: "topic", id: t.id }));
    } else {
      targets = sessionEnded ? [{ type: "session", id: sessionId }] : [];
    }
    const have = await this.deps.repository.listOutputs(targets.map((t) => t.id));
    let made = 0;
    for (const target of targets) {
      for (const kind of kinds) {
        if (have.some((o) => o.targetId === target.id && o.kind === kind)) continue;
        await this.generate({ kind, targetType: target.type, targetId: target.id, tier });
        made++;
      }
    }
    return made;
  }
}

/** 模型给的树不一定守规矩：截层数、截子节点数、去空标题 */
export function cleanTree(node: MindNode, depth = 0): MindNode {
  const title = String(node?.title ?? "").trim().slice(0, 40) || "（无标题）";
  const children = depth >= 3 || !Array.isArray(node?.children) ? []
    : node.children.filter((c) => c && String(c.title ?? "").trim()).slice(0, 7).map((c) => cleanTree(c, depth + 1));
  return children.length ? { title, children } : { title };
}

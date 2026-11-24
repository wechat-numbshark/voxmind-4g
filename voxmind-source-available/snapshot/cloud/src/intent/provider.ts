import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { settingsCatalogText } from "../services/settings-tool.js";
import { beijingLabel, isGenericTitle, normalizeActionArgs } from "./time.js";

export const IntentCandidate = z.object({
  tool: z.enum(["note.create", "feishu.task.create", "feishu.calendar.create", "feishu.doc.create", "feishu.message.send",
    "webhook.call", "homeassistant.service.call", "iot.light.set", "iot.switch.set", "iot.climate.set", "iot.ir.send",
    "irrigation.zone.run", "automation.create", "automation.cancel", "expense.record", "settings.update"]),
  title: z.string().min(1).max(80),
  detail: z.string().max(500).default(""),
  args: z.record(z.string(), z.unknown()).default({}),
  evidence: z.string().max(1000).default(""),
  confidence: z.number().min(0).max(1),
  mode: z.enum(["suggested", "explicit", "deferred"]),
  risk: z.enum(["record", "personal_write", "external_write", "physical_control", "destructive"]),
});
export type IntentCandidate = z.infer<typeof IntentCandidate>;
const IntentResponse = z.object({ actions: z.array(IntentCandidate).max(10) });
const RawIntentResponse = z.object({ actions: z.array(z.record(z.string(), z.unknown())).max(10) });
const TOOL_RISK: Record<IntentCandidate["tool"], IntentCandidate["risk"]> = {
  "note.create": "record", "feishu.task.create": "personal_write", "feishu.calendar.create": "personal_write",
  "feishu.doc.create": "personal_write", "feishu.message.send": "external_write",
  "webhook.call": "external_write", "homeassistant.service.call": "physical_control",
  "iot.light.set": "physical_control", "iot.switch.set": "physical_control", "iot.climate.set": "physical_control",
  "iot.ir.send": "physical_control", "irrigation.zone.run": "physical_control",
  /* 定时规则本身只写在自己这边，没有对外动静；真正做事时再按那件事的风险走 */
  "automation.create": "personal_write", "automation.cancel": "personal_write",
  "expense.record": "personal_write",
  "settings.update": "personal_write",
};

export interface IntentUsage { inputTokens: number; outputTokens: number }
export interface IntentResult { actions: IntentCandidate[]; usage: IntentUsage; model: string }

export interface IntentProvider {
  readonly name: string;
  extract(transcript: string, recordedAt: string): Promise<IntentCandidate[]>;
  /** 带上文、带用量的版本。流水线用它记账；没实现的实现（测试替身）退回 extract。*/
  extractMetered?(transcript: string, recordedAt: string, context?: string): Promise<IntentResult>;
}

/** 按档位挑意图模型：高质量档用更强的，经济档用便宜 5 倍的 qwen-flash */
export class IntentRouter {
  constructor(private readonly providers: { high: IntentProvider; economy: IntentProvider }) {}
  forTier(tier: "high" | "economy") { return this.providers[tier]; }
}

export async function extractWithUsage(provider: IntentProvider, transcript: string, recordedAt: string, context?: string): Promise<IntentResult> {
  if (provider.extractMetered) return provider.extractMetered(transcript, recordedAt, context);
  return { actions: await provider.extract(transcript, recordedAt), usage: { inputTokens: 0, outputTokens: 0 }, model: provider.name };
}

/** 上文只用来理解「他」「那个」指谁，不能从上文里再抽一遍动作——否则同一句话会反复出卡片 */
function userMessage(transcript: string, recordedAt: string, context?: string) {
  // 给模型看北京时间和星期：它要据此把"明天""下周三"换算成日期
  const at = `录音时间（北京时间）：${beijingLabel(recordedAt)}`;
  return context
    ? `${at}\n上文（只用于理解指代，不要从上文抽取动作）：${context}\n本句：${transcript}`
    : `${at}\n转写：${transcript}`;
}

const SYSTEM = `你是 VoxMind 的语音动作抽取器。只输出 JSON：{"actions": [...]}。普通谈话没有动作时返回空数组。每个 action 顶层必须包含 tool、title、detail、args、evidence、confidence、mode、risk，不能省略 title。
允许工具：note.create、feishu.task.create、feishu.calendar.create、feishu.doc.create、feishu.message.send、webhook.call、iot.light.set、iot.switch.set、iot.climate.set、iot.ir.send、irrigation.zone.run、automation.create、automation.cancel、expense.record、settings.update。不要再生成 homeassistant.service.call。
用户明确说“创建/生成/直接执行/帮我…”时 mode=explicit；只是从谈话中推测可能要做时 mode=suggested；要求录音结束后再做时 mode=deferred。
risk 固定规则：note.create=record；飞书任务/日程/文档=personal_write；发消息/webhook=external_write；Home Assistant=physical_control。
设备控制判定优先级：本句同时包含“当前已登记设备”中的设备名/别名和直接控制意图（如打开、开启、关闭、调到、设为、运行）时，必须选择对应 iot.* 或 irrigation.* 工具，不能创建飞书任务/待办；即使本句很短（如“打开空调”）也一样。
只有用户明确说“提醒我/建任务/加待办”，或表达的是未来要自己处理而不是现在控制设备，才使用 feishu.task.create。若是未来设备动作且系统没有相应的定时设备工具，不要假装立即执行。
必须保留原话 evidence，不补造时间、人员、地址或设备。confidence<0.6 的猜测不要输出。
args 必须严格使用以下字段：
- note.create: title, content
- feishu.task.create: summary, description, due（可选，北京时间 "YYYY-MM-DD HH:mm"；只说了哪天没说几点就写 "YYYY-MM-DD"）,
  duePart（只在没说具体几点时给：说了"上午/早上"写 morning，"下午"写 afternoon，"晚上"写 evening，什么都没说写 none）
- feishu.calendar.create: summary, description, start, end（北京时间 "YYYY-MM-DD HH:mm"；没说结束就省略 end）
- feishu.doc.create: title, content, folderToken（可选）
- feishu.message.send: receiveId（发给谁：人名原样写；发到群就只写群名本身，去掉"的这个群""群"这类字，如"发到AI自动化的这个群"写"AI自动化"）, receiveIdType（写名字时填 "name"；只有用户明确给了邮箱才填 "email"）, text
- webhook.call: url, method, headers, body
- iot.light.set: deviceId, on, brightnessPct（可选，1-100）
- iot.switch.set: deviceId, on
- iot.climate.set: deviceId, temperatureC（16-30）, mode（off|heat|cool|dry|fan_only|auto）
- iot.ir.send: deviceId（红外网关）, appliance（被控设备名）, command（已登记命令名）, repeats（可选，1-3）
- irrigation.zone.run: deviceId, durationMinutes（1-30）
- automation.create（"每天/每周/每月…都要…"这种重复的事，只建规则，不是这一次的任务）:
  title（这条规则叫什么，比如"提醒量体重"）, repeat（daily|weekly|monthly|once）, time（"HH:mm"）,
  weekday（repeat=weekly 时 0=周日…6=周六）, day（repeat=monthly 时 1–31）, date（repeat=once 时 "YYYY-MM-DD"）,
  kind（task=建飞书任务｜note=记笔记｜message=发飞书消息｜daily_summary=写当天小结）, text（要做的事/消息内容）, receiveId（kind=message 时发给谁，没说就别写）
- automation.cancel: title（要取消哪条规则，用用户说的那几个字，比如"每天量体重"）
- expense.record（花钱了/记账）: amount（数字，单位元）, category（从给定类别里选一个，拿不准写"其他"）, note（买了什么，≤15字）, spentAt（可选，北京时间 "YYYY-MM-DD"，说"昨天""前天"时换算；没说就别写）
说"记账，午饭花了68""打车花了25块""买菜花了三十二块五"都用 expense.record；一句话里说了几笔就出几条。
- settings.update（用户要改这台设备/系统自己的设置，比如"熄屏改成30秒""换成多巴胺主题""以后只识别我按住说的""发飞书消息每次先问我"）:
  args.changes = [{key, value}, ...]，一句话改几项就放几项；key 只能从下面选，value 按说明给：
${settingsCatalogText()}
  rule 的 tool 用上面"允许工具"里的名字。只有用户明确在说"设置/改成/打开/关掉/以后…"这类针对设备本身的话才用；
  谈话里提到别的东西（"把会议改到三点"）不是改设置。risk=personal_write。
金额听成中文数字要换算成阿拉伯数字（三十二块五＝32.5）。只是问"多少钱""贵不贵"这种不算记账。
类别只能从这些里选：餐饮、交通、住宿、健康、医疗、娱乐、日用、投资、其他。
判断：说"明天十点提醒我"是一次性任务，用 feishu.task.create；说"每天早上八点提醒我"是重复规则，用 automation.create（repeat=daily, time="08:00"）。
说"取消每天量体重的提醒""不用每天提醒我喝水了"时用 automation.cancel。
时间：以用户消息里的"录音时间（北京时间）"为今天，把"明天/后天/下周三/周五下午"换算成具体日期再写进 due/start。
例：录音时间 2026-09-19 周六 17:23，"明天上午10点" → "2026-09-20 10:00"；"下周三" → "2026-09-23"。
不要输出时间戳数字；没说时间就不写这个字段。信息不足时不要臆造字段。
title 写要做的事本身，比如"明天10点去福田菜市场买菜"；不要写"创建飞书任务""帮我建个任务"这种操作名。
summary 同样写事情本身，不要带"帮我""创建"。`;

function systemMessage(deviceHints?: string) {
  const hints = deviceHints?.trim();
  return hints ? `${SYSTEM}\n\n当前已登记设备与命令（只能使用这里明确给出的 deviceId 和 command，不要臆造）：\n${hints}` : SYSTEM;
}

function parseJsonObject(text: string, transcript: string, recordedAt: string) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const raw = RawIntentResponse.parse(JSON.parse(cleaned));
  const actions = raw.actions.map((item) => {
    const tool = IntentCandidate.shape.tool.parse(item.tool);
    const rawArgs = item.args && typeof item.args === "object" && !Array.isArray(item.args) ? item.args as Record<string, unknown> : {};
    const { args, notes } = normalizeActionArgs(tool, rawArgs, recordedAt);
    const fallbackTitle = [args.summary, args.title, item.summary, item.name].find((value) => typeof value === "string" && value.trim()) as string | undefined;
    // 标题要是事情本身；模型写成"创建飞书任务"这种操作名时，用 summary 顶上
    const given = typeof item.title === "string" ? item.title.trim() : "";
    const title = (given && !isGenericTitle(given) ? given : fallbackTitle ?? given) || "待执行动作";
    const detail = typeof item.detail === "string" ? item.detail : typeof args.description === "string" ? args.description : "";
    return IntentCandidate.parse({ ...item, tool, args,
      title: title.slice(0, 80),
      detail: [detail, ...notes].filter(Boolean).join("；").slice(0, 500),
      evidence: typeof item.evidence === "string" ? item.evidence : transcript.slice(0, 1000),
      confidence: typeof item.confidence === "number" ? item.confidence : 0.7,
      mode: item.mode ?? "suggested",
      risk: TOOL_RISK[tool],
    });
  });
  return IntentResponse.parse({ actions });
}

export class DisabledIntentProvider implements IntentProvider {
  readonly name = "disabled";
  async extract() { return []; }
}

export class OpenAiCompatibleIntentProvider implements IntentProvider {
  readonly name: string;
  constructor(private readonly options: { baseUrl: string; apiKey: string; model: string; deviceHints?: string; fetchImpl?: typeof fetch }) {
    this.name = `openai-compatible:${new URL(options.baseUrl).hostname}`;
  }
  async extract(transcript: string, recordedAt: string) {
    return (await this.extractMetered(transcript, recordedAt)).actions;
  }
  async extractMetered(transcript: string, recordedAt: string, context?: string): Promise<IntentResult> {
    const response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", signal: AbortSignal.timeout(45_000),
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.options.model, temperature: 0, response_format: { type: "json_object" },
        messages: [{ role: "system", content: systemMessage(this.options.deviceHints) }, { role: "user", content: userMessage(transcript, recordedAt, context) }] }),
    });
    const body = await response.json() as { choices?: { message?: { content?: string } }[]; error?: { message?: string };
      usage?: { prompt_tokens?: number; completion_tokens?: number } };
    if (!response.ok) throw new Error(`模型请求失败: ${body.error?.message ?? response.status}`);
    return { actions: parseJsonObject(body.choices?.[0]?.message?.content ?? "", transcript, recordedAt).actions, model: this.options.model,
      usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 } };
  }
}

export class AnthropicIntentProvider implements IntentProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  constructor(apiKey: string, private readonly model: string, private readonly deviceHints = "") { this.client = new Anthropic({ apiKey }); }
  async extract(transcript: string, recordedAt: string) {
    return (await this.extractMetered(transcript, recordedAt)).actions;
  }
  async extractMetered(transcript: string, recordedAt: string, context?: string): Promise<IntentResult> {
    const response = await this.client.messages.create({ model: this.model, max_tokens: 3000, temperature: 0,
      system: systemMessage(this.deviceHints), messages: [{ role: "user", content: userMessage(transcript, recordedAt, context) }] });
    const text = response.content.find((part) => part.type === "text");
    const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    if (!text || text.type !== "text") return { actions: [], usage, model: this.model };
    return { actions: parseJsonObject(text.text, transcript, recordedAt).actions, usage, model: this.model };
  }
}

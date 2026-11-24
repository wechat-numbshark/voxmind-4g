import { randomUUID } from "node:crypto";
import type { QualityTier } from "../domain.js";
import type { SearchHit } from "../store/repository.js";
import { normalizeActionArgs } from "../intent/time.js";
import { DEFAULT_PREFS } from "../domain.js";
import { changeTitle, checkChanges, describeSettings, settingsCatalogText, TOOL_NAMES as ACTION_NAMES } from "../services/settings-tool.js";
import type { ActionService } from "../services/actions.js";
import type { ExecutionService } from "../services/execution.js";
import type { PricingService } from "../services/pricing.js";
import type { Repository } from "../store/repository.js";
import type { ChatMessage, LlmClient, ToolSpec } from "./llm.js";

/* 后台 AI 聊天：问录音里的事，或者让它办事。
 *
 * 模型不直接看全部录音——它通过工具去查（搜索、按天列主题、读某个主题原文），
 * 回答里的每个说法都带出处，网页上点出处直接跳到那段原声。
 *
 * 办事（建飞书任务、发消息……）走的是和语音完全一样的那条路：先生成动作卡片，
 * 再由「执行规则」决定直接做还是等人签。聊天没有任何绕过确认的后门。*/

export interface ChatCitation { sessionId: string; startMs: number; endMs: number; label: string }
export interface ChatActionResult { draftId: string; title: string; tool: string; status: string }
export interface ChatLink { label: string; url: string }
export interface ChatReply { reply: string; citations: ChatCitation[]; actions: ChatActionResult[]; links: ChatLink[] }

const TOOL_RISK: Record<string, "record" | "personal_write" | "external_write" | "physical_control"> = {
  "note.create": "record", "feishu.task.create": "personal_write", "feishu.calendar.create": "personal_write",
  "feishu.doc.create": "personal_write", "feishu.message.send": "external_write", "webhook.call": "external_write",
  "homeassistant.service.call": "physical_control",
  "settings.update": "personal_write",
  "iot.light.set": "physical_control", "iot.switch.set": "physical_control", "iot.climate.set": "physical_control",
  "iot.ir.send": "physical_control", "irrigation.zone.run": "physical_control",
};

const TOOLS: ToolSpec[] = [
  { type: "function", function: { name: "search_recordings", description: "按关键词或意思搜索录音转写，返回最相关的句子（带录音编号和时间）。问具体内容时先用它。",
    parameters: { type: "object", properties: { query: { type: "string", description: "要找的内容，用用户说话的原词或意思" } }, required: ["query"] } } },
  { type: "function", function: { name: "list_topics", description: "列出某一天拆出的主题（时间、标题、概要、主题编号）。问'某天/今天做了什么'时用。",
    parameters: { type: "object", properties: { date: { type: "string", description: "北京时间日期 YYYY-MM-DD" } }, required: ["date"] } } },
  { type: "function", function: { name: "read_topic", description: "读取某个主题的完整转写原文。需要总结或回答细节时用。",
    parameters: { type: "object", properties: { topicId: { type: "string" } }, required: ["topicId"] } } },
  { type: "function", function: { name: "create_action", description: "替用户办一件事：建飞书任务/日程/文档、发飞书消息、记笔记，或调用 EVA 控制已登记的农场/家居设备。会先生成一张动作卡片，是否需要用户确认由用户的执行规则决定。只在用户明确要求时调用。",
    parameters: { type: "object", properties: {
      tool: { type: "string", enum: Object.keys(TOOL_RISK) },
      title: { type: "string", description: "事情本身，20 字以内" },
      detail: { type: "string" },
      args: { type: "object", description: "飞书/笔记按原字段；iot.light.set: deviceId,on,brightnessPct；iot.switch.set: deviceId,on；iot.climate.set: deviceId,temperatureC,mode；iot.ir.send: deviceId,appliance,command,repeats；irrigation.zone.run: deviceId,durationMinutes" },
    }, required: ["tool", "title", "args"] } } },
  { type: "function", function: { name: "export_link", description: "生成某个主题或某次录音的下载链接（音频 wav 或文字 txt）。",
    parameters: { type: "object", properties: { topicId: { type: "string" }, sessionId: { type: "string" }, format: { type: "string", enum: ["wav", "txt"] } }, required: ["format"] } } },
  { type: "function", function: { name: "list_favorites", description: "列出用户的收藏：有哪些文件夹、每个文件夹里收了哪几段录音（sessionId、时间、标题）。整理收藏之前先看一眼。",
    parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "organize_favorites", description: "整理收藏（只动用户自己的收藏夹，不对外，直接生效）：把录音加星、放进文件夹（文件夹按名字找，没有就新建）、从文件夹拿出来、取消收藏。录音用 sessionId，先用 search_recordings / list_topics 找到相关录音。",
    parameters: { type: "object", properties: {
      folder: { type: "string", description: "文件夹名字；没有就新建。只加星不放文件夹就不填" },
      add: { type: "array", items: { type: "string" }, description: "要收藏（并放进 folder）的 sessionId" },
      remove: { type: "array", items: { type: "string" }, description: "要从 folder 里拿出来的 sessionId；没填 folder 就是取消收藏" },
      rename: { type: "string", description: "把 folder 改成这个新名字" },
      keywords: { type: "array", items: { type: "string" }, description: "给 folder 设自动归档关键词：以后转写或主题里提到其中任何一个词的录音自动收进来（空数组＝关掉）。用户说「以后提到某某的都自动放进去」时用" },
    } } } },
  { type: "function", function: { name: "get_settings", description: "查看设备和系统现在的设置（熄屏、主题、提醒、音质、AI 开关、定时开关机、执行规则……）。用户问『现在怎么设的』或改之前需要知道当前值时用。",
    parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "change_settings", description: `改设备和系统的设置。和别的动作一样先生成一张「改设置」卡片，要不要先问用户由执行规则决定；把某类动作改成不用问的，一律等用户确认。可改的项：\n${settingsCatalogText()}`,
    parameters: { type: "object", properties: {
      changes: { type: "array", items: { type: "object", properties: { key: { type: "string" }, value: {} }, required: ["key", "value"] } },
    }, required: ["changes"] } } },
];

const pad = (n: number) => String(n).padStart(2, "0");
const bj = (ms: number) => new Date(ms + 8 * 3_600_000);
const hhmm = (ms: number) => { const d = bj(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const ymd = (ms: number) => { const d = bj(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };

const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name));
/** 回答里声称"已经办好了"的说法 */
const CLAIMS_DONE = /(已(经)?(为您|帮您|帮你)?(创建|新建|建好|建了|添加|加好|记下|记好|记录|发送|发出|发了|安排|设置)|创建成功|已完成创建|已记录)/;

/** 从回答文本里认出"假装调用"：{"name":"note.create","arguments":{...}} */
export function extractFakeCall(text: string): { name: string; args: Record<string, unknown>; raw: string } | null {
  for (const m of text.matchAll(/\{[^{}]*"name"\s*:\s*"([a-z_.]+)"[\s\S]*?\}\s*\}/g)) {
    const name = m[1]!;
    // 有时写的是聊天工具名（create_action），有时直接写动作名（note.create）
    if (!TOOL_NAMES.has(name) && !(name in TOOL_RISK)) continue;
    try {
      const parsed = JSON.parse(m[0]) as { name: string; arguments?: Record<string, unknown>; args?: Record<string, unknown> };
      const args = parsed.arguments ?? parsed.args ?? {};
      if (name in TOOL_RISK) {
        const title = [args.title, args.summary, args.text].find((v) => typeof v === "string" && v.trim()) as string | undefined;
        return { name: "create_action", args: { tool: name, title: title ?? "聊天里交代的事", args }, raw: m[0] };
      }
      return { name, args, raw: m[0] };
    } catch { /* 不是完整 JSON：忽略 */ }
  }
  return null;
}

export class ChatService {
  constructor(private readonly deps: {
    repository: Repository; llm: LlmClient; pricing: PricingService; actions: ActionService; executions: ExecutionService;
    search: (query: string, userId: string) => Promise<(SearchHit & { match: string })[]>;
    /** 指定聊天用的模型；留空跟用户档位走 */
    model?: string;
    /** Same non-secret registered device/command catalogue used by voice intent. */
    deviceHints?: string;
  }) {}

  async reply(userId: string, history: { role: "user" | "assistant"; content: string }[], tier: QualityTier): Promise<ChatReply> {
    const model = this.deps.model || this.deps.llm.modelFor(tier);
    const now = Date.now();
    const citations: ChatCitation[] = [];
    const actions: ChatActionResult[] = [];
    const links: ChatLink[] = [];
    let chatSessionId: string | null = null;

    const messages: ChatMessage[] = [
      { role: "system", content: `你是 VoxMind 的助手。用户戴着一台整天录音的设备，你能查他的录音转写、按天看拆出的主题，也能替他办事。
现在是北京时间 ${ymd(now)} ${hhmm(now)}。
- 回答录音里的事之前先用工具查，不要凭空回答；查不到就直说没找到。
- 引用录音时，在句末用 [1] [2] 这样的编号标出处，编号对应工具结果里的 ref。
- 转写是语音识别结果，可能有错别字，按上下文理解。
- 用户明确要你办事时才调用 create_action。办事只能通过调用工具完成：不调用工具就等于什么都没做，
  绝对不许只用文字说"已创建""已记下"。调用后再告诉用户卡片的状态（已执行 / 等他确认）。
- 用户要收藏、整理录音（"把和某某相关的放进收藏的新文件夹"）：先 search_recordings / list_topics 找到相关录音拿 sessionId，
  再调用 organize_favorites（folder 填文件夹名，没有会新建）；不确定有哪些文件夹先 list_favorites。做完说清放了哪几段。
  用户说「以后提到某某的都自动放进去」就在 organize_favorites 里带 keywords（自动归档），说清现在自动收进了几段。
- 用户要改设备或系统的设置（熄屏、主题、提醒、音质、AI 开关、定时开关机、某类动作要不要先问……）时调用 change_settings；
  不确定现在是什么值就先 get_settings。改完照实说：已改好 / 等他确认。
- 导出时调用 export_link，回答里不要写链接地址，界面会自动显示下载按钮。
- 用中文，简洁。` },
      ...(this.deps.deviceHints?.trim() ? [{ role: "system" as const, content:
        `已登记的设备与可用命令：\n${this.deps.deviceHints.trim()}\n` +
        "明确的当前设备控制使用匹配的 iot.* 或 irrigation.* 工具，不要建待办。只有明确要求提醒、任务或待办时才建任务。" +
        "否定、引用别人的话、询问操作方法不执行设备控制；未来执行需求不可作为现在的控制。" +
        "只使用已登记的设备ID和命令，不编造设备、温度场景或能力；缺少目标或不支持参数时先说明并澄清。" }] : []),
      ...history.slice(-12).map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
    ];

    const cite = (sessionId: string, startMs: number, endMs: number, label: string) => {
      const existing = citations.findIndex((c) => c.sessionId === sessionId && c.startMs === startMs);
      if (existing >= 0) return existing + 1;
      citations.push({ sessionId, startMs, endMs, label });
      return citations.length;
    };

    const run = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      if (name === "search_recordings") {
        const hits = (await this.deps.search(String(args.query ?? ""), userId)).slice(0, 12);
        return hits.map((h) => ({ ref: cite(h.sessionId, h.startMs, h.endMs, `${ymd(Date.parse(h.sessionStartedAt) + h.startMs)} ${hhmm(Date.parse(h.sessionStartedAt) + h.startMs)}`),
          time: `${ymd(Date.parse(h.sessionStartedAt) + h.startMs)} ${hhmm(Date.parse(h.sessionStartedAt) + h.startMs)}`, text: h.text, sessionId: h.sessionId }));
      }
      if (name === "list_topics") {
        const date = String(args.date ?? ymd(now));
        const sessions = (await this.deps.repository.listSessions(200, userId))
          .filter((s) => ymd(Date.parse(s.startedAt)) <= date && ymd(Date.parse(s.startedAt) + 86_400_000 * 2) >= date);
        const topics = await this.deps.repository.topicsForSessions(sessions.map((s) => s.id));
        return topics.flatMap((t) => {
          const s = sessions.find((x) => x.id === t.sessionId)!;
          const at = Date.parse(s.startedAt) + t.startMs;
          if (ymd(at) !== date) return [];
          return [{ ref: cite(t.sessionId, t.startMs, t.endMs, `${date} ${hhmm(at)} ${t.title}`), topicId: t.id, sessionId: t.sessionId,
            time: `${hhmm(at)}–${hhmm(Date.parse(s.startedAt) + t.endMs)}`, title: t.title, summary: t.summary }];
        });
      }
      if (name === "read_topic") {
        const t = await this.deps.repository.getTopic(String(args.topicId ?? ""));
        if (!t || t.userId !== userId) return { error: "没有这个主题" };
        const s = (await this.deps.repository.getSession(t.sessionId))!;
        const text = (await this.deps.repository.listTranscripts(t.sessionId))
          .filter((x) => x.kind === "speech" && x.status === "succeeded" && x.startMs >= t.startMs && x.startMs < t.endMs)
          .map((x) => `${hhmm(Date.parse(s.startedAt) + x.startMs)} ${x.text}`).join("\n").slice(0, 20_000);
        return { ref: cite(t.sessionId, t.startMs, t.endMs, t.title), title: t.title, text };
      }
      if (name === "create_action") {
        const tool = String(args.tool ?? "");
        const risk = TOOL_RISK[tool];
        if (!risk) return { error: "不支持的动作" };
        const raw = typeof args.args === "object" && args.args ? args.args as Record<string, unknown> : {};
        const { args: normalized, notes } = normalizeActionArgs(tool, raw, new Date(now).toISOString());
        // 聊天里下的指令也要挂在一次"录音"上：网页输入会话（录音页显示为"网页输入"）
        if (!chatSessionId) {
          chatSessionId = randomUUID();
          await this.deps.repository.createSession({ id: chatSessionId, deviceId: "web-console", userId, startedAt: new Date(now).toISOString() });
        }
        const lastUser = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
        const draft = await this.deps.actions.createDraft({ sessionId: chatSessionId, userId, tool,
          title: String(args.title ?? "").slice(0, 80) || "聊天里交代的事", detail: [String(args.detail ?? ""), ...notes].filter(Boolean).join("；"),
          args: normalized, evidence: `（聊天）${lastUser}`.slice(0, 1000), confidence: 1, mode: "explicit", risk });
        let status: string = draft.status;
        if (draft.status === "confirmed") {
          try { status = (await this.deps.executions.execute(draft))?.status === "succeeded" ? "executed" : "failed"; }
          catch { status = "failed"; }
        }
        actions.push({ draftId: draft.id, title: draft.title, tool, status });
        return { status: status === "pending" ? "已生成卡片，等用户在设备/网页/飞书上确认" : status === "executed" ? "已执行" : status === "failed" ? "执行失败" : status };
      }
      if (name === "list_favorites") {
        const fav = await this.deps.repository.listFavorites(userId);
        const summaries = fav.items.length ? await this.deps.repository.listSessionSummaries(500, userId, fav.items.map((i) => i.sessionId)) : [];
        const label = (id: string) => { const x = summaries.find((s) => s.id === id); return x ? `${ymd(Date.parse(x.startedAt))} ${hhmm(Date.parse(x.startedAt))} ${x.title ?? "（未拆主题）"}` : id; };
        return { folders: fav.folders.map((f) => ({ name: f.name, sessions: fav.items.filter((i) => i.folderIds.includes(f.id)).map((i) => ({ sessionId: i.sessionId, label: label(i.sessionId) })) })),
          unfiled: fav.items.filter((i) => !i.folderIds.length).map((i) => ({ sessionId: i.sessionId, label: label(i.sessionId) })) };
      }
      if (name === "organize_favorites") {
        const ids = (v: unknown) => (Array.isArray(v) ? v.map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x)) : []);
        const add = ids(args.add), remove = ids(args.remove);
        const owned = async (id: string) => { const sess = await this.deps.repository.getSession(id); return sess && sess.userId === userId; };
        const folderName = typeof args.folder === "string" ? args.folder.trim().slice(0, 40) : "";
        let folderId: string | null = null, created = false;
        if (folderName) {
          const fav = await this.deps.repository.listFavorites(userId);
          folderId = fav.folders.find((f) => f.name === folderName)?.id ?? null;
          if (!folderId && (add.length || typeof args.rename !== "string")) {
            folderId = (await this.deps.repository.createFavoriteFolder({ id: randomUUID(), userId, name: folderName, createdAt: new Date().toISOString(), keywords: [] })).id;
            created = true;
          }
        }
        let added = 0, removed = 0;
        for (const id of add) {
          if (!(await owned(id))) continue;
          if (folderId) await this.deps.repository.setFolderItem(userId, folderId, id, true);
          else await this.deps.repository.setFavorite(userId, id, true);
          added++;
        }
        for (const id of remove) {
          if (folderId) await this.deps.repository.setFolderItem(userId, folderId, id, false);
          else await this.deps.repository.setFavorite(userId, id, false);
          removed++;
        }
        const newName = typeof args.rename === "string" ? args.rename.trim().slice(0, 40) : "";
        if (folderId && newName) await this.deps.repository.renameFavoriteFolder(userId, folderId, newName);
        let autoAdded = 0, keywords: string[] | undefined;
        if (folderId && Array.isArray(args.keywords)) {
          keywords = [...new Set(args.keywords.map((k) => String(k).trim().slice(0, 20)).filter(Boolean))].slice(0, 10);
          await this.deps.repository.setFolderKeywords(userId, folderId, keywords);
          autoAdded = await this.deps.repository.applyFolderRules(userId);
        }
        return { ok: true, folder: newName || folderName || null, createdFolder: created, added, removed,
          ...(keywords ? { autoKeywords: keywords, autoAdded } : {}) };
      }
      if (name === "get_settings") {
        const saved = await this.deps.repository.getUserSettings(userId);
        const current = describeSettings(saved ?? { userId, tier: tier, wakeWord: "小沃小沃", retentionDays: 0, ledMode: "designed", prefs: DEFAULT_PREFS,
          schedule: { enabled: false, offAt: "23:00", onAt: "07:00", mode: "hard" }, updatedAt: new Date(0).toISOString() });
        const rules = (await this.deps.repository.listToolPolicies(userId))
          .map((p) => `${ACTION_NAMES[p.tool] ?? p.tool}：${p.confirmation === "always" ? "每次都先问" : p.confirmation === "never" ? "直接做" : "明说的直接做"}`);
        return { settings: current, rules: rules.length ? rules : ["都是默认（记笔记直接做，其余明说的直接做，发消息每次先问）"] };
      }
      if (name === "change_settings") {
        const checked = checkChanges(args.changes, ACTION_NAMES);
        if (!checked.ok.length) return { error: checked.errors.join("；") || "没有要改的设置" };
        if (!chatSessionId) {
          chatSessionId = randomUUID();
          await this.deps.repository.createSession({ id: chatSessionId, deviceId: "web-console", userId, startedAt: new Date(now).toISOString() });
        }
        const lastUser = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
        const draft = await this.deps.actions.createDraft({ sessionId: chatSessionId, userId, tool: "settings.update",
          title: changeTitle(checked), detail: checked.summary, args: { changes: checked.ok },
          evidence: `（聊天）${lastUser}`.slice(0, 1000), confidence: 1, mode: "explicit", risk: "personal_write", forceConfirm: checked.loosens });
        let status: string = draft.status;
        if (draft.status === "confirmed") {
          try { status = (await this.deps.executions.execute(draft))?.status === "succeeded" ? "executed" : "failed"; }
          catch { status = "failed"; }
        }
        actions.push({ draftId: draft.id, title: draft.title, tool: "settings.update", status });
        return { status: status === "pending" ? "已生成卡片，等用户确认" : status === "executed" ? "已改好，设备几秒内同步" : "没改成",
          changed: checked.summary, ...(checked.errors.length ? { skipped: checked.errors } : {}) };
      }
      if (name === "export_link") {
        const format = args.format === "txt" ? "txt" : "wav";
        if (args.topicId) {
          const t = await this.deps.repository.getTopic(String(args.topicId));
          if (!t || t.userId !== userId) return { error: "没有这个主题" };
          const url = `/v1/sessions/${t.sessionId}/export.${format}?from=${t.startMs}&to=${t.endMs}`;
          links.push({ label: `${t.title}（${format === "wav" ? "音频" : "文字"}）`, url });
          return { url };
        }
        if (args.sessionId) {
          const s = await this.deps.repository.getSession(String(args.sessionId));
          if (!s || s.userId !== userId) return { error: "没有这次录音" };
          const url = `/v1/sessions/${s.id}/export.${format}`;
          links.push({ label: `${ymd(Date.parse(s.startedAt))} ${hhmm(Date.parse(s.startedAt))} 的录音（${format === "wav" ? "音频" : "文字"}）`, url });
          return { url };
        }
        return { error: "要给主题编号或录音编号" };
      }
      return { error: "未知工具" };
    };

    let reply = "";
    let pushedBack = false;
    let lastContent = "";        // 顶回去之后模型可能干脆不说话了，用之前那句兜底
    for (let round = 0; round < 7; round++) {
      const res = await this.deps.llm.chat(model, messages, { tools: TOOLS, timeoutMs: 120_000 });
      /* 模型有时不真的调工具，而是把调用写成一段 JSON 文本贴在回答里（实测"帮我记个笔记"就这样：
       * 回答写着"已创建笔记"，但什么都没建）。认出来当成真的调用执行，别让用户以为办好了。*/
      const faked = !res.toolCalls.length ? extractFakeCall(res.content) : null;
      if (faked) {
        res.toolCalls = [{ id: `repair-${round}`, type: "function", function: { name: faked.name, arguments: JSON.stringify(faked.args) } }];
        res.content = res.content.replace(faked.raw, "").trim();
      }
      await this.deps.repository.recordUsage({ at: new Date().toISOString(), userId, sessionId: chatSessionId, kind: "llm", feature: "chat",
        provider: "dashscope", model, tier, audioMs: 0, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens,
        costYuan: await this.deps.pricing.llmCost(model, res.usage.inputTokens, res.usage.outputTokens) });
      if (!res.toolCalls.length) {
        /* 模型声称办好了，但一个工具都没调（实测 qwen 会直接回"已为您创建笔记"，其实什么都没建）。
         * 绝不能让用户以为办好了：顶回去让它真调一次；还不调就把这句假话换成实话。*/
        if (!actions.length && CLAIMS_DONE.test(res.content) && !pushedBack) {
          pushedBack = true;
          lastContent = res.content;
          messages.push({ role: "assistant", content: res.content });
          messages.push({ role: "user", content: "（系统提示：你说已经办好了，但你没有调用 create_action，实际上什么都没做。现在请真正调用 create_action。）" });
          continue;
        }
        const text = res.content.trim() || lastContent;
        reply = !actions.length && CLAIMS_DONE.test(text)
          ? `${text}\n\n（实际上没有执行任何动作——我没能把它变成一张动作卡片。请再说一次，或者在"今天"页手动处理。）`
          : text;
        break;
      }
      if (faked) messages.push({ role: "user", content: "（系统提示：上一条回答里把工具调用写成了文本。工具已经替你执行，结果见下。以后请真正调用工具，不要把 JSON 写进回答。）" });
      /* 模型偶尔给出不合法的 JSON 参数；原样回传给百炼会整轮 400（实测）。
       * 先解析一遍，回传规整后的 JSON；解析不了就回 {} 并告诉模型参数坏了，让它重来 */
      const parsedCalls = res.toolCalls.map((call) => {
        try { return { call, args: JSON.parse(call.function.arguments || "{}") as Record<string, unknown>, bad: false }; }
        catch { return { call, args: {} as Record<string, unknown>, bad: true }; }
      });
      messages.push({ role: "assistant", content: res.content || null,
        tool_calls: parsedCalls.map(({ call, args }) => ({ ...call, function: { ...call.function, arguments: JSON.stringify(args) } })) });
      for (const { call, args: parsed, bad } of parsedCalls) {
        let result: unknown;
        if (bad) result = { error: "参数不是合法的 JSON，请重新调用" };
        else try { result = await run(call.function.name, parsed); } catch (error) { result = { error: String(error) }; }
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 24_000) });
      }
    }
    /* 工具结果里给过编号的出处可能有几十个（list_topics 会把当天所有主题都编号），
     * 只保留回答里真的引用到的，按出现顺序重新编成 1、2、3 */
    const used: number[] = [];
    for (const m of reply.matchAll(/\[(\d+)\]/g)) {
      const n = Number(m[1]);
      if (n >= 1 && n <= citations.length && !used.includes(n)) used.push(n);
    }
    const renumbered = reply.replace(/\[(\d+)\]/g, (all, d: string) => {
      const i = used.indexOf(Number(d));
      return i >= 0 ? `[${i + 1}]` : "";
    });
    return { reply: renumbered || "（没有得到回答，换个说法再试试）", citations: used.map((n) => citations[n - 1]!), actions, links };
  }
}

import { z } from "zod";
import { ConfirmationMode, ToolPolicy, UserPrefs, type ActionDraft, type UserSettings } from "../domain.js";
import type { ToolExecutor } from "../connectors/types.js";
import type { Repository } from "../store/repository.js";
import type { SettingsService } from "./settings.js";

/* 用说话 / 聊天改设置。
 *
 * 设置项太多，网页上一层层找太累（用户原话：「功能太多了，需要语音来设置」）。这里把能改的项列成一张表：
 * 每一项有中文名、合法取值、怎么念给人听。意图模型和聊天都只能从这张表里挑，改动先变成一张
 * 「改设置」卡片（tool = settings.update），要不要先问你，和别的动作一样按「执行规则」走。
 *
 * 唯一的例外：把某类动作改成「不用问我」这种放宽确认的改动，一律出卡片等你点头——
 * 不然旁边有人随口一句「以后发消息不用确认」就把保险拆了。*/

const onOff = (v: unknown) => (v ? "开" : "关");
const sec = (v: unknown) => (Number(v) === 0 ? "不熄屏" : Number(v) >= 60 && Number(v) % 60 === 0 ? `${Number(v) / 60} 分钟` : `${v} 秒`);
const pick = (labels: Record<string, string>) => (v: unknown) => labels[String(v)] ?? String(v);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "时间写成 HH:mm");

interface Item {
  label: string;
  /** 给模型看的取值说明 */
  hint: string;
  schema: z.ZodType;
  show: (v: unknown) => string;
  read: (s: UserSettings) => unknown;
  write: (s: UserSettings, v: never) => UserSettings;
}

const P = <K extends keyof UserPrefs>(k: K) => ({
  read: (s: UserSettings) => s.prefs[k],
  write: (s: UserSettings, v: UserPrefs[K]) => ({ ...s, prefs: { ...s.prefs, [k]: v } }),
});
const PS = <K extends "screenWake" | "reminders" | "audio" | "ai", F extends keyof UserPrefs[K]>(k: K, f: F) => ({
  read: (s: UserSettings) => s.prefs[k][f],
  write: (s: UserSettings, v: UserPrefs[K][F]) => ({ ...s, prefs: { ...s.prefs, [k]: { ...s.prefs[k], [f]: v } } }),
});
const SCH = <F extends keyof UserSettings["schedule"]>(f: F) => ({
  read: (s: UserSettings) => s.schedule[f],
  write: (s: UserSettings, v: UserSettings["schedule"][F]) => ({ ...s, schedule: { ...s.schedule, [f]: v } }),
});

const THEMES = { classic: "默认", dopamine: "多巴胺", papercut: "剪纸", cool: "酷" };
const QUALITY = { smooth: "流畅", standard: "标准", high: "高" };
const INTENT = { auto: "全自动识别", push_to_talk: "只识别按住说的" };

export const SETTINGS: Record<string, Item> = {
  screenOffSec: { label: "熄屏时间", hint: "秒，0~3600，0=不熄屏", schema: z.number().int().min(0).max(3600), show: sec, ...P("screenOffSec") },
  screenWakeOnCard: { label: "有事要确认时亮屏", hint: "true/false", schema: z.boolean(), show: onOff, ...PS("screenWake", "onCard") },
  screenWakeOnDone: { label: "直接办完时亮屏弹出来", hint: "true/false", schema: z.boolean(), show: onOff, ...PS("screenWake", "onDone") },
  screenWakeOnTap: { label: "点一下屏幕亮屏", hint: "true/false；关掉＝只有按键能亮，口袋里不会误亮", schema: z.boolean(), show: onOff, ...PS("screenWake", "onTap") },
  screenDoubleTapOff: { label: "双击屏幕熄屏", hint: "true/false；亮着时双击空白处立刻熄屏", schema: z.boolean(), show: onOff, ...PS("screenWake", "doubleTapOff") },
  deviceReceipts: { label: "设备首页回执", hint: "today=只看今天 / all=累积", schema: z.enum(["today", "all"]), show: pick({ today: "只看今天", all: "累积" }), ...P("deviceReceipts") },
  powerKey: { label: "长按录音键", hint: "hard=真关机 / soft=软关机", schema: z.enum(["hard", "soft"]), show: pick({ hard: "真关机", soft: "软关机" }), ...P("powerKey") },
  theme: { label: "屏幕主题", hint: "classic=默认 / dopamine=多巴胺 / papercut=剪纸 / cool=酷", schema: z.enum(["classic", "dopamine", "papercut", "cool"]), show: pick(THEMES), ...P("theme") },
  remindersEnabled: { label: "到点提醒", hint: "true/false", schema: z.boolean(), show: onOff, ...PS("reminders", "enabled") },
  remindersMode: { label: "提醒怎么消失", hint: "until_ack=一直留着直到确认 / auto_hide=几秒后自动收起", schema: z.enum(["until_ack", "auto_hide"]), show: pick({ until_ack: "一直留着直到确认", auto_hide: "自动收起" }), ...PS("reminders", "mode") },
  remindersAutoHideSec: { label: "提醒自动收起秒数", hint: "3~120", schema: z.number().int().min(3).max(120), show: (v) => `${v} 秒`, ...PS("reminders", "autoHideSec") },
  remindersVibrate: { label: "提醒时振动", hint: "true/false", schema: z.boolean(), show: onOff, ...PS("reminders", "vibrate") },
  remindersExpireDays: { label: "没确认的提醒几天后不再弹", hint: "0=一直弹 / 1 / 3 / 7", schema: z.union([z.literal(0), z.literal(1), z.literal(3), z.literal(7)]), show: (v) => (v === 0 ? "一直弹" : `${v} 天`), ...PS("reminders", "expireDays") },
  audioQuality: { label: "录音音质", hint: "smooth=流畅 / standard=标准 / high=高", schema: z.enum(["smooth", "standard", "high"]), show: pick(QUALITY), ...PS("audio", "quality") },
  chunkSec: { label: "每块录音时长", hint: "5 / 10 / 15 秒", schema: z.union([z.literal(5), z.literal(10), z.literal(15)]), show: (v) => `${v} 秒`, ...PS("audio", "chunkSec") },
  playbackGain: { label: "回放声音", hint: "clear=清晰（人声放大、压住碰撞声）/ denoise=清晰+AI 降噪（再去掉背景噪声）/ standard=标准 / loud=更响 / original=原声", schema: z.enum(["clear", "denoise", "standard", "loud", "original"]), show: pick({ clear: "清晰", denoise: "清晰+AI 降噪", standard: "标准", loud: "更响", original: "原声" }), ...P("playbackGain") },
  vocabularyAdd: { label: "加专业词", hint: "字符串数组，每个 ≤20 字（人名、产品名、行业词）", schema: z.array(z.string().trim().min(1).max(20)).min(1).max(20),
    show: (v) => (v as string[]).join("、"), read: (s) => s.prefs.vocabulary,
    write: (s, v: string[]) => ({ ...s, prefs: { ...s.prefs, vocabulary: [...new Set([...s.prefs.vocabulary, ...v])].slice(0, 100) } }) },
  vocabularyRemove: { label: "删专业词", hint: "字符串数组", schema: z.array(z.string().trim().min(1).max(20)).min(1).max(20),
    show: (v) => (v as string[]).join("、"), read: (s) => s.prefs.vocabulary,
    write: (s, v: string[]) => ({ ...s, prefs: { ...s.prefs, vocabulary: s.prefs.vocabulary.filter((w) => !v.includes(w)) } }) },
  chatPrompts: { label: "聊天快捷问题", hint: "字符串数组，最多 8 个，每个 ≤60 字（整组替换）", schema: z.array(z.string().trim().min(1).max(60)).min(1).max(8), show: (v) => (v as string[]).join(" / "), ...P("chatPrompts") },
  aiTopics: { label: "自动拆主题", hint: "true/false", schema: z.boolean(), show: onOff, ...PS("ai", "topics") },
  aiMinutes: { label: "自动生成会议纪要", hint: "true/false", schema: z.boolean(), show: onOff, ...PS("ai", "minutes") },
  aiMindmap: { label: "自动生成思维导图", hint: "true/false", schema: z.boolean(), show: onOff, ...PS("ai", "mindmap") },
  aiChat: { label: "AI 聊天", hint: "true/false", schema: z.boolean(), show: onOff, ...PS("ai", "chat") },
  intentMode: { label: "什么时候识别要办的事", hint: "auto=全自动识别 / push_to_talk=只识别按住确认键说的", schema: z.enum(["auto", "push_to_talk"]), show: pick(INTENT), ...PS("ai", "intentMode") },
  aiDaily: { label: "每晚自动写小结", hint: "true/false", schema: z.boolean(), show: onOff, ...PS("ai", "daily") },
  aiSuggest: { label: "挑出说过但没让办的事（建议）", hint: "true/false", schema: z.boolean(), show: onOff, ...PS("ai", "suggest") },
  aiSpeakers: { label: "纪要区分说话人", hint: "true/false", schema: z.boolean(), show: onOff, ...PS("ai", "speakers") },
  topicIntervalHours: { label: "长时间开机时每隔几小时拆一次主题", hint: "1~24", schema: z.number().int().min(1).max(24), show: (v) => `${v} 小时`, ...P("topicIntervalHours") },
  scheduleEnabled: { label: "定时开关机", hint: "true/false", schema: z.boolean(), show: onOff, ...SCH("enabled") },
  scheduleOffAt: { label: "定时关机时间", hint: "HH:mm", schema: hhmm, show: String, ...SCH("offAt") },
  scheduleOnAt: { label: "定时开机时间", hint: "HH:mm", schema: hhmm, show: String, ...SCH("onAt") },
  scheduleMode: { label: "定时关机方式", hint: "hard=真关机 / soft=软关机", schema: z.enum(["hard", "soft"]), show: pick({ hard: "真关机", soft: "软关机" }), ...SCH("mode") },
  wakeWord: { label: "唤醒词", hint: "2~8 个汉字", schema: z.string().regex(/^[一-龥]{2,8}$/, "唤醒词只能用 2~8 个汉字"), show: String,
    read: (s) => s.wakeWord, write: (s, v: string) => ({ ...s, wakeWord: v }) },
  retentionDays: { label: "录音保留天数", hint: "0=一直保留，最多 3650", schema: z.number().int().min(0).max(3650), show: (v) => (v === 0 ? "一直保留" : `${v} 天`),
    read: (s) => s.retentionDays, write: (s, v: number) => ({ ...s, retentionDays: v }) },
  tier: { label: "识别档位", hint: "high=高质量 / economy=经济", schema: z.enum(["high", "economy"]), show: pick({ high: "高质量", economy: "经济" }),
    read: (s) => s.tier, write: (s, v: "high" | "economy") => ({ ...s, tier: v }) },
};

/** 执行规则能改的动作及中文名（和网页 format.ts 的 TOOL_LABEL 一致）。没列的动作说了也不改 */
export const TOOL_NAMES: Record<string, string> = {
  "note.create": "记笔记", "feishu.task.create": "飞书任务", "feishu.calendar.create": "飞书日程",
  "feishu.doc.create": "飞书文档", "feishu.message.send": "飞书消息", "webhook.call": "Webhook",
  "homeassistant.service.call": "智能家居", "iot.light.set": "智能灯", "iot.switch.set": "智能开关",
  "iot.climate.set": "空调", "iot.ir.send": "红外遥控", "irrigation.zone.run": "灌溉分区",
  "automation.create": "新建定时规则", "automation.cancel": "取消定时规则",
  "expense.record": "记账", "settings.update": "改设置",
};

const CONFIRM = { always: "每次都先问我", explicit_only: "我明说的直接做，其他先问", never: "直接做，不用问" };
const EXTRACT = { follow: "跟着总设置", push_to_talk: "只听按住说的", off: "不识别" };
/** 执行规则：改某一类动作要不要先问、办完弹不弹、什么时候识别 */
const RuleChange = z.object({
  tool: z.string().min(1).max(160),
  confirmation: ConfirmationMode.optional(),
  notifyDevice: z.boolean().optional(),
  extract: z.enum(["follow", "push_to_talk", "off"]).optional(),
}).refine((r) => r.confirmation || r.notifyDevice !== undefined || r.extract, "规则里至少改一项");

export const SettingChange = z.object({ key: z.string(), value: z.unknown() });
export type SettingChange = z.infer<typeof SettingChange>;

export interface CheckedChanges {
  ok: SettingChange[];
  errors: string[];
  /** 「把飞书消息改成『那就五分钟』」这种念给人听的一句话 */
  summary: string;
  /** 有没有把哪类动作改得更松（要强制出卡片） */
  loosens: boolean;
}

/** 校验并整理成一组改动。tools = 这台系统认识的动作及其中文名（执行规则只能改这些） */
export function checkChanges(raw: unknown, tools: Record<string, string>): CheckedChanges {
  const list = z.array(SettingChange).max(20).safeParse(raw);
  if (!list.success) return { ok: [], errors: ["changes 要是 [{key, value}] 数组"], summary: "", loosens: false };
  const ok: SettingChange[] = [];
  const errors: string[] = [];
  const parts: string[] = [];
  let loosens = false;
  for (const c of list.data) {
    if (c.key === "rule") {
      const r = RuleChange.safeParse(c.value);
      if (!r.success) { errors.push(`执行规则：${r.error.issues[0]?.message ?? "格式不对"}`); continue; }
      const name = tools[r.data.tool];
      if (!name) { errors.push(`没有这类动作：${r.data.tool}`); continue; }
      if (r.data.confirmation && r.data.confirmation !== "always") loosens = true;
      ok.push({ key: "rule", value: r.data });
      parts.push(`「${name}」${[r.data.confirmation && CONFIRM[r.data.confirmation], r.data.notifyDevice !== undefined && `办完${r.data.notifyDevice ? "弹" : "不弹"}到设备`,
        r.data.extract && `识别：${EXTRACT[r.data.extract]}`].filter(Boolean).join("，")}`);
      continue;
    }
    const item = SETTINGS[c.key];
    if (!item) { errors.push(`没有这个设置：${c.key}`); continue; }
    const v = item.schema.safeParse(c.value);
    if (!v.success) { errors.push(`${item.label}：${v.error.issues[0]?.message ?? "取值不对"}（${item.hint}）`); continue; }
    ok.push({ key: c.key, value: v.data });
    parts.push(`${item.label}：${item.show(v.data)}`);
  }
  return { ok, errors, summary: parts.join("；"), loosens };
}

/** 给意图模型 / 聊天看的设置清单 */
export function settingsCatalogText() {
  return Object.entries(SETTINGS).map(([k, i]) => `${k}（${i.label}）: ${i.hint}`).join("\n") +
    "\nrule（执行规则，某一类动作）: {tool, confirmation: always=每次都先问 / explicit_only=明说的直接做 / never=直接做, notifyDevice: 办完弹不弹到设备, extract: follow/push_to_talk/off}";
}

/** 给聊天回答「我现在怎么设的」 */
export function describeSettings(s: UserSettings) {
  return Object.fromEntries(Object.entries(SETTINGS).filter(([k]) => !k.endsWith("Remove") && !k.endsWith("Add"))
    .map(([k, i]) => [k, `${i.label}：${i.show(i.read(s))}`]));
}

/** 卡片标题：一项就直接说，几项就说「改 3 项设置」 */
export function changeTitle(checked: CheckedChanges) {
  if (checked.ok.length === 1) return `改设置：${checked.summary}`.slice(0, 80);
  return `改 ${checked.ok.length} 项设置`;
}

/** 真正执行：读当前设置 → 逐项改 → 存 → 叫设备马上来拉配置。规则写进执行规则表 */
export class SettingsToolExecutor implements ToolExecutor {
  constructor(private readonly settings: SettingsService, private readonly repository: Repository,
    private readonly tools: Record<string, string>) {}

  async execute(draft: ActionDraft) {
    const checked = checkChanges(draft.args.changes, this.tools);
    if (!checked.ok.length) throw new Error(checked.errors.join("；") || "没有要改的设置");
    let next = await this.settings.get(draft.userId);
    const before: string[] = [];
    for (const c of checked.ok) {
      if (c.key === "rule") {
        const r = c.value as z.infer<typeof RuleChange>;
        const current = await this.repository.getToolPolicy(draft.userId, r.tool);
        const base = current ?? { userId: draft.userId, tool: r.tool, confirmation: "explicit_only" as const, maxDraftAgeSec: 86_400, notifyDevice: true, extract: "follow" as const };
        await this.repository.upsertToolPolicy(ToolPolicy.parse({ ...base, ...(r.confirmation ? { confirmation: r.confirmation } : {}),
          ...(r.notifyDevice !== undefined ? { notifyDevice: r.notifyDevice } : {}), ...(r.extract ? { extract: r.extract } : {}),
          updatedAt: new Date().toISOString() }));
        continue;
      }
      const item = SETTINGS[c.key]!;
      before.push(`${item.label}：${item.show(item.read(next))}`);
      next = item.write(next, c.value as never);
    }
    if (next.schedule.enabled && next.schedule.offAt === next.schedule.onAt) throw new Error("关机和开机时间不能相同");
    const { updatedAt: _ignored, ...rest } = next;
    await this.settings.save({ ...rest, prefs: UserPrefs.parse(rest.prefs) });
    await this.repository.enqueueDeviceCommand(draft.userId, "sync_config");
    return { provider: "voxmind", externalId: draft.id, result: { changed: checked.summary, before } };
  }
}

/** 把「改设置」挂到任何一个执行器前面：settings.update 自己办，其余照旧交给原来的执行器 */
export function withSettingsTool(executor: ToolExecutor, settingsTool: ToolExecutor): ToolExecutor {
  return { execute: (draft) => (draft.tool === "settings.update" ? settingsTool.execute(draft) : executor.execute(draft)) };
}

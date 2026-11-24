import { z } from "zod";

export const SessionStatus = z.enum(["recording", "ended", "interrupted"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const Session = z.object({
  id: z.string().uuid(),
  deviceId: z.string().min(1).max(128),
  userId: z.string().min(1).max(128),
  status: SessionStatus,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  /** 这次开机的随机号（设备开机时生成、建会话时带上）。暂停后继续会新开一个会话，但开机号不变——
   *  网页「按开机」视图靠它把一次开机到关机的几段拼成一段。2026-10-04 之前的会话没有，是 null */
  bootId: z.string().max(64).nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Session = z.infer<typeof Session>;

/** 给 AI 读全文的分享链接。链接里带一把随机密钥（数据库只存它的 SHA-256），拿到链接就能读这一段的文字，
 *  到期或撤销后失效。范围可以是整段，也可以是其中一个主题/选中的一截（fromMs~toMs） */
export interface ShareLink {
  /** 分享一段录音（sessionId）或整个收藏文件夹（folderId），二选一 */
  id: string; userId: string; sessionId: string | null; folderId: string | null; fromMs: number; toMs: number | null;
  tokenHash: string; createdAt: string; expiresAt: string; revokedAt: string | null;
  lastUsedAt: string | null; uses: number;
}

export const AudioChunk = z.object({
  sessionId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  objectKey: z.string().min(1),
  contentType: z.string().min(1),
  byteLength: z.number().int().positive(),
  startMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive().max(120_000),
  uploadedAt: z.string().datetime(),
});
export type AudioChunk = z.infer<typeof AudioChunk>;

export const TranscriptSegment = z.object({
  sessionId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  text: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  provider: z.string().min(1),
  status: z.enum(["succeeded", "failed"]),
  error: z.string().nullable(),
  /** speech＝有内容的一句话；silent＝人声检测判为静音、没送识别；
   *  filler＝只有「嗯」「对」这类语气词，不做意图判断；merged＝并进了前面那句 */
  kind: z.enum(["speech", "silent", "filler", "merged"]).default("speech"),
  /** 一句话可能跨好几个 5 秒块，这里记最后一块的序号；单块时为 null */
  endSequence: z.number().int().nonnegative().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;

/** 流水线里一个音频块的处理进度 */
export type ChunkStage = "pending" | "vad" | "silent" | "speech" | "asr" | "done" | "merged" | "failed";
export interface ChunkState extends AudioChunk {
  stage: ChunkStage;
  attempts: number;
  speechMs: number | null;
  vadFirstMs: number | null;
  vadLastMs: number | null;
}

export const QualityTier = z.enum(["high", "economy"]);
export type QualityTier = z.infer<typeof QualityTier>;

/** 定时开关机。off/on 是北京时间 "HH:MM"；mode 决定到点是真关机还是软关机 */
export const PowerSchedule = z.object({
  enabled: z.boolean(),
  offAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  onAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  mode: z.enum(["hard", "soft"]),
});
export type PowerSchedule = z.infer<typeof PowerSchedule>;

export const LedMode = z.enum(["designed", "dark_while_recording", "off"]);

/** 其余偏好统一放一个 JSON 里：加一项不用改表结构。每项都有默认值，老数据缺字段照常解析。*/
export const UserPrefs = z.object({
  /** 回放/导出怎么处理：clear＝清晰（人声拉到正常音量、压住碰撞声，见 audio/clear.ts，默认）；
   *  standard ＝ 固定 +18dB；loud ＝ +26dB；original＝原声。设备录得偏小（实测人声中位 -58 dBFS） */
  playbackGain: z.enum(["clear", "denoise", "standard", "loud", "original"]).default("clear"),
  /** 多久不碰屏幕就熄屏（秒）；0＝不熄屏。有新卡片、按键、触摸会亮 */
  screenOffSec: z.number().int().min(0).max(3600).default(20),
  /** 屏幕黑着的时候，什么情况下自动点亮 */
  screenWake: z.object({
    /** 有事要你确认时点亮（默认开：卡片只振一下，不点亮容易错过） */
    onCard: z.boolean().default(true),
    /** 明确指令直接执行完之后点亮，让你看一眼它办了什么（默认关） */
    onDone: z.boolean().default(false),
    /** 熄屏时碰一下屏幕就点亮（默认开）。关掉＝只有按键能亮：熄屏时触摸芯片深睡，放口袋里不会被蹭亮。
     *  触摸芯片自己会进低功耗，开着只多约 1mA 以内（估算），真正费电的是误亮 */
    onTap: z.boolean().default(true),
    /** 亮着时双击屏幕空白处立刻熄屏（默认开） */
    doubleTapOff: z.boolean().default(true),
  }).default({ onCard: true, onDone: false, onTap: true, doubleTapOff: true }),
  /** 设备首页「已执行」那几张回执：today＝只看今天办的（默认）；all＝累积，没划掉的一直留着 */
  deviceReceipts: z.enum(["today", "all"]).default("today"),
  /** 长按录音键关机：hard＝真关机（默认，最省电）；soft＝软关机（能喊唤醒词开机，但一直耗电） */
  powerKey: z.enum(["hard", "soft"]).default("hard"),
  /** 设备屏幕主题，定义在 themes.ts。不认识的 id 设备端按默认处理 */
  theme: z.enum(["classic", "dopamine", "papercut", "cool"]).default("classic"),
  /** 到点提醒：任务到期时在设备屏上弹卡片 */
  reminders: z.object({
    enabled: z.boolean().default(true),
    /** until_ack＝一直留着直到按确认（默认）；auto_hide＝显示几秒自动消失 */
    mode: z.enum(["until_ack", "auto_hide"]).default("until_ack"),
    autoHideSec: z.number().int().min(3).max(120).default(15),
    /** 弹出时震动 */
    vibrate: z.boolean().default(true),
    /** 一直没确认的提醒，过几天就不再弹：0＝一直弹直到确认（默认），1/3/7＝过了这么多天就收起 */
    expireDays: z.union([z.literal(0), z.literal(1), z.literal(3), z.literal(7)]).default(0),
  }).default({ enabled: true, mode: "until_ack", autoHideSec: 15, vibrate: true, expireDays: 0 }),
  /** 专业术语词库：人名、产品名、行业词。识别时当提示用，"沃克斯麦"才会被听成 VoxMind */
  vocabulary: z.array(z.string().min(1).max(20)).max(100).default([]),
  /** 聊天页的快捷问题（用户自己的高频问题），点一下就问 */
  chatPrompts: z.array(z.string().trim().min(1).max(60)).max(8)
    .default(["今天上午见了谁，聊了什么？", "客户说的预算是多少？", "把下午那个会的纪要要点列一下", "帮我建个飞书任务：明天上午十点给王总回电话"]),
  /** 录音本身的参数：音质和每块多长。都下发给设备，下一次录音生效 */
  audio: z.object({
    /** smooth＝省电省流量、设备最流畅；standard＝默认；high＝安静环境下更清楚 */
    quality: z.enum(["smooth", "standard", "high"]).default("standard"),
    /** 一块录多少秒。块越长越省流量（每块固定 1.2KB 协议开销），但转写晚出来、掉电丢得多 */
    chunkSec: z.union([z.literal(5), z.literal(10), z.literal(15)]).default(5),
  }).default({ quality: "standard", chunkSec: 5 }),
  /** 记账：说「花了多少」时写进飞书多维表格的哪张表 */
  expense: z.object({
    enabled: z.boolean().default(false),
    /** 多维表格 app_token 和数据表 id（用用户自己已有的那张，不去改人家的表结构） */
    appToken: z.string().max(100).default(""),
    tableId: z.string().max(100).default(""),
    /** 表里的字段名，按用户的表来；默认用常见命名 */
    fields: z.object({
      note: z.string().max(40).default("备注"),
      dateText: z.string().max(40).default("日期文本"),
      date: z.string().max(40).default("日期"),
      amount: z.string().max(40).default("金额"),
      category: z.string().max(40).default("类别"),
    }).default({ note: "备注", dateText: "日期文本", date: "日期", amount: "金额", category: "类别" }),
    categories: z.array(z.string().max(20)).max(30)
      .default(["餐饮", "交通", "住宿", "健康", "医疗", "娱乐", "日用", "投资", "其他"]),
    /** 记完给自己发一条飞书消息（带表格链接） */
    notifyFeishu: z.boolean().default(true),
  }).default({ enabled: false, appToken: "", tableId: "",
    fields: { note: "备注", dateText: "日期文本", date: "日期", amount: "金额", category: "类别" },
    categories: ["餐饮", "交通", "住宿", "健康", "医疗", "娱乐", "日用", "投资", "其他"], notifyFeishu: true }),
  /** 长时间开机时，每攒够多少小时就拆一次主题（关机后总会拆一次） */
  topicIntervalHours: z.number().int().min(1).max(24).default(2),
  ai: z.object({
    /** 自动拆主题 */
    topics: z.boolean().default(true),
    /** 自动生成会议纪要 / 思维导图（手动点"生成"不受这两个开关限制） */
    minutes: z.boolean().default(false),
    mindmap: z.boolean().default(false),
    /** 纪要和导图按主题生成还是按整次录音生成 */
    scope: z.enum(["topic", "session"]).default("topic"),
    /** 后台 AI 聊天 */
    chat: z.boolean().default(true),
    /** auto＝一直自动分析每句话；push_to_talk＝只分析按住 OK 键说的那几句 */
    intentMode: z.enum(["auto", "push_to_talk"]).default("auto"),
    /** 每天晚上自动写一份每日小结 */
    daily: z.boolean().default(false),
    /** 拆主题时顺手扫一遍：把没按键说过、但像是要办的事挑出来，等你点一下才建 */
    suggest: z.boolean().default(true),
    /** 生成会议纪要时先做一次分角色转写（谁说了哪句）。这一段音频会被按秒再转一次，多花一份钱 */
    speakers: z.boolean().default(true),
  }).default({ topics: true, minutes: false, mindmap: false, scope: "topic", chat: true, intentMode: "auto",
    daily: false, suggest: true, speakers: true }),
});
export type UserPrefs = z.infer<typeof UserPrefs>;
export const DEFAULT_PREFS: UserPrefs = UserPrefs.parse({});
export type LedMode = z.infer<typeof LedMode>;

export const UserSettings = z.object({
  userId: z.string().min(1).max(128),
  tier: QualityTier,
  /** 录音保留天数；0＝不自动删除。到期删的是音频和转写，动作记录留着 */
  retentionDays: z.number().int().min(0).max(3650),
  /** 唤醒词。引导用户叫两声「小沃小沃」，但识别到一个「小沃」就算 */
  wakeWord: z.string().min(2).max(8),
  schedule: PowerSchedule,
  /** 设备指示灯。designed＝按设计的颜色节奏；dark_while_recording＝录音时不亮、其他状态照常；
   *  off＝全灭。只有管理员能改：录音灯是对旁人的告知，关不关是部署方的决定 */
  ledMode: LedMode,
  prefs: UserPrefs,
  updatedAt: z.string().datetime(),
});
export type UserSettings = z.infer<typeof UserSettings>;

export interface UsageEntry {
  at: string;
  userId: string;
  sessionId: string | null;
  kind: "asr" | "llm" | "embedding";
  provider: string;
  model: string;
  tier: QualityTier;
  audioMs: number;
  inputTokens: number;
  outputTokens: number;
  /** 记账当时的单价算出来的金额。事后改单价不影响已发生的账 */
  costYuan: number;
  /** 花在哪个功能上：「我的 → 花费」按这个分，用户才知道关哪个开关省钱 */
  feature?: UsageFeature;
}
export type UsageFeature = "asr" | "search" | "intent" | "topics" | "minutes" | "mindmap" | "chat" | "daily" | "suggest" | "speakers";

export const DraftStatus = z.enum([
  "pending", "confirmed", "cancelled", "executing", "executed", "failed", "expired",
]);
export type DraftStatus = z.infer<typeof DraftStatus>;

export const ActionMode = z.enum(["suggested", "explicit", "deferred"]);
export const RiskLevel = z.enum([
  "record", "personal_write", "external_write", "physical_control", "destructive",
]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const ActionDraft = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  userId: z.string().min(1).max(128),
  tool: z.string().regex(/^[a-z][a-z0-9_.-]+$/),
  title: z.string().min(1).max(80),
  detail: z.string().max(500),
  args: z.record(z.string(), z.unknown()),
  evidence: z.string().max(1000),
  evidenceStartMs: z.number().int().nonnegative().nullable(),
  evidenceEndMs: z.number().int().nonnegative().nullable(),
  confidence: z.number().min(0).max(1),
  mode: ActionMode,
  risk: RiskLevel,
  status: DraftStatus,
  revision: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(200),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ActionDraft = z.infer<typeof ActionDraft>;

export const ConfirmationMode = z.enum(["always", "explicit_only", "never"]);
export type ConfirmationMode = z.infer<typeof ConfirmationMode>;

export const ToolPolicy = z.object({
  userId: z.string().min(1).max(128),
  tool: z.string().min(1).max(160),
  confirmation: ConfirmationMode,
  maxDraftAgeSec: z.number().int().min(10).max(604_800),
  /** 办完之后把回执推到设备屏（并按「什么时候自动亮屏」决定要不要亮）。
   *  要你确认的卡片不受这个开关影响——那是要你拍板的，一定推。*/
  notifyDevice: z.boolean().default(true),
  /** 什么时候从说话里抽这一类动作：跟随「我的 → AI」里的总开关 / 只在按住确认键时 / 完全不抽。
   *  注意总开关设成「只听按住的」时，没按住的话根本不会送去分析，所以这里选 follow 和 push_to_talk 是一样的。*/
  extract: z.enum(["follow", "push_to_talk", "off"]).default("follow"),
  updatedAt: z.string().datetime(),
});
export type ToolPolicy = z.infer<typeof ToolPolicy>;

export const Execution = z.object({
  id: z.string().uuid(),
  draftId: z.string().uuid(),
  idempotencyKey: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed", "unknown"]),
  provider: z.string(),
  externalId: z.string().nullable(),
  result: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Execution = z.infer<typeof Execution>;

export interface Timeline {
  session: Session;
  chunks: AudioChunk[];
  transcripts: TranscriptSegment[];
  drafts: ActionDraft[];
  executions: Execution[];
}

/** 主题：一次开机录音里按话题切出的一段。AI 拆的 source=ai，人改过/人建的 source=user——
 *  重新拆分时只替换 AI 的，人动过的永远保留。*/
export const Topic = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  userId: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  title: z.string().min(1).max(80),
  summary: z.string().max(500),
  /** 客户或项目名。销售、顾问这类工作是按人回看的，不是按天——空着就是没归类 */
  label: z.string().max(40).default(""),
  source: z.enum(["ai", "user"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Topic = z.infer<typeof Topic>;

/** AI 产出物：会议纪要（Markdown）或思维导图（JSON 树），挂在一个主题或一次录音上 */
export const AiOutput = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  targetType: z.enum(["topic", "session", "day"]),
  targetId: z.string().uuid(),
  /** daily＝每日小结；speakers＝分角色转写的结果（JSON，谁说了哪句） */
  kind: z.enum(["minutes", "mindmap", "daily", "speakers"]),
  template: z.string().max(40),
  content: z.string(),
  model: z.string(),
  createdAt: z.string().datetime(),
});
export type AiOutput = z.infer<typeof AiOutput>;

export interface MindNode { title: string; children?: MindNode[] }

/* ── 提醒：到点在设备屏上弹一张卡，等你按确认 ───────────────────
 * 飞书任务自己也会提醒，但那要掏手机看。这里的卡片是戴在身上的设备直接弹给你，
 * 默认一直留着直到你按确认——提醒的意义就在于"不会被错过"。*/
export const Reminder = z.object({
  id: z.string().uuid(),
  userId: z.string().min(1).max(128),
  /** 从哪张动作卡片来的（飞书任务到期）；手动建的可以为空 */
  draftId: z.string().uuid().nullable().default(null),
  title: z.string().min(1).max(120),
  body: z.string().max(300).default(""),
  remindAt: z.string().datetime(),
  /** pending＝还没到点；sent＝已经推给设备；acked＝你按了确认；cancelled＝任务取消了 */
  status: z.enum(["pending", "sent", "acked", "cancelled"]).default("pending"),
  sentAt: z.string().datetime().nullable().default(null),
  ackedAt: z.string().datetime().nullable().default(null),
  createdAt: z.string().datetime(),
});
export type Reminder = z.infer<typeof Reminder>;

/* ── 建议：看出来了但没替你做的事 ──────────────────────────────
 * 「按住才分析」模式下，没按键说的话本来是彻底没人管的。拆主题时顺手扫一遍那一段，
 * 把像是要办的事、要记的账挑出来放这儿，等用户点一下才真的建——看得见，但不擅自动手。*/
export const Suggestion = z.object({
  id: z.string().uuid(),
  userId: z.string().min(1).max(128),
  sessionId: z.string().uuid(),
  topicId: z.string().uuid().nullable().default(null),
  tool: z.string().min(1).max(160),
  title: z.string().min(1).max(80),
  detail: z.string().max(500).default(""),
  args: z.record(z.string(), z.unknown()).default({}),
  evidence: z.string().max(1000).default(""),
  evidenceStartMs: z.number().int().nonnegative().nullable().default(null),
  evidenceEndMs: z.number().int().nonnegative().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.7),
  /** open＝等你决定；accepted＝已经照它建了；dismissed＝你说不用 */
  status: z.enum(["open", "accepted", "dismissed"]).default("open"),
  /** accepted 之后指向真正建出来的那张卡片 */
  draftId: z.string().uuid().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Suggestion = z.infer<typeof Suggestion>;

/* ── 自动化：到点自己做一件事 ──────────────────────────────────
 * 时间一律按北京时间理解和存（用户和设备都在东八区）。
 * 动作要么是一个已经支持的工具（建任务/日程/文档、发消息），要么是"写今天的小结并发给我"。*/
export const AutomationSchedule = z.object({
  kind: z.enum(["daily", "weekly", "monthly", "once"]),
  /** 北京时间 HH:MM */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** weekly：0=周日 … 6=周六 */
  weekday: z.number().int().min(0).max(6).optional(),
  /** monthly：1–31，遇到没有这一天的月份跳过 */
  day: z.number().int().min(1).max(31).optional(),
  /** once：YYYY-MM-DD（北京时间） */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type AutomationSchedule = z.infer<typeof AutomationSchedule>;

export const AutomationAction = z.object({
  /** tool＝直接做一个动作；daily_summary＝先写今天的小结再发；expense_summary＝按类别汇总一段时间的消费再发 */
  kind: z.enum(["tool", "daily_summary", "expense_summary"]),
  tool: z.string().max(160).default(""),
  args: z.record(z.string(), z.unknown()).default({}),
});
export type AutomationAction = z.infer<typeof AutomationAction>;

export const Automation = z.object({
  id: z.string().uuid(),
  userId: z.string().min(1).max(128),
  title: z.string().min(1).max(80),
  enabled: z.boolean().default(true),
  schedule: AutomationSchedule,
  action: AutomationAction,
  /** 是在网页上建的还是说出来的 */
  source: z.enum(["web", "voice", "chat"]).default("web"),
  lastRunAt: z.string().datetime().nullable().default(null),
  lastStatus: z.string().max(200).default(""),
  nextRunAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Automation = z.infer<typeof Automation>;

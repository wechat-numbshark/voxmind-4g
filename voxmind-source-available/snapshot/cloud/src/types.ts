/**
 * VoxMind 共享类型 —— 设备、云端、飞书三方的唯一契约。
 *
 * 选 TypeScript 的主要理由就在这里：这套协议很碎（三级分类 × 双通道 × 过期规则），
 * 任何一端改了字段，另外两端编译期就会报错，不用等到线上才发现卡片点不动。
 *
 * 对应文档：VoxMind_交接包_20260824/VoxMind_00b_产品需求_v3_20260825.md §二
 */
import { z } from "zod";

/* ────────────────────────────────────────────────────────────────
 * 一、动作三级分类（需求 §2.1）
 *
 * 这条分类是整个交互的地基。不分级的话，用户要么被无休止的卡片打断，
 * 要么某天发现设备替他给老板发了条消息。
 * ──────────────────────────────────────────────────────────────── */
export const ActionTier = z.enum([
  /** A 类｜直接执行：只影响自己、可随时撤销。不问，做完在速览里列一行 */
  "A_AUTO",
  /** B 类｜要确认但可延迟：影响自己的日程/待办，不惊动别人。24h 未确认降级为 A */
  "B_DEFERRABLE",
  /** C 类｜要确认且即时：会惊动他人或不可撤销。15min 未确认作废 */
  "C_IMMEDIATE",
]);
export type ActionTier = z.infer<typeof ActionTier>;

/** 过期策略由分类唯一决定，不要在别处硬编码这些数字 */
export const TIER_POLICY = {
  A_AUTO:       { needsConfirm: false, ttlMs: 0,                onExpire: "none" },
  B_DEFERRABLE: { needsConfirm: true,  ttlMs: 24 * 3600 * 1000, onExpire: "downgrade_to_A" },
  C_IMMEDIATE:  { needsConfirm: true,  ttlMs: 15 * 60 * 1000,   onExpire: "discard" },
} as const satisfies Record<ActionTier, {
  needsConfirm: boolean; ttlMs: number; onExpire: "none" | "downgrade_to_A" | "discard";
}>;

/* ────────────────────────────────────────────────────────────────
 * 二、意图与动作
 * ──────────────────────────────────────────────────────────────── */
export const ActionKind = z.enum([
  "note",              // A：记笔记
  "bookmark",          // A：打书签
  "personal_record",   // A：写个人多维表格
  "calendar_event",    // B：创建日程
  "todo",              // B：创建待办
  "send_message",      // C：发飞书消息（惊动他人）
  "meeting_invite",    // C：发出会议邀请
  "book_room",         // C：预定会议室
  "submit_approval",   // C：提交审批
]);
export type ActionKind = z.infer<typeof ActionKind>;

/** 动作类型 → 分级的固定映射。LLM 只负责判 kind，分级由代码决定，
 *  这样即使模型判飘了也不会把 C 类当 A 类直接执行。 */
export const KIND_TIER: Record<ActionKind, ActionTier> = {
  note:            "A_AUTO",
  bookmark:        "A_AUTO",
  personal_record: "A_AUTO",
  calendar_event:  "B_DEFERRABLE",
  todo:            "B_DEFERRABLE",
  send_message:    "C_IMMEDIATE",
  meeting_invite:  "C_IMMEDIATE",
  book_room:       "C_IMMEDIATE",
  submit_approval: "C_IMMEDIATE",
};

export const ExtractedAction = z.object({
  kind: ActionKind,
  /** 卡片主标题，一行说清要做什么。中文，不超过 20 字 */
  title: z.string().max(40),
  /** 卡片副标题：时间/参与人/地点等关键参数，用户瞥一眼就能判断对不对 */
  detail: z.string().max(120),
  /** 结构化参数，交给下游执行器。不同 kind 字段不同，故用宽松对象 */
  params: z.record(z.string(), z.unknown()),
  /** 0~1。模型自评。分流规则见 CONFIDENCE_POLICY */
  confidence: z.number().min(0).max(1),
  /** 原文里支撑这个判断的片段，用户质疑时可回溯 */
  evidence: z.string().max(200),
});
export type ExtractedAction = z.infer<typeof ExtractedAction>;

export const ExtractionResult = z.object({
  /** 整段转写的一句话摘要，显示在今日速览 */
  summary: z.string().max(60),
  actions: z.array(ExtractedAction),
});
export type ExtractionResult = z.infer<typeof ExtractionResult>;

/* ────────────────────────────────────────────────────────────────
 * 三、置信度分流（需求 §2.4）—— 宁可漏，不可错
 *
 * 设备端弹卡片是「打断用户」，成本很高；飞书是异步的，成本低。
 * 所以中等置信度只往飞书推，不打扰设备。
 * ──────────────────────────────────────────────────────────────── */
export type PushChannel = "device" | "feishu" | "none";

export function routeByConfidence(c: number): { channels: PushChannel[]; note?: string } {
  if (c >= 0.85) return { channels: ["device", "feishu"] };
  if (c >= 0.60) return { channels: ["feishu"], note: "疑似指令，请确认" };
  return { channels: ["none"], note: "仅在转写文本里高亮，不生成卡片" };
}

/* ────────────────────────────────────────────────────────────────
 * 四、待确认卡片（队列里的一条）
 * ──────────────────────────────────────────────────────────────── */
export type CardStatus =
  | "pending"      // 等用户处理
  | "confirmed"    // 已确认，待执行/已执行
  | "discarded"    // 用户按 BACK 丢弃
  | "expired"      // 超时（C 类作废 / B 类降级）
  | "downgraded";  // B 类超时后降级为"只记录"

export interface PendingCard {
  id: string;
  deviceId: string;
  userId: string;
  action: ExtractedAction;
  tier: ActionTier;
  status: CardStatus;
  createdAt: number;
  /** 绝对过期时刻。由 TIER_POLICY.ttlMs 算出，A 类为 null */
  expiresAt: number | null;
  /** 用于双通道状态同步：任一边处理后，另一边要立刻消失 */
  pushedTo: PushChannel[];
  feishuMessageId?: string | undefined;   // exactOptionalPropertyTypes 下要显式带 undefined
  /** 来源录音，用户可回听 */
  recordingId: string;
}

/* ────────────────────────────────────────────────────────────────
 * 五、设备 ⇄ 云 的 MQTT 消息
 * ──────────────────────────────────────────────────────────────── */
export type DeviceTopic =
  | `voxmind/${string}/card`      // 云 → 设备：推卡片
  | `voxmind/${string}/ack`       // 设备 → 云：确认/丢弃/跳过
  | `voxmind/${string}/state`;    // 设备 → 云：电量、网络、队列长度

export interface CardPush {
  type: "card";
  card: Pick<PendingCard, "id" | "tier" | "expiresAt"> & {
    title: string; detail: string;
  };
  /** 设备收到后要做的反馈：马达短振两下 + LED 蓝呼吸（需求 §三状态表）*/
  feedback: { motorBuzzTimes: number; led: "blue_breath" };
}

export interface DeviceAck {
  type: "ack";
  cardId: string;
  /** OK=确认 / BACK=丢弃 / REC=跳过（留在队列）—— 需求 §2.3 */
  action: "confirm" | "discard" | "skip";
  at: number;
}

/* ────────────────────────────────────────────────────────────────
 * 六、上传窗口（需求 §2.5 T4）
 *
 * ★ 设备上传完成后会保持唤醒 30 秒等卡片，之后才回 PSM。
 *   云端必须在这个窗口内把卡片推出去，否则要等下一个 PSM 周期（可能 1 小时）。
 *   —— 这是「有网了马上处理」能不能成立的关键。
 * ──────────────────────────────────────────────────────────────── */
export const DEVICE_AWAKE_WINDOW_MS = 30_000;

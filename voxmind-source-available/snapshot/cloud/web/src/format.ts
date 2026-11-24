import type { ActionDraft } from "./api.ts";

/** 风险等级 → 卡槽颜色。和服务端 TOOL_RISKS / DEFAULT_POLICY 同一套分级。 */
export type Tier = "ext" | "own" | "rec" | "phy";

export function tierOf(risk: ActionDraft["risk"]): Tier {
  switch (risk) {
    case "external_write": case "destructive": return "ext";
    case "physical_control": return "phy";
    case "record": return "rec";
    default: return "own";
  }
}

/** 执行回执里只有工具名，没有风险字段：按服务端 TOOL_RISKS 同一张表反查 */
const TOOL_TIER: Record<string, Tier> = {
  "note.create": "rec", "feishu.task.create": "own", "feishu.calendar.create": "own", "feishu.doc.create": "own",
  "feishu.message.send": "ext", "webhook.call": "ext", "homeassistant.service.call": "phy",
  "iot.light.set": "phy", "iot.switch.set": "phy", "iot.climate.set": "phy", "iot.ir.send": "phy",
  "irrigation.zone.run": "phy",
  "automation.create": "own", "automation.cancel": "own", "expense.record": "own",
};
export const tierOfTool = (tool: string): Tier => TOOL_TIER[tool] ?? "own";

export const TIER_LABEL: Record<Tier, string> = { ext: "对外", own: "个人", rec: "记录", phy: "设备" };

export const TOOL_LABEL: Record<string, string> = {
  "note.create": "记笔记",
  "feishu.task.create": "飞书任务",
  "feishu.calendar.create": "飞书日程",
  "feishu.doc.create": "飞书文档",
  "feishu.message.send": "飞书消息",
  "webhook.call": "Webhook",
  "homeassistant.service.call": "智能家居",
  "iot.light.set": "智能灯",
  "iot.switch.set": "智能开关",
  "iot.climate.set": "空调",
  "iot.ir.send": "红外遥控",
  "irrigation.zone.run": "灌溉分区",
  "automation.create": "新建定时规则",
  "automation.cancel": "取消定时规则",
  "expense.record": "记一笔账",
  "settings.update": "改设置",
};
export const toolLabel = (tool: string) => TOOL_LABEL[tool] ?? tool;

export const STATUS_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "bad" | "info" | "" }> = {
  pending: { text: "待签放", tone: "warn" },
  confirmed: { text: "已签放", tone: "info" },
  executing: { text: "执行中", tone: "info" },
  executed: { text: "已执行", tone: "ok" },
  succeeded: { text: "成功", tone: "ok" },
  failed: { text: "失败", tone: "bad" },
  unknown: { text: "结果未知", tone: "bad" },
  queued: { text: "排队", tone: "" },
  running: { text: "执行中", tone: "info" },
  cancelled: { text: "已退回", tone: "" },
  expired: { text: "已作废", tone: "" },
  active: { text: "正常", tone: "ok" },
  disabled: { text: "已停用", tone: "" },
  revoked: { text: "已吊销", tone: "bad" },
};

const pad = (n: number) => String(n).padStart(2, "0");

export function hhmm(iso: string | number) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dayKey(iso: string | number) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dayLabel(iso: string | number) {
  const key = dayKey(iso);
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 86_400_000);
  if (key === today) return "今天";
  if (key === yesterday) return "昨天";
  const d = new Date(iso);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export function stamp(iso: string | number) {
  const d = new Date(iso);
  return `${dayLabel(iso)} ${hhmm(d.getTime())}`;
}

/** 多久以前。超过一天就给日期，免得"73 小时前"这种要心算的说法 */
export function ago(iso: string | null | undefined) {
  if (!iso) return "从未";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86_400) return `${Math.floor(s / 3600)} 小时前`;
  return stamp(iso);
}

export function clock(sec: number) {
  if (sec >= 3600) return `${Math.floor(sec / 3600)}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`;
  return `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
}

export function offset(ms: number) {
  return clock(Math.floor(ms / 1000));
}

export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function hours(ms: number) {
  const h = ms / 3_600_000;
  return h < 1 ? `${Math.round(ms / 60_000)} 分钟` : `${h.toFixed(1)} 小时`;
}

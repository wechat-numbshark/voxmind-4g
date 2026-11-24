/* 动作里的时间：模型只写北京时间的"日期 时:分"，换算成时间戳由这里做。
 *
 * 以前让模型直接输出 Unix 毫秒，它不知道今天几号，只能猜——实测"明天上午10点"
 * 被写成 2024-09-19、2025-03-22、2025-11-20，飞书任务全落在过去，看起来像没建成。
 * 现在：给模型看"录音时间 2026-09-19 周六 17:23"，让它写 "2026-09-20 10:00"，
 * 这边换算，并且检查落没落在合理范围（录音前 12 小时 ~ 之后 400 天），离谱就丢掉，
 * 宁可没有截止时间，也不要一个错的。*/

const BJ_OFFSET_MS = 8 * 3_600_000;
const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-09-19 周六 17:23"：给模型看的录音时间 */
export function beijingLabel(at: Date | string) {
  const d = new Date(new Date(at).getTime() + BJ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${WEEK[d.getUTCDay()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 解析 "2026-09-20 10:00" / "2026-09-20"（北京时间）。只给日期时 allDay=true */
export function parseBeijing(text: unknown): { ms: number; allDay: boolean } | null {
  if (typeof text !== "string") return null;
  const m = text.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const allDay = h === undefined;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), allDay ? 0 : Number(h), allDay ? 0 : Number(mi)) - BJ_OFFSET_MS;
  const check = new Date(ms + BJ_OFFSET_MS);
  if (check.getUTCDate() !== Number(d) || check.getUTCMonth() !== Number(mo) - 1) return null;   // 2 月 30 日之类
  return { ms, allDay };
}

/** 落在录音前 12 小时到之后 400 天之间才算数 */
export function plausible(ms: number, recordedAt: Date | string) {
  const base = new Date(recordedAt).getTime();
  return ms >= base - 12 * 3_600_000 && ms <= base + 400 * 86_400_000;
}

/** 通用写法、不是事情本身的标题（"创建飞书任务"），要换成 summary */
const GENERIC_TITLE = /^(请|帮我|给我)?(创建|新建|建|加|添加|生成|记)?(一个|一条|个)?(飞书)?(任务|待办|日程|文档|笔记|会议)$/;

export function isGenericTitle(title: string) {
  return GENERIC_TITLE.test(title.replace(/[\s，,。.！!]/g, ""));
}

/* 只说了哪天、没说几点时，补一个截止时刻。规则是用户定的：
 * 上午→12:00、下午→18:00、晚上或者没提→21:00。
 * 为什么要补：飞书任务和我们自己的提醒都要一个确切时刻才提醒得了；
 * 留成"全天"的话，到点提醒就无从谈起。*/
export const DUE_HOUR = { morning: "12:00", afternoon: "18:00", evening: "21:00", none: "21:00" } as const;
export type DuePart = keyof typeof DUE_HOUR;

export function duePartOf(value: unknown): DuePart {
  const text = String(value ?? "").trim();
  if (/morning|上午|早上|早晨|中午前/.test(text)) return "morning";
  if (/afternoon|下午|午后/.test(text)) return "afternoon";
  if (/evening|night|晚上|傍晚|今晚|明晚/.test(text)) return "evening";
  return "none";
}

/** 把模型给的动作参数规范成连接器要的格式。返回规范后的 args 和要追加的说明（比如"时间没听清"）。*/
export function normalizeActionArgs(tool: string, rawArgs: Record<string, unknown>, recordedAt: Date | string) {
  const args = { ...rawArgs };
  const notes: string[] = [];
  if (tool === "feishu.task.create") {
    delete args.dueTimestampMs;                    // 模型自己算的时间戳一律不信
    const part = duePartOf(args.duePart ?? args.due);
    delete args.duePart;
    /* 只说了哪天就按规矩补一个时刻：上午 12:00、下午 18:00、其余 21:00 */
    const raw = typeof args.due === "string" && /^\d{4}-\d{1,2}-\d{1,2}$/.test(args.due.trim())
      ? `${args.due.trim()} ${DUE_HOUR[part]}` : args.due;
    const due = parseBeijing(raw);
    delete args.due;
    if (due && plausible(due.ms, recordedAt)) {
      args.dueTimestampMs = due.ms;
      args.allDay = false;                         // 有确切时刻才提醒得了，不再留"全天"
      if (raw !== rawArgs.due) notes.push(`没说几点，按${part === "morning" ? "上午" : part === "afternoon" ? "下午" : "默认"}算到 ${DUE_HOUR[part]}`);
    } else if (rawArgs.due) {
      notes.push("截止时间没听清，没有设置");
    }
  }
  if (tool === "feishu.calendar.create") {
    delete args.startTimestamp; delete args.endTimestamp;
    const start = parseBeijing(args.start);
    const end = parseBeijing(args.end);
    delete args.start; delete args.end;
    if (start && !start.allDay && plausible(start.ms, recordedAt)) {
      args.startTimestamp = Math.round(start.ms / 1000);
      // 没说结束时间：默认一小时
      const endMs = end && !end.allDay && end.ms > start.ms ? end.ms : start.ms + 3_600_000;
      args.endTimestamp = Math.round(endMs / 1000);
      args.timezone = "Asia/Shanghai";
    } else {
      notes.push("日程时间没听清，需要补上");
    }
  }
  return { args, notes };
}

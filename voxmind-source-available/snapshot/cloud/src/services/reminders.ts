import { randomUUID } from "node:crypto";
import type { ActionDraft, Reminder } from "../domain.js";
import type { SettingsService } from "./settings.js";
import type { Repository } from "../store/repository.js";

/* 到点提醒。
 *
 * 飞书任务自己会提醒，但那要掏手机看。这里的提醒是戴在身上的设备直接弹一张卡，
 * 默认一直留着直到你按确认——提醒的价值就在于"不会被错过"。
 *
 * 推送靠设备本来就在做的轮询（1.5~4.5 秒一次）捎带，不另开通道，
 * 所以最多晚几秒，用户说 5 分钟内的误差都可以，这个精度绰绰有余。*/

export class ReminderService {
  constructor(private readonly deps: { repository: Repository; settings: SettingsService;
    logger?: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void } }) {}

  /** 任务真的建成了、而且有截止时间，就排一条提醒。已经排过的不重复排。*/
  async scheduleForDraft(draft: ActionDraft) {
    if (draft.tool !== "feishu.task.create") return null;
    const dueMs = Number(draft.args.dueTimestampMs ?? NaN);
    if (!Number.isFinite(dueMs)) return null;
    const prefs = (await this.deps.settings.get(draft.userId)).prefs.reminders;
    if (!prefs.enabled) return null;
    /* 已经过了的不补提醒：早上补昨天的闹钟只会让人困惑 */
    if (dueMs < Date.now() - 60_000) return null;
    const existing = (await this.deps.repository.listReminders(draft.userId, 200))
      .find((r) => r.draftId === draft.id && r.status !== "cancelled");
    if (existing) return existing;
    const reminder: Reminder = { id: randomUUID(), userId: draft.userId, draftId: draft.id,
      title: draft.title.slice(0, 120), body: String(draft.args.description ?? draft.detail ?? "").slice(0, 300),
      remindAt: new Date(dueMs).toISOString(), status: "pending", sentAt: null, ackedAt: null,
      createdAt: new Date().toISOString() };
    await this.deps.repository.createReminder(reminder);
    this.deps.logger?.info({ draftId: draft.id, at: reminder.remindAt }, "已排一条到点提醒");
    return reminder;
  }

  /** 到点的标成"已推"，设备下一次轮询就会拿到。每分钟调一次。*/
  async tick(now = Date.now(), limit = 50) {
    const due = await this.deps.repository.dueReminders(new Date(now).toISOString(), limit);
    for (const reminder of due) {
      await this.deps.repository.updateReminder(reminder.id, { status: "sent", sentAt: new Date(now).toISOString() });
    }
    return due.length;
  }

  /** 设备该显示哪一条。没有就返回 null（绝大多数轮询都是这条）。*/
  async activeFor(userId: string, now = Date.now()) {
    const days = (await this.deps.settings.get(userId)).prefs.reminders.expireDays;
    return this.deps.repository.activeReminder(userId, new Date(now).toISOString(),
      days > 0 ? new Date(now - days * 86_400_000).toISOString() : undefined);
  }

  async ack(id: string, userId: string) {
    const reminder = await this.deps.repository.getReminder(id);
    if (!reminder || reminder.userId !== userId) return null;
    if (reminder.status === "acked") return reminder;
    return this.deps.repository.updateReminder(id, { status: "acked", ackedAt: new Date().toISOString() });
  }

  /** 任务被退回/作废：它的提醒也别再弹了 */
  async cancelForDraft(draftId: string) {
    return this.deps.repository.cancelRemindersForDraft(draftId);
  }
}

/* 设备卡片上怎么写这条提醒。
 *
 * 标题是建任务时的原话，里面的"明天"是相对建任务那天说的；到点弹出来已经是当天了，
 * 屏上写"明天10点拜访客户"会让人以为还没到。所以把"今天/明天/后天/今晚/明早"这类词去掉，
 * 由下面一行写清楚到底是哪天几点——只改屏上显示，飞书里的任务标题不动。
 *
 * 日期那行：当天写"今天 10:00"，昨天写"昨天 10:00"，再早的写"9月26日 10:00（5 天前）"，
 * 一眼看出是一条积压的旧提醒。*/
const RELATIVE_DAY = /(大后天|后天|明天|今天|明早|明晚|今早|今晚)/g;

export function deviceReminderTitle(title: string) {
  const stripped = title.replace(RELATIVE_DAY, "").replace(/^[\s，,、]+/, "").trim();
  return stripped || title;
}

/* 备注和标题是同一句话时不显示：建任务时备注常常就是原话，屏上会重复一遍（还带着"明天"）。
 * 备注里的相对日期不去删——它是自由文本，"今天的会改到明天"这种句子删了就读不通了。*/
export function deviceReminderBody(title: string, body: string) {
  const norm = (t: string) => deviceReminderTitle(t).replace(/[\s，,。.、！!？?：:；;]/g, "");
  const b = norm(body);
  return b && b !== norm(title) && !norm(title).includes(b) ? body : "";
}

export function deviceReminderWhen(remindAtIso: string, now = Date.now()) {
  const bjDay = (ms: number) => Math.floor((ms + 8 * 3_600_000) / 86_400_000);
  const at = new Date(remindAtIso).getTime();
  const days = bjDay(now) - bjDay(at);
  const bj = new Date(at + 8 * 3_600_000);
  const hm = `${String(bj.getUTCHours()).padStart(2, "0")}:${String(bj.getUTCMinutes()).padStart(2, "0")}`;
  if (days <= 0) return `今天 ${hm}`;
  if (days === 1) return `昨天 ${hm}`;
  return `${bj.getUTCMonth() + 1}月${bj.getUTCDate()}日 ${hm}（${days} 天前）`;
}

import { randomUUID } from "node:crypto";
import type { Automation, AutomationSchedule, QualityTier } from "../domain.js";
import { beijingDay, type DailyService } from "../ai/daily.js";
import type { ActionService } from "./actions.js";
import type { ExecutionService } from "./execution.js";
import type { SettingsService } from "./settings.js";
import type { Repository } from "../store/repository.js";

/* 自动化：到点自己做一件事。
 *
 * 用户在网页上建，也可以对着设备说「每天早上八点提醒我量体重」。到点之后不再问，
 * 直接执行——是你自己定的闹钟，没道理再弹一张卡片让你确认。但它走的还是同一条执行链路：
 * 生成一张动作卡片 → 直接签放 → 执行。所以「任务中心」里能看到它做过什么、成没成功。
 *
 * 时间一律按北京时间理解（用户和设备都在东八区），存进库里的是算好的 UTC 时刻。*/

const BJ = 8 * 3_600_000;
const DAY = 86_400_000;

/** 北京时间的年月日时分 */
function bjParts(ms: number) {
  const d = new Date(ms + BJ);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate(), weekday: d.getUTCDay(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}
/** 北京时间某年某月某日某时某分对应的 UTC 毫秒 */
function bjTime(y: number, m: number, day: number, hhmm: string) {
  const [h, min] = hhmm.split(":").map(Number);
  return Date.UTC(y, m, day, h!, min!) - BJ;
}

/** 下一次该在什么时候跑；已经没有下一次（一次性且已过）时返回 null */
export function nextRun(schedule: AutomationSchedule, after = Date.now()): number | null {
  const p = bjParts(after);
  if (schedule.kind === "once") {
    if (!schedule.date) return null;
    const [y, m, d] = schedule.date.split("-").map(Number);
    const at = bjTime(y!, m! - 1, d!, schedule.time);
    return at > after ? at : null;
  }
  if (schedule.kind === "daily") {
    const today = bjTime(p.y, p.m, p.day, schedule.time);
    return today > after ? today : today + DAY;
  }
  if (schedule.kind === "weekly") {
    const want = schedule.weekday ?? 1;
    for (let i = 0; i < 8; i++) {
      const at = bjTime(p.y, p.m, p.day + i, schedule.time);
      if (at > after && bjParts(at).weekday === want) return at;
    }
    return null;
  }
  // monthly：某月没有 31 号就跳过那个月，不提前也不推后
  const want = schedule.day ?? 1;
  for (let i = 0; i < 14; i++) {
    const at = bjTime(p.y, p.m + i, want, schedule.time);
    if (at > after && bjParts(at).day === want) return at;
  }
  return null;
}

/** 说人话的时间描述，网页和设备上都用它 */
export function scheduleLabel(s: AutomationSchedule) {
  const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  if (s.kind === "once") return `${s.date} ${s.time}`;
  if (s.kind === "daily") return `每天 ${s.time}`;
  if (s.kind === "weekly") return `每${week[s.weekday ?? 1]} ${s.time}`;
  return `每月 ${s.day ?? 1} 号 ${s.time}`;
}

export interface AutomationInput {
  userId: string;
  title: string;
  schedule: AutomationSchedule;
  action: Automation["action"];
  source?: Automation["source"] | undefined;
  enabled?: boolean | undefined;
}

export class AutomationService {
  constructor(private readonly deps: { repository: Repository; actions: ActionService; executions: ExecutionService;
    settings: SettingsService; daily?: DailyService;
    /** 读多维表格里的消费记录（只读）。没接就做不了消费汇总 */
    expenses?: (appToken: string, tableId: string, fields: { date: string; amount: string; category: string; note: string },
                fromMs: number, toMs: number) => Promise<{ amount: number; category: string; note: string; at: number }[]>; logger?: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void } }) {}

  async create(input: AutomationInput): Promise<Automation> {
    const at = nextRun(input.schedule);
    if (at === null) throw new Error("这个时间已经过去了，换一个时间");
    const now = new Date().toISOString();
    return this.deps.repository.createAutomation({
      id: randomUUID(), userId: input.userId, title: input.title.slice(0, 80),
      enabled: input.enabled ?? true, schedule: input.schedule, action: input.action,
      source: input.source ?? "web", lastRunAt: null, lastStatus: "", nextRunAt: new Date(at).toISOString(),
      createdAt: now, updatedAt: now,
    });
  }

  async update(id: string, patch: { title?: string | undefined; schedule?: AutomationSchedule | undefined;
    action?: Automation["action"] | undefined; enabled?: boolean | undefined }) {
    const current = await this.deps.repository.getAutomation(id);
    if (!current) return null;
    const schedule = patch.schedule ?? current.schedule;
    const at = nextRun(schedule);
    return this.deps.repository.updateAutomation(id, {
      ...(patch.title ? { title: patch.title.slice(0, 80) } : {}),
      ...(patch.schedule ? { schedule } : {}),
      ...(patch.action ? { action: patch.action } : {}),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(at === null ? {} : { nextRunAt: new Date(at).toISOString() }),
    });
  }

  /** 按标题找用户的自动化：说「取消每天量体重」时用它认人 */
  async findByTitle(userId: string, words: string) {
    const needle = words.replace(/\s/g, "").toLowerCase();
    const all = await this.deps.repository.listAutomations(userId);
    return all.find((a) => {
      const title = a.title.replace(/\s/g, "").toLowerCase();
      return title.includes(needle) || needle.includes(title);
    }) ?? null;
  }

  /** 到点了就跑。每分钟调一次。 */
  async tick(now = Date.now(), limit = 20) {
    const due = await this.deps.repository.dueAutomations(new Date(now).toISOString(), limit);
    let ran = 0;
    for (const automation of due) {
      let status = "已执行";
      try {
        await this.run(automation);
        ran++;
      } catch (error) {
        status = `失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
        this.deps.logger?.warn({ id: automation.id, error: status }, "自动化执行失败");
      }
      /* 不管成没成功都要把下一次时间推到将来，否则每分钟都会重跑一遍同一条 */
      const at = nextRun(automation.schedule, now);
      await this.deps.repository.updateAutomation(automation.id, {
        lastRunAt: new Date(now).toISOString(), lastStatus: status,
        ...(at === null ? { enabled: false } : { nextRunAt: new Date(at).toISOString() }),
      });
    }
    return ran;
  }

  /** 立刻跑一次（定时到了，或者用户在网页上点「现在运行」） */
  async run(automation: Automation) {
    const tier: QualityTier = (await this.deps.settings.get(automation.userId)).tier;
    const action = automation.action;
    let tool = action.tool;
    let args = { ...action.args };
    let title = automation.title;

    if (action.kind === "expense_summary") {
      /* 消费汇总：把多维表格里这段时间的记录读回来，按类别加总。
       * 读表只读、汇总在我们这边算，不花模型钱。*/
      const days = Number(args.days ?? 7);
      const prefs = (await this.deps.settings.get(automation.userId)).prefs.expense;
      if (!prefs.appToken || !prefs.tableId) throw new Error("还没配记账用的多维表格");
      if (!this.deps.expenses) throw new Error("飞书没授权，读不了多维表格");
      const to = Date.now(), from = to - days * 86_400_000;
      const rows = await this.deps.expenses(prefs.appToken, prefs.tableId, prefs.fields, from, to);
      const total = rows.reduce((n, r) => n + r.amount, 0);
      const byCategory = new Map<string, number>();
      for (const r of rows) byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + r.amount);
      const yuan = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
      const label = `${new Date(from + 8 * 3_600_000).toISOString().slice(0, 10)} 起 ${days} 天`;
      const text = rows.length
        ? [`【消费汇总】${label}`, `共 ${rows.length} 笔，合计 ${yuan(total)} 元`, "",
           ...[...byCategory].sort((a, b) => b[1] - a[1])
             .map(([name, sum]) => `${name}：${yuan(sum)} 元（${Math.round(sum / total * 100)}%）`),
           "", `最大一笔：${yuan(Math.max(...rows.map((r) => r.amount)))} 元`].join("\n")
        : `【消费汇总】${label}：一笔都没有`;
      const receiveId = String(args.receiveId ?? "");
      if (!receiveId) return { generated: true, text };
      tool = "feishu.message.send";
      args = { receiveId, receiveIdType: String(args.receiveIdType ?? "open_id"), text };
      title = `${automation.title}（${label}）`;
    } else if (action.kind === "daily_summary") {
      if (!this.deps.daily) throw new Error("没有配置大模型，写不了小结");
      const day = beijingDay();
      const output = (await this.deps.daily.get(automation.userId, day))
        ?? await this.deps.daily.generate(automation.userId, day, tier);
      const receiveId = String(args.receiveId ?? "");
      if (!receiveId) return { generated: true };          // 只生成，不发给谁
      tool = "feishu.message.send";
      args = { receiveId, receiveIdType: String(args.receiveIdType ?? "open_id"),
        text: `【${day} 小结】\n${output.content}`.slice(0, 4000) };
      title = `${automation.title}（${day}）`;
    }
    if (!tool) throw new Error("这条自动化没有设置要做什么");

    /* 走和说话、聊天一样的链路：先生成卡片再签放，任务中心里能查到 */
    const sessionId = await this.sessionFor(automation.userId);
    const draft = await this.deps.actions.createDraft({
      sessionId, userId: automation.userId, tool, title: title.slice(0, 80),
      detail: `自动化：${scheduleLabel(automation.schedule)}`,
      args, evidence: `（自动化）${automation.title}`, confidence: 1, mode: "explicit",
      risk: riskOf(tool),
    });
    const confirmed = draft.status === "pending" ? (await this.deps.actions.confirm(draft.id))?.draft ?? draft : draft;
    await this.deps.executions.execute(confirmed);
    return { draftId: draft.id };
  }

  /** 自动化产生的动作也挂在一次"录音"上：用一个固定的自动化会话，录音页显示为「自动化」 */
  private async sessionFor(userId: string) {
    const existing = (await this.deps.repository.listSessions(50, userId)).find((s) => s.deviceId === "automation");
    if (existing) return existing.id;
    const id = randomUUID();
    await this.deps.repository.createSession({ id, deviceId: "automation", userId, startedAt: new Date().toISOString() });
    return id;
  }
}

function riskOf(tool: string): "record" | "personal_write" | "external_write" | "physical_control" {
  if (tool === "note.create") return "record";
  if (tool === "feishu.message.send" || tool === "webhook.call") return "external_write";
  if (tool === "homeassistant.service.call" || tool.startsWith("iot.") || tool.startsWith("irrigation.")) return "physical_control";
  return "personal_write";
}

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ActionDraft } from "../src/domain.js";
import { ActionService } from "../src/services/actions.js";
import { ExecutionService } from "../src/services/execution.js";
import { ReminderService, deviceReminderBody, deviceReminderTitle, deviceReminderWhen } from "../src/services/reminders.js";
import { SettingsService } from "../src/services/settings.js";
import { MemoryRepository } from "../src/store/memory.js";

/* 到点提醒：任务有截止时间 → 排一条 → 到点推给设备 → 按确认才算收到。
 * 盯的是：没到点不推、推过不重复排、任务退回时提醒要跟着撤、关掉开关就不排。*/

function setup() {
  const repository = new MemoryRepository();
  const settings = new SettingsService(repository, "high");
  const reminders = new ReminderService({ repository, settings });
  return { repository, settings, reminders };
}

function taskDraft(dueMs: number | undefined, userId = "owner"): ActionDraft {
  const now = new Date().toISOString();
  return { id: randomUUID(), sessionId: randomUUID(), userId, tool: "feishu.task.create",
    title: "给张总回电话", detail: "", args: dueMs ? { summary: "给张总回电话", dueTimestampMs: dueMs } : { summary: "x" },
    evidence: "", evidenceStartMs: null, evidenceEndMs: null, confidence: 1, mode: "explicit", risk: "personal_write",
    status: "confirmed", revision: 1, idempotencyKey: randomUUID(), createdAt: now, updatedAt: now };
}

describe("排提醒", () => {
  it("任务有截止时间就排一条；同一张卡片不重复排", async () => {
    const { repository, reminders } = setup();
    const draft = taskDraft(Date.now() + 3600_000);
    await repository.createDraft(draft);
    const first = await reminders.scheduleForDraft(draft);
    expect(first).toMatchObject({ draftId: draft.id, status: "pending", title: "给张总回电话" });
    const second = await reminders.scheduleForDraft(draft);
    expect(second!.id).toBe(first!.id);
    expect(await repository.listReminders("owner", 10)).toHaveLength(1);
  });

  it("没有截止时间、或者时间已经过去的，不排", async () => {
    const { repository, reminders } = setup();
    const noDue = taskDraft(undefined);
    await repository.createDraft(noDue);
    expect(await reminders.scheduleForDraft(noDue)).toBeNull();
    const past = taskDraft(Date.now() - 3600_000);
    await repository.createDraft(past);
    expect(await reminders.scheduleForDraft(past)).toBeNull();
  });

  it("关掉提醒就不排", async () => {
    const { repository, settings, reminders } = setup();
    const s = await settings.get("owner");
    await settings.save({ ...s, prefs: { ...s.prefs, reminders: { ...s.prefs.reminders, enabled: false } } });
    const draft = taskDraft(Date.now() + 3600_000);
    await repository.createDraft(draft);
    expect(await reminders.scheduleForDraft(draft)).toBeNull();
  });

  it("只有真的执行成功才排——建失败的任务不该有闹钟", async () => {
    const { repository, reminders } = setup();
    const boom = { async execute() { throw new Error("飞书没授权"); } };
    const executions = new ExecutionService(repository, boom, (d) => reminders.scheduleForDraft(d));
    const draft = taskDraft(Date.now() + 3600_000);
    await repository.createDraft(draft);
    await expect(executions.execute(draft)).rejects.toThrow("飞书没授权");
    expect(await repository.listReminders("owner", 10)).toHaveLength(0);

    const ok = { async execute() { return { provider: "t", externalId: "1", result: {} }; } };
    const good = new ExecutionService(repository, ok, (d) => reminders.scheduleForDraft(d));
    const draft2 = taskDraft(Date.now() + 3600_000);
    await repository.createDraft(draft2);
    await good.execute(draft2);
    expect(await repository.listReminders("owner", 10)).toHaveLength(1);
  });
});

describe("到点与确认", () => {
  it("没到点不推；到点标成已推，设备拿得到；按确认后不再弹", async () => {
    const { repository, reminders } = setup();
    const at = Date.now() + 600_000;
    const draft = taskDraft(at);
    await repository.createDraft(draft);
    await reminders.scheduleForDraft(draft);

    expect(await reminders.tick(Date.now())).toBe(0);
    expect(await reminders.activeFor("owner")).toBeNull();

    expect(await reminders.tick(at + 1000)).toBe(1);
    const active = await reminders.activeFor("owner", at + 1000);
    expect(active).toMatchObject({ status: "sent", title: "给张总回电话" });

    await reminders.ack(active!.id, "owner");
    expect(await reminders.activeFor("owner", at + 2000)).toBeNull();
    // 别人的提醒确认不了
    expect(await reminders.ack(active!.id, "someone-else")).toBeNull();
  });

  it("任务退回时提醒跟着撤掉，不会到点还弹", async () => {
    const { repository, reminders } = setup();
    const at = Date.now() + 600_000;
    const actions = new ActionService(repository, (id) => reminders.cancelForDraft(id));
    const draft = { ...taskDraft(at), status: "pending" as const };
    await repository.createDraft(draft);
    await reminders.scheduleForDraft({ ...draft, status: "confirmed" });
    expect(await repository.listReminders("owner", 10)).toHaveLength(1);

    await actions.cancel(draft.id);
    expect(await reminders.tick(at + 1000)).toBe(0);
    expect(await reminders.activeFor("owner", at + 1000)).toBeNull();
    expect((await repository.listReminders("owner", 10))[0]!.status).toBe("cancelled");
  });
});

describe("设备卡片上的提醒文字", () => {
  it("去掉「明天/今天/今晚」这类相对日期：到点时已经是当天了，写「明天」会让人以为还没到", () => {
    expect(deviceReminderTitle("明天10点拜访客户")).toBe("10点拜访客户");
    expect(deviceReminderTitle("今晚给王总回电话")).toBe("给王总回电话");
    expect(deviceReminderTitle("后天，交周报")).toBe("交周报");
    expect(deviceReminderTitle("交周报")).toBe("交周报");
    expect(deviceReminderTitle("明天")).toBe("明天");          // 全删光了就保留原样
  });

  it("备注和标题重复就不显示；真正的备注照常显示、里面的字不动", () => {
    expect(deviceReminderBody("明天10点拜访客户", "明天10点拜访客户")).toBe("");
    expect(deviceReminderBody("明天10点拜访客户", "10点拜访客户。")).toBe("");
    expect(deviceReminderBody("给王总回电话", "明天上午十点联系王总，确认项目进展。")).toBe("明天上午十点联系王总，确认项目进展。");
    expect(deviceReminderBody("交周报", "")).toBe("");
  });

  it("日期那行：今天/昨天直说，更早的写日期并标出几天前", () => {
    const now = Date.parse("2026-10-01T11:30:00Z");               // 北京 10-01 19:30
    expect(deviceReminderWhen("2026-10-01T02:00:00Z", now)).toBe("今天 10:00");
    expect(deviceReminderWhen("2026-09-30T02:00:00Z", now)).toBe("昨天 10:00");
    expect(deviceReminderWhen("2026-09-26T02:00:00Z", now)).toBe("9月26日 10:00（5 天前）");
    // 北京时间跨零点：UTC 还是 30 号，北京已经是 1 号凌晨
    expect(deviceReminderWhen("2026-09-30T16:30:00Z", Date.parse("2026-09-30T17:00:00Z"))).toBe("今天 00:30");
  });
});

describe("积压的旧提醒", () => {
  it("默认一直弹直到确认；设了 3 天后不再弹，5 天前那条就不推了，昨天的照推", async () => {
    const { repository, settings, reminders } = setup();
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    const make = (title: string, daysAgo: number) => repository.createReminder({ id: randomUUID(), userId: "owner",
      draftId: null, title, body: "", remindAt: at(daysAgo), status: "sent", sentAt: at(daysAgo), ackedAt: null,
      createdAt: at(daysAgo + 1) });
    await make("五天前的", 5);
    await make("昨天的", 1);
    expect((await reminders.activeFor("owner"))?.title).toBe("五天前的");      // 默认：最早那条先弹

    const s = await settings.get("owner");
    await settings.save({ ...s, prefs: { ...s.prefs, reminders: { ...s.prefs.reminders, expireDays: 3 } } });
    expect((await reminders.activeFor("owner"))?.title).toBe("昨天的");
  });
});

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AutomationExecutor } from "../src/connectors/automation.js";
import type { ToolExecutor } from "../src/connectors/types.js";
import type { ActionDraft, Automation } from "../src/domain.js";
import { ActionService } from "../src/services/actions.js";
import { AutomationService, nextRun, scheduleLabel } from "../src/services/automations.js";
import { ExecutionService } from "../src/services/execution.js";
import { SettingsService } from "../src/services/settings.js";
import { MemoryRepository } from "../src/store/memory.js";

/* 自动化：到点自己做一件事。
 * 盯的是三件容易错的事：北京时间的下一次什么时候、跑完要把下一次推到将来（否则每分钟重跑），
 * 以及说出来的「每天…」建的是规则而不是一次性任务。*/

const bj = (iso: string) => Date.parse(`${iso}:00.000+08:00`);

function setup() {
  const repository = new MemoryRepository();
  const done: ActionDraft[] = [];
  const executor: ToolExecutor = { async execute(draft) { done.push(draft); return { provider: "test", externalId: "x", result: {} }; } };
  const actions = new ActionService(repository);
  const service = new AutomationService({ repository, actions,
    executions: new ExecutionService(repository, executor), settings: new SettingsService(repository, "high") });
  return { repository, service, done };
}

describe("自动化的下一次时间", () => {
  it("每天：过了今天的点就排到明天，按北京时间算", () => {
    const s = { kind: "daily" as const, time: "08:00" };
    expect(nextRun(s, bj("2026-09-20T07:30"))).toBe(bj("2026-09-20T08:00"));
    expect(nextRun(s, bj("2026-09-20T08:30"))).toBe(bj("2026-09-21T08:00"));
  });
  it("每周和每月；2 月没有 30 号就跳过那个月", () => {
    // 2026-09-20 是周日
    expect(nextRun({ kind: "weekly", time: "09:00", weekday: 3 }, bj("2026-09-20T10:00"))).toBe(bj("2026-09-23T09:00"));
    expect(nextRun({ kind: "monthly", time: "09:00", day: 30 }, bj("2026-01-31T10:00"))).toBe(bj("2026-03-30T09:00"));
  });
  it("一次性：过了就没有下一次", () => {
    const s = { kind: "once" as const, time: "09:00", date: "2026-09-21" };
    expect(nextRun(s, bj("2026-09-20T10:00"))).toBe(bj("2026-09-21T09:00"));
    expect(nextRun(s, bj("2026-09-22T10:00"))).toBeNull();
  });
  it("说人话的描述", () => {
    expect(scheduleLabel({ kind: "daily", time: "08:00" })).toBe("每天 08:00");
    expect(scheduleLabel({ kind: "weekly", time: "09:00", weekday: 1 })).toBe("每周一 09:00");
  });
});

describe("到点执行", () => {
  it("到点直接做，不再弹卡片；跑完把下一次推到明天，不会每分钟重跑", async () => {
    const { repository, service, done } = setup();
    const created = await service.create({ userId: "owner", title: "提醒量体重",
      schedule: { kind: "daily", time: "08:00" },
      action: { kind: "tool", tool: "feishu.task.create", args: { summary: "量体重", description: "" } } });
    expect(created.nextRunAt).toBe(new Date(nextRun({ kind: "daily", time: "08:00" })!).toISOString());

    // 还没到点：不跑
    expect(await service.tick(bj("2026-09-20T07:00"))).toBe(0);

    await repository.updateAutomation(created.id, { nextRunAt: new Date(bj("2026-09-20T08:00")).toISOString() });
    expect(await service.tick(bj("2026-09-20T08:00"))).toBe(1);
    expect(done.map((d) => [d.tool, d.title, d.status])).toEqual([["feishu.task.create", "提醒量体重", "executing"]]);
    const after = (await repository.getAutomation(created.id))!;
    expect(after.nextRunAt).toBe(new Date(bj("2026-09-21T08:00")).toISOString());
    expect(after.lastStatus).toBe("已执行");

    // 同一分钟再来一次：已经排到明天了，不会重复执行
    expect(await service.tick(bj("2026-09-20T08:00"))).toBe(0);
    expect(done).toHaveLength(1);
  });

  it("执行失败也要把下一次推走，并把原因记下来", async () => {
    const repository = new MemoryRepository();
    const actions = new ActionService(repository);
    const boom: ToolExecutor = { async execute() { throw new Error("飞书没授权"); } };
    const service = new AutomationService({ repository, actions,
      executions: new ExecutionService(repository, boom), settings: new SettingsService(repository, "high") });
    const a = await service.create({ userId: "owner", title: "每天发周报",
      schedule: { kind: "daily", time: "09:00" },
      action: { kind: "tool", tool: "feishu.task.create", args: { summary: "周报" } } });
    await repository.updateAutomation(a.id, { nextRunAt: new Date(bj("2026-09-20T09:00")).toISOString() });
    expect(await service.tick(bj("2026-09-20T09:00"))).toBe(0);
    const after = (await repository.getAutomation(a.id))!;
    expect(after.lastStatus).toContain("飞书没授权");
    expect(after.nextRunAt).toBe(new Date(bj("2026-09-21T09:00")).toISOString());
  });

  it("一次性的跑完就自动停用", async () => {
    const { repository, service } = setup();
    const a = await service.create({ userId: "owner", title: "周一提醒开会",
      schedule: { kind: "once", time: "09:00", date: "2099-09-21" },
      action: { kind: "tool", tool: "note.create", args: { title: "开会", content: "" } } });
    await repository.updateAutomation(a.id, { nextRunAt: new Date(bj("2099-09-21T09:00")).toISOString() });
    await service.tick(bj("2099-09-21T09:00"));
    expect((await repository.getAutomation(a.id))!.enabled).toBe(false);
  });
});

describe("说出来的定时规则", () => {
  function draft(tool: string, args: Record<string, unknown>): ActionDraft {
    const now = new Date().toISOString();
    return { id: randomUUID(), sessionId: randomUUID(), userId: "owner", tool, title: "定时规则", detail: "", args,
      evidence: "每天早上八点提醒我量体重", evidenceStartMs: null, evidenceEndMs: null, confidence: 1, mode: "explicit",
      risk: "personal_write", status: "confirmed", revision: 1, idempotencyKey: randomUUID(), createdAt: now, updatedAt: now };
  }

  it("「每天早上八点提醒我量体重」建的是规则，不是一次性任务", async () => {
    const { repository, service } = setup();
    const executor = new AutomationExecutor(service);
    const receipt = await executor.execute(draft("automation.create",
      { title: "提醒量体重", repeat: "daily", time: "8:00", kind: "task", text: "量体重" }));
    const [saved] = await repository.listAutomations("owner");
    expect(saved).toMatchObject({ title: "提醒量体重", enabled: true, source: "voice",
      schedule: { kind: "daily", time: "08:00" }, action: { kind: "tool", tool: "feishu.task.create" } });
    expect((receipt.result as { when: string }).when).toBe("每天 08:00");
  });

  it("「不用每天量体重了」把规则停掉，但留着可以再打开", async () => {
    const { repository, service } = setup();
    const executor = new AutomationExecutor(service);
    await executor.execute(draft("automation.create", { title: "提醒量体重", repeat: "daily", time: "08:00", kind: "task", text: "量体重" }));
    await executor.execute(draft("automation.cancel", { title: "量体重" }));
    const [saved] = await repository.listAutomations("owner") as Automation[];
    expect(saved!.enabled).toBe(false);
    await expect(executor.execute(draft("automation.cancel", { title: "喝水" }))).rejects.toThrow("没找到");
  });

  it("要发消息却没说发给谁：当场拒绝，不建一条到点必然失败的规则", async () => {
    const { service } = setup();
    const executor = new AutomationExecutor(service);
    await expect(executor.execute(draft("automation.create",
      { title: "每天问候", repeat: "daily", time: "08:00", kind: "message", text: "早" }))).rejects.toThrow("没说发给谁");
  });
});

import { describe, expect, it } from "vitest";
import { beijingLabel, isGenericTitle, normalizeActionArgs, parseBeijing } from "../src/intent/time.js";

/* 实测踩过：让模型直接写 Unix 毫秒，"明天上午10点"被写成 2024、2025 年的日期。
 * 现在模型写北京时间字符串，这里换算并把关。*/

const RECORDED = "2026-09-19T09:23:00.000Z";            // 北京时间 2026-09-19 周六 17:23

describe("动作时间", () => {
  it("给模型看的是北京时间和星期", () => {
    expect(beijingLabel(RECORDED)).toBe("2026-09-19 周六 17:23");
  });

  it("明天上午 10 点换算成正确的时间戳", () => {
    const { args } = normalizeActionArgs("feishu.task.create", { summary: "去福田菜市场买菜", due: "2026-09-20 10:00" }, RECORDED);
    expect(args.dueTimestampMs).toBe(Date.parse("2026-09-20T02:00:00.000Z"));
    expect(args.allDay).toBe(false);
  });

  it("只说了哪天：补成当天 21:00，不再留成全天（全天没法到点提醒）", () => {
    const { args } = normalizeActionArgs("feishu.task.create", { summary: "交周报", due: "2026-09-23" }, RECORDED);
    expect(args.allDay).toBe(false);
    expect(args.dueTimestampMs).toBe(Date.parse("2026-09-23T13:00:00.000Z"));   // 北京时间 21:00
  });

  it("模型自己算的时间戳不信；离谱的日期丢掉并说明", () => {
    const bad = normalizeActionArgs("feishu.task.create", { summary: "买菜", dueTimestampMs: 1726736400000, due: "2024-09-19 17:00" }, RECORDED);
    expect(bad.args.dueTimestampMs).toBeUndefined();
    expect(bad.notes.join()).toContain("没听清");
    expect(parseBeijing("2026-02-30")).toBeNull();
  });

  it("日程：没说结束时间就默认一小时", () => {
    const { args } = normalizeActionArgs("feishu.calendar.create", { summary: "评审会", start: "2026-09-23 15:00" }, RECORDED);
    expect(args.endTimestamp as number - (args.startTimestamp as number)).toBe(3600);
    expect(args.timezone).toBe("Asia/Shanghai");
  });

  it("操作名不算标题", () => {
    expect(isGenericTitle("创建飞书任务")).toBe(true);
    expect(isGenericTitle("帮我建个任务")).toBe(true);
    expect(isGenericTitle("创建任务")).toBe(true);
    expect(isGenericTitle("明天10点去福田菜市场买菜")).toBe(false);
  });
});

describe("没说几点就按规矩补", () => {
  it("上午 12:00、下午 18:00、晚上和没提都是 21:00", async () => {
    const { normalizeActionArgs } = await import("../src/intent/time.js");
    const at = "2026-09-20T02:00:00.000Z";                    // 北京时间 9/20 10:00
    const due = (args: Record<string, unknown>) =>
      new Date(Number(normalizeActionArgs("feishu.task.create", { summary: "x", ...args }, at).args.dueTimestampMs)
        + 8 * 3600_000).toISOString().slice(0, 16);
    expect(due({ due: "2026-09-21", duePart: "morning" })).toBe("2026-09-21T12:00");
    expect(due({ due: "2026-09-21", duePart: "afternoon" })).toBe("2026-09-21T18:00");
    expect(due({ due: "2026-09-21", duePart: "evening" })).toBe("2026-09-21T21:00");
    expect(due({ due: "2026-09-21" })).toBe("2026-09-21T21:00");
    // 后天同理
    expect(due({ due: "2026-09-22", duePart: "上午" })).toBe("2026-09-22T12:00");
  });

  it("说了具体几点就用那个点，不补", async () => {
    const { normalizeActionArgs } = await import("../src/intent/time.js");
    const r = normalizeActionArgs("feishu.task.create", { summary: "x", due: "2026-09-21 09:30" }, "2026-09-20T02:00:00.000Z");
    expect(new Date(Number(r.args.dueTimestampMs) + 8 * 3600_000).toISOString().slice(0, 16)).toBe("2026-09-21T09:30");
    expect(r.notes.join()).not.toContain("没说几点");
    // 补过时间的一律不是"全天"，否则到点提醒无从谈起
    expect(r.args.allDay).toBe(false);
  });
});

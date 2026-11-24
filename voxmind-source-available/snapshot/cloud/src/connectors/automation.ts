import { z } from "zod";
import type { ActionDraft } from "../domain.js";
import type { AutomationService } from "../services/automations.js";
import { scheduleLabel } from "../services/automations.js";
import type { ToolExecutor, ToolReceipt } from "./types.js";

/* 说出来的定时规则。
 *
 * 「明天十点提醒我」是一次性的事，走飞书任务；「每天早上八点提醒我量体重」是一条规则，
 * 走这里——建一条自动化，以后每天到点自己做。取消也一样：说「不用每天提醒我喝水了」
 * 会把那条规则停掉（停掉而不是删掉，想恢复时在网页上一点就回来）。*/

const CreateArgs = z.object({
  title: z.string().trim().min(1).max(80),
  repeat: z.enum(["daily", "weekly", "monthly", "once"]).default("daily"),
  time: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/),
  weekday: z.coerce.number().int().min(0).max(6).optional(),
  day: z.coerce.number().int().min(1).max(31).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  kind: z.enum(["task", "note", "message", "daily_summary"]).default("task"),
  text: z.string().max(2000).default(""),
  receiveId: z.string().max(200).optional(),
  receiveIdType: z.enum(["chat_id", "open_id", "user_id", "email"]).optional(),
});

const CancelArgs = z.object({ title: z.string().trim().min(1).max(80) });

export class AutomationExecutor implements ToolExecutor {
  constructor(private readonly automations: AutomationService) {}

  async execute(draft: ActionDraft): Promise<ToolReceipt> {
    if (draft.tool === "automation.create") {
      const a = CreateArgs.parse(draft.args);
      const [h, m] = a.time.split(":");
      const time = `${h!.padStart(2, "0")}:${m}`;
      const schedule = { kind: a.repeat, time,
        ...(a.repeat === "weekly" ? { weekday: a.weekday ?? 1 } : {}),
        ...(a.repeat === "monthly" ? { day: a.day ?? 1 } : {}),
        ...(a.repeat === "once" && a.date ? { date: a.date } : {}) };
      const body = a.text || a.title;
      const action = a.kind === "daily_summary"
        ? { kind: "daily_summary" as const, tool: "", args: a.receiveId ? { receiveId: a.receiveId, receiveIdType: a.receiveIdType ?? "open_id" } : {} }
        : a.kind === "note"
          ? { kind: "tool" as const, tool: "note.create", args: { title: a.title, content: body } }
          : a.kind === "message"
            ? { kind: "tool" as const, tool: "feishu.message.send",
                args: { receiveId: a.receiveId ?? "", receiveIdType: a.receiveIdType ?? "open_id", text: body } }
            : { kind: "tool" as const, tool: "feishu.task.create", args: { summary: body, description: "" } };
      if (action.kind === "tool" && action.tool === "feishu.message.send" && !action.args.receiveId) {
        throw new Error("没说发给谁，先在网页的「自动化」里补上收件人");
      }
      const created = await this.automations.create({ userId: draft.userId, title: a.title, schedule, action, source: "voice" });
      return { provider: "voxmind", externalId: created.id,
        result: { id: created.id, title: created.title, when: scheduleLabel(created.schedule), nextRunAt: created.nextRunAt } };
    }

    if (draft.tool === "automation.cancel") {
      const { title } = CancelArgs.parse(draft.args);
      const found = await this.automations.findByTitle(draft.userId, title);
      if (!found) throw new Error(`没找到叫「${title}」的定时规则`);
      await this.automations.update(found.id, { enabled: false });
      return { provider: "voxmind", externalId: found.id, result: { id: found.id, title: found.title, enabled: false } };
    }

    throw new Error(`不是自动化工具：${draft.tool}`);
  }
}

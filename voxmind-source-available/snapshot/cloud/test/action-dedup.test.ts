import { describe, expect, it } from "vitest";
import { ActionService } from "../src/services/actions.js";
import { MemoryRepository } from "../src/store/memory.js";

/* 2026-10-25 实测的真问题：前一张卡因为飞书授权过期执行失败，用户一字不差地重说一遍，
 * 指纹撞上那张失败的卡，于是什么都不发生——没有新卡片、没有重试、没有日志。
 * 当时用户看到的就是屏上「处理中」挂满 90 秒，然后再也没有下文。*/
describe("同一句话再说一遍", () => {
  const common = { userId: "owner", tool: "feishu.task.create", title: "完成客户的项目管理系统",
    args: { summary: "完成客户的项目管理系统", description: "" }, evidence: "帮我创建一个飞书任务，就是完成客户的项目管理系统。",
    confidence: 1, mode: "explicit" as const, risk: "personal_write" as const };

  it("隔了一会儿重说：出一张新卡片，不被上一张失败的卡吃掉", async () => {
    const repository = new MemoryRepository();
    const actions = new ActionService(repository);
    const sessionId = "11111111-1111-4111-8111-111111111111";

    const first = await actions.createDraft({ ...common, sessionId, evidenceStartMs: 387128, evidenceEndMs: 400032 });
    await repository.updateDraft(first.id, { status: "failed" });

    // 28 分钟后一字不差地又说了一遍：录音里的位置不同，就是新的一次
    const again = await actions.createDraft({ ...common, sessionId, evidenceStartMs: 2034150, evidenceEndMs: 2055206 });
    expect(again.id).not.toBe(first.id);
    expect(again.status).not.toBe("failed");
  });

  it("同一段被管道重复投递：还是只出一张卡", async () => {
    const repository = new MemoryRepository();
    const actions = new ActionService(repository);
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const once = { ...common, sessionId, evidenceStartMs: 2034150, evidenceEndMs: 2055206 };

    const a = await actions.createDraft(once);
    const b = await actions.createDraft(once);
    expect(b.id).toBe(a.id);
    expect(await repository.listDrafts("owner")).toHaveLength(1);
  });
});

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { FeishuUserExecutor } from "../src/connectors/feishu-user.js";
import { NeedsChoiceError } from "../src/connectors/types.js";
import { ActionService } from "../src/services/actions.js";
import { ExecutionService } from "../src/services/execution.js";
import type { ActionDraft } from "../src/domain.js";
import { SecretBox } from "../src/security/secrets.js";
import { MemoryRepository } from "../src/store/memory.js";

/* 用用户授权建飞书任务。这里盯的是那条实测教训：不带负责人时飞书照样返回成功，
 * 但任务不在任何人的「我负责的」里，用户根本看不到。*/

function draftOf(args: Record<string, unknown>): ActionDraft {
  const now = new Date().toISOString();
  return { id: randomUUID(), sessionId: randomUUID(), userId: "owner", tool: "feishu.task.create", title: "给张总回电话",
    detail: "", args, evidence: "明天十点给张总回电话", evidenceStartMs: null, evidenceEndMs: null, confidence: 1,
    mode: "explicit", risk: "personal_write", status: "confirmed", revision: 1, idempotencyKey: "action:stable-key",
    createdAt: now, updatedAt: now };
}

describe("飞书任务（用户授权）", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  it("把授权本人设成负责人，open_id 只查一次并缓存下来", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => raw += c);
      req.on("end", () => {
        seen.push({ url: req.url!, body: raw ? JSON.parse(raw) as Record<string, unknown> : {} });
        res.setHeader("content-type", "application/json");
        if (req.url!.includes("/authen/v1/user_info")) res.end(JSON.stringify({ code: 0, data: { open_id: "ou_me", name: "我" } }));
        else res.end(JSON.stringify({ code: 0, data: { task: { guid: "guid-1" } } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
    close = () => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));

    const repository = new MemoryRepository();
    const secrets = new SecretBox("0".repeat(64));
    await repository.upsertIntegration("owner", "feishu", secrets.encrypt({ appId: "cli_x", appSecret: "s",
      accessToken: "u-token", accessExpiresAt: Math.floor(Date.now() / 1000) + 3600 }));
    const executor = new FeishuUserExecutor(repository, secrets, `http://127.0.0.1:${address.port}`);

    const receipt = await executor.execute(draftOf({ summary: "给张总回电话", description: "", dueTimestampMs: "1799740800000" }));
    expect(receipt).toMatchObject({ provider: "feishu-user", externalId: "guid-1" });
    const created = seen.find((r) => r.url.startsWith("/open-apis/task/v2/tasks"))!;
    expect(created.body).toMatchObject({ summary: "给张总回电话", members: [{ id: "ou_me", type: "user", role: "assignee" }],
      due: { timestamp: "1799740800000", is_all_day: false } });

    // 第二条任务：open_id 已经存进授权信息里，不再多问飞书一次
    await executor.execute(draftOf({ summary: "另一件事", description: "" }));
    expect(seen.filter((r) => r.url.includes("/authen/v1/user_info"))).toHaveLength(1);
  });

  /* 2026-10-08 实测：「发消息给灰太狼」把名字原样当 receive_id 发，参数校验直接失败。
   * 灰太狼是外部联系人的备注，通讯录搜不到；他在自动命名的群「尼奥, 灰, 灰太狼」里，
   * 尼奥（备注，真名甘念麟）和灰都能搜到，剩下那个成员就是他 */
  it("发消息：名字换成 open_id，外部联系人靠自动命名的群排除出来", async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => raw += c);
      req.on("end", () => {
        const url = decodeURIComponent(req.url!);
        res.setHeader("content-type", "application/json");
        const ok = (data: unknown) => res.end(JSON.stringify({ code: 0, data }));
        if (url.includes("/search/v1/user?query=灰太狼")) return ok({ users: [] });
        if (url.includes("/search/v1/user?query=尼奥")) return ok({ users: [{ name: "甘念麟", open_id: "ou_me" }] });
        if (url.includes("/search/v1/user?query=灰&")) return ok({ users: [{ name: "灰", open_id: "ou_hui" }] });
        if (url.includes("/search/v1/user?query=张三")) return ok({ users: [{ name: "张三", open_id: "ou_zs" }, { name: "张三丰", open_id: "ou_zsf" }] });
        if (url.includes("/search/v1/user")) return ok({ users: [] });
        if (url.includes("/im/v1/chats?page_size")) return ok({ has_more: false, items: [
          { name: "ai自动化", chat_id: "oc_ai" }, { name: "自动化周报", chat_id: "oc_zb" }, { name: "产品讨论", chat_id: "oc_cp" }] });
        if (url.includes("/im/v1/chats/search?query=AI自动化&")) return ok({ items: [{ name: "ai自动化", chat_id: "oc_ai" }] });
        if (url.includes("/im/v1/chats/search?query=外狼")) return ok({ items: [{ name: "尼奥, 灰, 外狼", chat_id: "oc_x" }] });
        if (url.includes("/search/v1/user?query=外狼")) return ok({ users: [] });
        if (url.includes("/im/v1/chats/search")) return ok({ items: [{ name: "尼奥, 灰, 灰太狼", chat_id: "oc_g" }] });
        if (url.includes("/im/v1/chats/oc_g/members")) return ok({ items: [
          { member_id: "ou_hui", name: "灰", tenant_key: "t_me" }, { member_id: "ou_wolf", name: "灰灰灰", tenant_key: "t_me" },
          { member_id: "ou_me", name: "甘念麟", tenant_key: "t_me" }] });
        if (url.includes("/im/v1/chats/oc_x/members")) return ok({ items: [
          { member_id: "ou_hui", name: "灰", tenant_key: "t_me" }, { member_id: "ou_ext", name: "灰灰灰", tenant_key: "t_other" },
          { member_id: "ou_me", name: "甘念麟", tenant_key: "t_me" }] });
        sent.push({ url, body: JSON.parse(raw) as Record<string, unknown> });
        ok({ message_id: "om_1" });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
    close = () => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    const repository = new MemoryRepository();
    const secrets = new SecretBox("0".repeat(64));
    await repository.upsertIntegration("owner", "feishu", secrets.encrypt({ appId: "cli_x", appSecret: "s",
      accessToken: "u-token", accessExpiresAt: Math.floor(Date.now() / 1000) + 3600 }));
    const executor = new FeishuUserExecutor(repository, secrets, `http://127.0.0.1:${address.port}`);
    const msg = (receiveId: string, receiveIdType = "name") =>
      ({ ...draftOf({ receiveId, receiveIdType, text: "测试消息" }), tool: "feishu.message.send" as const });

    await executor.execute(msg("灰太狼"));
    expect(sent[0]).toMatchObject({ url: expect.stringContaining("receive_id_type=open_id"), body: { receive_id: "ou_wolf" } });
    await executor.execute(msg("张三"));          // 只认完全同名：张三丰不算
    expect(sent[1]!.body).toMatchObject({ receive_id: "ou_zs" });
    await expect(executor.execute(msg("李四"))).rejects.toThrow(/没找到「李四」/);
    expect(sent).toHaveLength(2);
    await executor.execute(msg("AI自动化的这个群"));   // 带"的这个群"、大小写不同也认得
    expect(sent[2]).toMatchObject({ url: expect.stringContaining("receive_id_type=chat_id"), body: { receive_id: "oc_ai" } });
    sent.splice(2, 1);
    await executor.execute(msg("外狼"));          // 外部联系人：飞书不许私聊，发到群里
    expect(sent[2]).toMatchObject({ url: expect.stringContaining("receive_id_type=chat_id"), body: { receive_id: "oc_x" } });
    await executor.execute(msg("AI自动画群"));      // 语音识别成同音字：按读音也认得
    expect(sent[3]!.body).toMatchObject({ receive_id: "oc_ai" });
    // 「自动化」对得上两个群：不替人挑，交回候选
    const choice = await executor.execute(msg("自动化群")).catch((e: unknown) => e);
    expect(choice).toBeInstanceOf(NeedsChoiceError);
    expect((choice as NeedsChoiceError).options.map((o) => o.args.receiveId).sort()).toEqual(["oc_ai", "oc_zb"]);
    expect(sent).toHaveLength(4);
  });

  it("有几个候选：拆成几张待确认卡片，确认一张其余作废", async () => {
    const repository = new MemoryRepository();
    const options = [{ label: "群「ai自动化」", args: { receiveId: "oc_ai", receiveIdType: "chat_id" } },
                     { label: "群「自动化周报」", args: { receiveId: "oc_zb", receiveIdType: "chat_id" } }];
    let calls = 0;
    const executor = { execute: async (d: ActionDraft) => {
      calls++;
      if (d.args.receiveIdType === "name") throw new NeedsChoiceError("「自动化」对得上 2 个，请选一个", options);
      return { provider: "test", externalId: "om", result: {} };
    } };
    const draft = await repository.createDraft({ ...draftOf({ receiveId: "自动化", receiveIdType: "name", text: "开会" }),
      tool: "feishu.message.send", userId: "owner" });
    await new ExecutionService(repository, executor).execute(draft);
    expect((await repository.getDraft(draft.id))!.status).toBe("cancelled");
    const pending = await repository.listDrafts("owner", "pending");
    expect(pending.map((d) => d.title).sort()).toEqual(["群「ai自动化」：开会", "群「自动化周报」：开会"]);
    const actions = new ActionService(repository);
    const pick = pending.find((d) => d.args.receiveId === "oc_zb")!;
    await actions.confirm(pick.id);
    expect(await repository.listDrafts("owner", "pending")).toHaveLength(0);
    expect((await repository.getDraft(pick.id))!.status).toBe("confirmed");
  });

  /* 2026-10-24 的真事：10-10 授权，刷新令牌 7 天后（10-17）到期，期间一条飞书任务都没发过，
   * 到 10-24 说的两件事全部失败。续期不能等"要用的时候再刷"，必须有后台巡检。*/
  it("后台续期：剩不到 3 天就提前换令牌，已过期则只能重新授权", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => raw += c);
      req.on("end", () => {
        seen.push(req.url!);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ code: 0, access_token: "u-new", refresh_token: "r-new",
          expires_in: 7200, refresh_token_expires_in: 604800 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
    close = () => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));

    const secrets = new SecretBox("0".repeat(64));
    const now = Math.floor(Date.now() / 1000);
    const bind = async (repository: MemoryRepository, refreshExpiresAt: number) =>
      repository.upsertIntegration("owner", "feishu", secrets.encrypt({ appId: "cli_x", appSecret: "s",
        accessToken: "u-token", accessExpiresAt: now + 3600, refreshToken: "r-old", refreshExpiresAt }));
    const executorFor = (repository: MemoryRepository) =>
      new FeishuUserExecutor(repository, secrets, `http://127.0.0.1:${address.port}`);

    // 还剩 6 天：不动。每刷一次旧令牌立刻作废，没必要的刷新本身就是风险
    const healthy = new MemoryRepository();
    await bind(healthy, now + 6 * 24 * 3600);
    expect(await executorFor(healthy).keepAlive()).toMatchObject({ state: "ok" });
    expect(seen).toHaveLength(0);

    // 只剩 2 天：访问令牌还好着也要提前换，换完重新给满 7 天
    const stale = new MemoryRepository();
    await bind(stale, now + 2 * 24 * 3600);
    const renewed = await executorFor(stale).keepAlive();
    expect(renewed).toMatchObject({ state: "renewed" });
    expect(renewed!.refreshExpiresAt).toBeGreaterThan(now + 6 * 24 * 3600);
    expect(seen).toHaveLength(1);
    expect(secrets.decrypt<{ refreshToken: string }>((await stale.getIntegration("owner", "feishu"))!.encryptedConfig)
      .refreshToken).toBe("r-new");

    // 已经过期：续不回来，报出来让人去重新授权，而不是悄悄吞掉
    const dead = new MemoryRepository();
    await bind(dead, now - 60);
    expect(await executorFor(dead).keepAlive()).toMatchObject({ state: "expired" });
    expect(seen).toHaveLength(1);

    // 从没授权过：没什么要续的，也不该报错
    expect(await executorFor(new MemoryRepository()).keepAlive()).toBeNull();
  });
});

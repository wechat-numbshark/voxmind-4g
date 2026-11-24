import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { FeishuOpenApiExecutor } from "../src/connectors/feishu-openapi.js";
import type { ActionDraft } from "../src/domain.js";

describe("FeishuOpenApiExecutor", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it("creates an assigned task with a stable client token", async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => raw += chunk);
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
        requests.push({ url: req.url!, body });
        res.setHeader("content-type", "application/json");
        if (req.url!.includes("tenant_access_token")) res.end(JSON.stringify({ code: 0, tenant_access_token: "token", expire: 7200 }));
        else res.end(JSON.stringify({ code: 0, data: { task: { guid: "task-guid", url: "https://example.test/task" } } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器启动失败");
    close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

    const now = new Date().toISOString();
    const draft: ActionDraft = { id: randomUUID(), sessionId: randomUUID(), userId: "owner", tool: "feishu.task.create", title: "创建测试任务", detail: "", args: { summary: "创建测试任务", description: "来自 VoxMind", dueTimestampMs: "1799740800000" }, evidence: "直接创建测试任务", evidenceStartMs: null, evidenceEndMs: null, confidence: 1, mode: "explicit", risk: "personal_write", status: "confirmed", revision: 1, idempotencyKey: "action:stable-key", createdAt: now, updatedAt: now };
    const executor = new FeishuOpenApiExecutor("app", "secret", "ou_owner", `http://127.0.0.1:${address.port}`);
    const receipt = await executor.execute(draft);

    expect(receipt).toMatchObject({ provider: "feishu", externalId: "task-guid" });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ url: "/open-apis/task/v2/tasks?user_id_type=open_id", body: { summary: "创建测试任务", members: [{ id: "ou_owner", type: "user", role: "assignee" }], due: { timestamp: "1799740800000", is_all_day: false } } });
    expect(String(requests[1]!.body.client_token)).toHaveLength(50);
  });
});


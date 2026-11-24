import { createHash } from "node:crypto";
import { z } from "zod";
import type { ActionDraft } from "../domain.js";
import type { ToolExecutor, ToolReceipt } from "./types.js";

const TaskArgs = z.object({
  summary: z.string().min(1).max(300),
  description: z.string().max(3000).default(""),
  dueTimestampMs: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).optional(),
  allDay: z.boolean().default(false),
  assigneeOpenId: z.string().regex(/^ou_/).optional(),
});

interface Token { value: string; expiresAt: number }

export class FeishuOpenApiExecutor implements ToolExecutor {
  private token: Token | null = null;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly ownerOpenId = "",
    private readonly baseUrl = "https://open.feishu.cn",
  ) {}

  async execute(draft: ActionDraft): Promise<ToolReceipt> {
    if (draft.tool !== "feishu.task.create") throw new Error(`尚未支持的飞书工具：${draft.tool}`);
    return this.createTask(draft);
  }

  private async createTask(draft: ActionDraft): Promise<ToolReceipt> {
    const args = TaskArgs.parse(draft.args);
    const assignee = args.assigneeOpenId || this.ownerOpenId;
    const body: Record<string, unknown> = {
      summary: args.summary,
      description: args.description,
      client_token: createHash("sha256").update(draft.idempotencyKey).digest("hex").slice(0, 50),
      ...(args.dueTimestampMs ? { due: { timestamp: String(args.dueTimestampMs), is_all_day: args.allDay } } : {}),
      ...(assignee ? { members: [{ id: assignee, type: "user", role: "assignee" }] } : {}),
      origin: { platform_i18n_name: { zh_cn: "VoxMind" } },
    };
    const response = await this.request("/open-apis/task/v2/tasks?user_id_type=open_id", body);
    const task = z.object({ guid: z.string(), url: z.string().optional(), summary: z.string().optional() }).passthrough().parse(response.data?.task);
    return { provider: "feishu", externalId: task.guid, result: { guid: task.guid, url: task.url ?? null, summary: task.summary ?? args.summary } };
  }

  private async tenantToken() {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const response = await fetch(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (!response.ok || body.code !== 0 || !body.tenant_access_token) throw new Error(`飞书令牌失败：${body.msg ?? response.status}`);
    this.token = { value: body.tenant_access_token, expiresAt: Date.now() + (body.expire ?? 7200) * 1000 };
    return this.token.value;
  }

  private async request(path: string, data: Record<string, unknown>) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.tenantToken()}`, "content-type": "application/json" },
      body: JSON.stringify(data), signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json() as { code?: number; msg?: string; data?: Record<string, unknown> };
    if (!response.ok || body.code !== 0) throw new Error(`飞书请求失败：${body.msg ?? response.status}`);
    return body;
  }
}


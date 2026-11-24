import { createHash } from "node:crypto";
import { z } from "zod";
import type { ActionDraft } from "../domain.js";
import type { ToolExecutor, ToolReceipt } from "./types.js";

const WebhookArgs = z.object({
  url: z.string().url(), method: z.enum(["POST", "PUT", "PATCH"]).default("POST"),
  headers: z.record(z.string(), z.string()).default({}), body: z.unknown().default({}),
});
const HomeAssistantArgs = z.object({
  domain: z.string().regex(/^[a-z][a-z0-9_]*$/), service: z.string().regex(/^[a-z][a-z0-9_]*$/),
  entityId: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z0-9_]+$/).optional(), data: z.record(z.string(), z.unknown()).default({}),
});

async function responseBody(response: Response) {
  const text = await response.text();
  try { return JSON.parse(text) as unknown; } catch { return text.slice(0, 4000); }
}

export class AllowlistedWebhookExecutor implements ToolExecutor {
  private readonly allowedOrigins: Set<string>;
  constructor(origins: string[], private readonly fetchImpl: typeof fetch = fetch) {
    this.allowedOrigins = new Set(origins.filter(Boolean).map((value) => new URL(value).origin));
  }
  async execute(draft: ActionDraft): Promise<ToolReceipt> {
    const args = WebhookArgs.parse(draft.args); const url = new URL(args.url);
    if (url.protocol !== "https:" || !this.allowedOrigins.has(url.origin)) throw new Error("Webhook 目标不在 HTTPS 白名单中");
    const blocked = new Set(["host", "content-length", "cookie"]);
    const headers = Object.fromEntries(Object.entries(args.headers).filter(([key]) => !blocked.has(key.toLowerCase())));
    const response = await this.fetchImpl(url, { method: args.method, redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { ...headers, "content-type": "application/json", "idempotency-key": draft.idempotencyKey }, body: JSON.stringify(args.body) });
    const result = await responseBody(response);
    if (!response.ok) throw new Error(`Webhook 返回 ${response.status}`);
    return { provider: "webhook", externalId: response.headers.get("x-request-id"), result: { status: response.status, body: result } };
  }
}

export class HomeAssistantExecutor implements ToolExecutor {
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async execute(draft: ActionDraft): Promise<ToolReceipt> {
    if (!this.baseUrl || !this.token) throw new Error("Home Assistant 尚未配置");
    const args = HomeAssistantArgs.parse(draft.args);
    const url = new URL(`/api/services/${encodeURIComponent(args.domain)}/${encodeURIComponent(args.service)}`, this.baseUrl);
    const response = await this.fetchImpl(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...args.data, ...(args.entityId ? { entity_id: args.entityId } : {}) }) });
    const result = await responseBody(response);
    if (!response.ok) throw new Error(`Home Assistant 返回 ${response.status}`);
    return { provider: "home-assistant", externalId: createHash("sha256").update(draft.idempotencyKey).digest("hex").slice(0, 24), result: { status: response.status, body: result } };
  }
}

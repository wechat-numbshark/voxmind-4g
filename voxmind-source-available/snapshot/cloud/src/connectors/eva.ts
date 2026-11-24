import { createHash } from "node:crypto";
import type { ActionDraft } from "../domain.js";
import type { ToolExecutor, ToolReceipt } from "./types.js";

function stableUuid(input: string) {
  const hex = createHash("sha256").update(input).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}
export class EvaExecutor implements ToolExecutor {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly siteId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async execute(draft: ActionDraft): Promise<ToolReceipt> {
    if (!this.baseUrl || !this.apiKey || !this.siteId) throw new Error("EVA 尚未配置");
    const response = await this.fetchImpl(new URL("/v1/actions", this.baseUrl), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: stableUuid(draft.idempotencyKey),
        siteId: this.siteId,
        tool: draft.tool,
        args: draft.args,
        actor: { id: draft.userId, kind: "owner", channel: "voxmind" },
        utterance: draft.evidence || undefined,
        explicit: draft.mode === "explicit",
        upstreamApproval: {
          provider: "voxmind",
          draftId: draft.id,
          confirmedAt: draft.updatedAt,
          channel: "voxmind",
        },
        requestedAt: draft.createdAt,
      }),
    });
    const body = await response.json() as { draft?: { id?: string; status?: string }; needsConfirmation?: boolean; error?: string };
    if (!response.ok) throw new Error(`EVA 返回 ${response.status}: ${body.error ?? "未知错误"}`);
    if (!body.draft?.id) throw new Error("EVA 返回格式不完整");
    if (body.needsConfirmation) throw new Error("EVA 要求额外确认；当前 VoxMind 审批凭据未被接受");
    if (body.draft.status !== "succeeded") throw new Error(`EVA 动作未成功：${body.draft.status ?? "unknown"}`);
    return { provider: "eva", externalId: body.draft.id, result: body as unknown as Record<string, unknown> };
  }
}

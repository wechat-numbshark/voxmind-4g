import { describe, expect, it, vi } from "vitest";
import { AllowlistedWebhookExecutor, HomeAssistantExecutor } from "../src/connectors/http-actions.js";
import type { ActionDraft } from "../src/domain.js";
import { EvaExecutor } from "../src/connectors/eva.js";

function draft(tool: string, args: Record<string, unknown>): ActionDraft {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), sessionId: crypto.randomUUID(), userId: "owner", tool, title: "test", detail: "", args,
    evidence: "", evidenceStartMs: null, evidenceEndMs: null, confidence: 1, mode: "explicit", risk: "external_write",
    status: "confirmed", revision: 1, idempotencyKey: `action:${crypto.randomUUID()}`, createdAt: now, updatedAt: now };
}

describe("HTTP action connectors", () => {
  it("only calls HTTPS webhook origins on the explicit allowlist", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "x-request-id": "req-1" } }));
    const executor = new AllowlistedWebhookExecutor(["https://hooks.example.com/path"], fetchMock as typeof fetch);
    await expect(executor.execute(draft("webhook.call", { url: "http://127.0.0.1/admin", body: {} }))).rejects.toThrow("白名单");
    const result = await executor.execute(draft("webhook.call", { url: "https://hooks.example.com/voxmind", method: "POST", body: { on: true } }));
    expect(result).toMatchObject({ provider: "webhook", externalId: "req-1" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("maps a validated service call to the configured Home Assistant host", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    const executor = new HomeAssistantExecutor("http://homeassistant.local:8123", "token", fetchMock as typeof fetch);
    const result = await executor.execute(draft("homeassistant.service.call", { domain: "light", service: "turn_on", entityId: "light.living_room", data: { brightness_pct: 60 } }));
    expect(result.provider).toBe("home-assistant");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://homeassistant.local:8123/api/services/light/turn_on");
  });

  it("sends confirmed semantic actions to EVA", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ draft: { id: "eva-action-1", status: "succeeded" }, needsConfirmation: false }), { status: 201 }));
    const executor = new EvaExecutor("http://eva-core:8080", "secret", "farm-main", fetchMock as typeof fetch);
    const result = await executor.execute(draft("iot.light.set", { deviceId: "shed-light", on: true }));
    expect(result).toMatchObject({ provider: "eva", externalId: "eva-action-1" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ siteId: "farm-main", tool: "iot.light.set", upstreamApproval: { provider: "voxmind" } });
  });
});

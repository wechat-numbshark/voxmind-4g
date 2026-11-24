import { describe, expect, it } from "vitest";
import { OpenAiCompatibleIntentProvider } from "../src/intent/provider.js";

describe("OpenAI-compatible intent provider", () => {
  it("works with a custom base URL and validates structured actions", async () => {
    let requested = "";
    const provider = new OpenAiCompatibleIntentProvider({ baseUrl: "https://model.example/v1/", apiKey: "secret", model: "custom",
      fetchImpl: (async (url) => {
        requested = String(url);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ actions: [{ tool: "feishu.task.create",
          title: "整理需求", detail: "明天", args: { summary: "整理需求" }, evidence: "帮我创建任务", confidence: 0.98,
          mode: "explicit", risk: "personal_write" }] }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch });
    const actions = await provider.extract("帮我创建任务", "2026-09-12T12:00:00.000Z");
    expect(requested).toBe("https://model.example/v1/chat/completions");
    expect(actions).toMatchObject([{ tool: "feishu.task.create", mode: "explicit", confidence: 0.98 }]);
  });

  it("normalizes minor provider omissions and derives risk in trusted code", async () => {
    const provider = new OpenAiCompatibleIntentProvider({ baseUrl: "https://model.example/v1", apiKey: "secret", model: "custom",
      fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ actions: [{
        tool: "homeassistant.service.call", args: { title: "打开客厅灯", domain: "light", service: "turn_on" },
        confidence: 0.9, mode: "explicit", risk: "record",
      }] }) } }] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch });
    const actions = await provider.extract("把客厅灯打开", "2026-09-12T12:00:00.000Z");
    expect(actions[0]).toMatchObject({ title: "打开客厅灯", evidence: "把客厅灯打开", risk: "physical_control" });
  });

  it("adds configured EVA device aliases and commands to the trusted system prompt", async () => {
    let body: { messages?: { role: string; content: string }[] } = {};
    const provider = new OpenAiCompatibleIntentProvider({
      baseUrl: "https://model.example/v1", apiKey: "secret", model: "custom",
      deviceHints: "空调: deviceId=home-ac-ir, command=cool_25",
      fetchImpl: (async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"actions":[]}' } }] }),
          { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    await provider.extract("把空调调到25度", "2026-10-10T12:00:00.000Z");
    expect(body.messages?.[0]?.content).toContain("deviceId=home-ac-ir");
    expect(body.messages?.[0]?.content).toContain("只能使用这里明确给出的 deviceId 和 command");
    expect(body.messages?.[0]?.content).toContain("必须选择对应 iot.* 或 irrigation.* 工具");
  });
});

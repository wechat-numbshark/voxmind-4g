/* 拆主题、纪要、思维导图、聊天共用的大模型调用。
 *
 * 走 OpenAI 兼容接口（百炼），和意图抽取同一把 Key、同一个档位路由：高质量档用 LLM_MODEL，
 * 经济档用 ECONOMY_LLM_MODEL。每次调用都返回 token 用量，调用方负责记账——
 * 成本看板上看得见这些新功能各花了多少钱。*/

export interface LlmUsage { inputTokens: number; outputTokens: number }

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface ToolSpec { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }

export interface LlmReply { content: string; toolCalls: ToolCall[]; usage: LlmUsage; model: string }

export interface LlmClient {
  readonly enabled: boolean;
  modelFor(tier: "high" | "economy"): string;
  chat(model: string, messages: ChatMessage[], options?: { json?: boolean; tools?: ToolSpec[]; timeoutMs?: number; maxTokens?: number }): Promise<LlmReply>;
}

export class OpenAiCompatibleLlm implements LlmClient {
  readonly enabled = true;
  constructor(private readonly options: { baseUrl: string; apiKey: string; highModel: string; economyModel: string; fetchImpl?: typeof fetch }) {}

  modelFor(tier: "high" | "economy") {
    return tier === "economy" ? this.options.economyModel : this.options.highModel;
  }

  async chat(model: string, messages: ChatMessage[], options: { json?: boolean; tools?: ToolSpec[]; timeoutMs?: number; maxTokens?: number } = {}) {
    const response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model, temperature: 0.2, messages,
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        ...(options.json ? { response_format: { type: "json_object" } } : {}),
        ...(options.tools?.length ? { tools: options.tools } : {}),
      }),
    });
    const body = await response.json() as {
      choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string };
    };
    if (!response.ok) throw new Error(`模型请求失败: ${body.error?.message ?? response.status}`);
    const message = body.choices?.[0]?.message;
    return { content: message?.content ?? "", toolCalls: message?.tool_calls ?? [], model,
      usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 } };
  }
}

export class DisabledLlm implements LlmClient {
  readonly enabled = false;
  modelFor() { return ""; }
  async chat(): Promise<LlmReply> { throw new Error("没有配置大模型"); }
}

/** 模型偶尔会在 JSON 外面包 ```json；剥掉再解析 */
export function parseJson<T = unknown>(text: string): T {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as T;
}

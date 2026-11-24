/**
 * 三级动作分类器 —— v3 需求的核心新增逻辑。
 *
 * 设计要点：
 *  1) LLM 只判 kind + confidence，【分级由代码查表决定】(KIND_TIER)。
 *     模型判飘了也不会把"发消息"当成 A 类直接执行。
 *  2) 系统提示词走 prompt caching（稳定前缀），只有转写是变的。
 *  3) 用结构化输出(zodOutputFormat)，不解析自由文本。
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  ExtractionResult, KIND_TIER, TIER_POLICY, routeByConfidence,
  type ExtractedAction, type ActionTier, type PendingCard,
} from "../types.js";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt.js";

const client = new Anthropic();

/** 意图抽取跑在用户等待路径上（设备只醒 30 秒），质量优先但别浪费。 */
const MODEL = "claude-opus-5";

export interface ClassifyInput {
  transcript: string;
  recordedAt: Date;
  deviceId: string;
  userId: string;
  recordingId: string;
}

export interface ClassifyOutput {
  summary: string;
  cards: PendingCard[];
  /** 置信度太低、只在转写里高亮的那些，不进队列 */
  lowConfidence: ExtractedAction[];
}

export async function classify(input: ClassifyInput): Promise<ClassifyOutput> {
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        // 稳定前缀 → 缓存。变量部分全在下面的 user message 里。
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      { role: "user", content: buildUserMessage(input.transcript, input.recordedAt) },
    ],
    output_config: { format: zodOutputFormat(ExtractionResult) },
  });

  const parsed = response.parsed_output;
  if (!parsed) {
    // 结构化输出失败：不猜，当成"没有可执行动作"处理。
    // 漏一条的代价，远小于从乱解析里编出一个错动作。
    console.warn("[classify] 结构化输出解析失败，按无动作处理", {
      recordingId: input.recordingId,
      stopReason: response.stop_reason,
    });
    return { summary: "", cards: [], lowConfidence: [] };
  }

  const now = Date.now();
  const cards: PendingCard[] = [];
  const lowConfidence: ExtractedAction[] = [];

  for (const action of parsed.actions) {
    const route = routeByConfidence(action.confidence);
    if (route.channels[0] === "none") { lowConfidence.push(action); continue; }

    // ★ 分级查表得到，不采信模型的判断
    const tier: ActionTier = KIND_TIER[action.kind];
    const policy = TIER_POLICY[tier];

    cards.push({
      id: `${input.recordingId}-${cards.length}`,
      deviceId: input.deviceId,
      userId: input.userId,
      action,
      tier,
      status: "pending",
      createdAt: now,
      expiresAt: policy.ttlMs > 0 ? now + policy.ttlMs : null,
      pushedTo: route.channels,
      recordingId: input.recordingId,
    });
  }

  logUsage(input.recordingId, response.usage);
  return { summary: parsed.summary, cards, lowConfidence };
}

function logUsage(id: string, usage: Anthropic.Usage) {
  // cache_read_input_tokens 长期为 0 说明缓存没生效 —— 多半是系统提示词里混进了变量
  console.info("[classify]", id, {
    in: usage.input_tokens,
    out: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  });
}

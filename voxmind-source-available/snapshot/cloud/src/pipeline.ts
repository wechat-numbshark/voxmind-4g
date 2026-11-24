/**
 * 主管线：录音上传 → ASR → 意图抽取 → 双通道推送。
 *
 * ★ 全程有一个硬时限：设备上传完只醒 30 秒（DEVICE_AWAKE_WINDOW_MS）。
 *   超时不是失败，只是降级为"只推飞书"，设备等下个 PSM 周期。
 */
import { classify } from "./intent/classify.js";
import type { DeviceChannel } from "./push/mqtt.js";
import type { FeishuChannel } from "./push/feishu.js";
import type { CardStore } from "./queue/pending.js";
import { routeByConfidence, type PendingCard } from "./types.js";
import type { AsrProvider } from "./asr/index.js";
import { opusToPcm16k } from "./asr/index.js";

export interface PipelineDeps {
  asr: AsrProvider;
  device: DeviceChannel;
  feishu: FeishuChannel;
  store: CardStore;
}

export async function processRecording(
  deps: PipelineDeps,
  input: { opus: Buffer; deviceId: string; userId: string; recordingId: string; recordedAt: Date },
) {
  const t0 = Date.now();
  deps.device.markAwake(input.deviceId);          // 开启 30 秒窗口

  const pcm = await opusToPcm16k(input.opus);
  const asr = await deps.asr.transcribe(pcm);
  const tAsr = Date.now() - t0;

  const { summary, cards, lowConfidence } = await classify({
    transcript: asr.text,
    recordedAt: input.recordedAt,
    deviceId: input.deviceId,
    userId: input.userId,
    recordingId: input.recordingId,
  });
  const tTotal = Date.now() - t0;

  console.info("[pipeline]", input.recordingId,
    `ASR ${tAsr}ms / 总 ${tTotal}ms / 卡片 ${cards.length} 张 / 低置信 ${lowConfidence.length} 条`,
    tTotal > 30_000 ? "⚠ 超出设备唤醒窗口，设备端本次收不到" : "");

  for (const card of cards) {
    await deps.store.put(card);
    await push(deps, card);
  }
  return { summary, transcript: asr.text, cards, lowConfidence, latencyMs: tTotal };
}

async function push(deps: PipelineDeps, card: PendingCard) {
  const route = routeByConfidence(card.action.confidence);
  const actual: PendingCard["pushedTo"] = [];

  if (route.channels.includes("device")) {
    const r = await deps.device.pushCard(card);
    if (r.delivered) actual.push("device");
    else console.info("[push]", card.id, r.reason);
  }
  if (route.channels.includes("feishu")) {
    const mid = await deps.feishu.pushCard(card, route.note);
    if (mid) { actual.push("feishu"); card.feishuMessageId = mid; }
  }
  // 记录【实际推到了哪些通道】—— 撤回时要按这个来，推失败的通道不能去撤
  await deps.store.update(card.id, {
    pushedTo: actual,
    ...(card.feishuMessageId ? { feishuMessageId: card.feishuMessageId } : {}),
  });
}

import { randomUUID } from "node:crypto";
import type { AiOutput, QualityTier } from "../domain.js";
import type { PricingService } from "../services/pricing.js";
import type { Repository } from "../store/repository.js";

/* 分角色转写（谁说了哪句）。
 *
 * 为什么单独做一套：平时的转写是每 5 秒一小段独立识别，快、便宜、能搜，但跨段对不上人——
 * 这一段的"说话人1"和下一段的"说话人1"未必是同一个人。要分角色，必须把一整段音频交给
 * 带说话人分离的文件转写接口做一次。
 *
 * 所以做成"按需"：只有在生成会议纪要时才跑一次，结果存下来，重新生成纪要不再重复付费。
 * 代价是这一段音频会被转写第二次（按秒计费），以及要给出一条 30 分钟有效的临时下载地址。*/

const SUBMIT_PATH = "/api/v1/services/audio/asr/transcription";
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60_000;

export interface SpeakerLine { speaker: string; text: string; startMs: number; endMs: number }

interface DashSentence { text?: unknown; begin_time?: unknown; end_time?: unknown; speaker_id?: unknown }


export class DiarizeService {
  constructor(private readonly deps: {
    repository: Repository; pricing: PricingService;
    apiKey: string; baseUrl?: string | undefined; model?: string | undefined;
    /** 轮询间隔，只为测试留口子；线上就是 3 秒 */
    pollMs?: number | undefined;
    /** 造一条百炼能下载的临时地址；只指向要分析的那一段 */
    clipUrl: (sessionId: string, fromMs: number, toMs: number) => string;
    logger?: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void };
  }) {}

  private get base() { return this.deps.baseUrl ?? "https://dashscope.aliyuncs.com"; }
  private get model() { return this.deps.model ?? "paraformer-v2"; }

  /** 已经分过角色的就直接拿来用，不重复花钱 */
  async cached(targetId: string): Promise<SpeakerLine[] | null> {
    const [saved] = (await this.deps.repository.listOutputs([targetId])).filter((o) => o.kind === "speakers");
    if (!saved) return null;
    try { return JSON.parse(saved.content) as SpeakerLine[]; } catch { return null; }
  }

  /** 跑一次分角色转写并存下来。失败时抛错，调用方决定要不要退回没有角色的纪要。*/
  async run(input: { userId: string; sessionId: string; fromMs: number; toMs: number;
                     targetType: AiOutput["targetType"]; targetId: string; tier: QualityTier }): Promise<SpeakerLine[]> {
    const url = this.deps.clipUrl(input.sessionId, input.fromMs, input.toMs);
    const taskId = await this.submit(url);
    const result = await this.poll(taskId);
    const lines = result
      .map((s): SpeakerLine => ({
        speaker: String(s.speaker_id ?? "0"),
        text: String(s.text ?? "").trim(),
        /* 接口给的时间是相对这一小段音频的，换算回整次录音的时间轴 */
        startMs: input.fromMs + Number(s.begin_time ?? 0),
        endMs: input.fromMs + Number(s.end_time ?? 0),
      }))
      .filter((s) => s.text);

    const audioMs = Math.max(0, input.toMs - input.fromMs);
    await this.deps.repository.recordUsage({ at: new Date().toISOString(), userId: input.userId, sessionId: input.sessionId,
      kind: "asr", feature: "speakers", provider: "dashscope", model: this.model, tier: input.tier,
      audioMs, inputTokens: 0, outputTokens: 0, costYuan: await this.deps.pricing.asrCost(this.model, audioMs) });

    await this.deps.repository.createOutput({ id: randomUUID(), userId: input.userId, targetType: input.targetType,
      targetId: input.targetId, kind: "speakers", template: "", content: JSON.stringify(lines),
      model: this.model, createdAt: new Date().toISOString() });
    this.deps.logger?.info({ targetId: input.targetId, lines: lines.length, speakers: new Set(lines.map((l) => l.speaker)).size },
      "分角色转写完成");
    return lines;
  }

  private async submit(fileUrl: string): Promise<string> {
    const response = await fetch(`${this.base}${SUBMIT_PATH}`, {
      method: "POST", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${this.deps.apiKey}`, "content-type": "application/json",
        "X-DashScope-Async": "enable" },
      body: JSON.stringify({ model: this.model, input: { file_urls: [fileUrl] },
        parameters: { channel_id: [0], diarization_enabled: true, language_hints: ["zh", "en"] } }),
    });
    const payload = await response.json() as { output?: { task_id?: string; task_status?: string }; message?: string };
    const taskId = payload.output?.task_id;
    if (!response.ok || !taskId) throw new Error(`提交分角色转写失败：${payload.message ?? response.status}`);
    return taskId;
  }

  private async poll(taskId: string): Promise<DashSentence[]> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.deps.pollMs ?? POLL_INTERVAL_MS));
      const response = await fetch(`${this.base}/api/v1/tasks/${taskId}`, {
        headers: { authorization: `Bearer ${this.deps.apiKey}` }, signal: AbortSignal.timeout(30_000) });
      const payload = await response.json() as {
        output?: { task_status?: string; message?: string;
          results?: { subtask_status?: string; transcription_url?: string; message?: string }[] } };
      const status = payload.output?.task_status;
      if (status === "FAILED" || status === "CANCELED") {
        throw new Error(`分角色转写没成功：${payload.output?.results?.[0]?.message ?? payload.output?.message ?? status}`);
      }
      if (status !== "SUCCEEDED") continue;
      const transcriptUrl = payload.output?.results?.find((r) => r.transcription_url)?.transcription_url;
      if (!transcriptUrl) throw new Error("分角色转写没返回结果地址");
      const body = await fetch(transcriptUrl, { signal: AbortSignal.timeout(30_000) })
        .then((r) => r.json() as Promise<{ transcripts?: { sentences?: DashSentence[] }[] }>);
      return body.transcripts?.flatMap((t) => t.sentences ?? []) ?? [];
    }
    throw new Error("分角色转写超时（5 分钟）");
  }
}

/** 把分角色结果排成给模型看的文本：每行「说话人A 12:30 内容」 */
export function speakerTranscript(lines: SpeakerLine[], startedAt: string) {
  const names = new Map<string, string>();
  const pad = (n: number) => String(n).padStart(2, "0");
  return lines.map((line) => {
    if (!names.has(line.speaker)) names.set(line.speaker, `说话人${String.fromCharCode(65 + names.size)}`);
    const d = new Date(Date.parse(startedAt) + line.startMs + 8 * 3_600_000);
    return `${names.get(line.speaker)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} ${line.text}`;
  }).join("\n");
}

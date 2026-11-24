import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { pcm16MonoToWav } from "../audio/wav.js";

export interface AsrResult {
  text: string;
  segments: { start: number; end: number; text: string }[];
  durationSec: number;
}

export interface AsrProvider {
  readonly name: string;
  /** 计费用的模型名，和后台单价表里的键一致 */
  readonly model?: string;
  /** hints＝用户自己维护的术语词库（人名、产品名、行业词）。
   *  语音识别靠它把"沃克斯麦"听成"VoxMind"，是准确率最便宜的一档提升。*/
  transcribe(pcm16k: Buffer, hints?: string[]): Promise<AsrResult>;
}

/** 只有文件头、没有一帧声音的 Ogg/Opus：OpusHead、OpusTags 两页，再加一个不带数据的结束页，共 125 字节。
 *  设备在暂停时被碰了一下确认键（不到 0.4 秒算误碰）会新开一段、马上收尾，留下这种空块；
 *  ffmpeg 解它报「End of file」，以前被当成转写失败（2026-10-05 一天 10 条，历史共 11 块）。
 *  判法：按 Ogg 页解析，头两页之后所有页的数据加起来是 0 字节。*/
export function isHeaderOnlyOgg(data: Buffer) {
  if (data.length > 1024) return false;
  let off = 0, page = 0, audioBytes = 0;
  while (off + 27 <= data.length) {
    if (data.toString("latin1", off, off + 4) !== "OggS") return false;
    const segments = data[off + 26]!;
    if (off + 27 + segments > data.length) return false;
    let body = 0;
    for (let i = 0; i < segments; i++) body += data[off + 27 + i]!;
    if (page >= 2) audioBytes += body;
    off += 27 + segments + body;
    page++;
  }
  return page >= 2 && off === data.length && audioBytes === 0;
}

export function opusToPcm16k(opus: Buffer): Promise<Buffer> {
  if (isHeaderOnlyOgg(opus)) return Promise.resolve(Buffer.alloc(0));   // 空块＝没有声音，按静音处理
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1"]);
    const output: Buffer[] = []; const errors: Buffer[] = [];
    ff.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    ff.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    ff.once("error", reject);
    ff.once("close", (code) => code === 0
      ? resolve(Buffer.concat(output))
      : reject(new Error(`ffmpeg 解码失败(${code}): ${Buffer.concat(errors).toString().slice(0, 500)}`)));
    ff.stdin.end(opus);
  });
}

export class MockAsrProvider implements AsrProvider {
  readonly name = "mock";
  async transcribe(pcm16k: Buffer): Promise<AsrResult> {
    return { text: "", segments: [], durationSec: pcm16k.length / 32_000 };
  }
}

export interface AliyunAsrOptions {
  appKey: string;
  accessKeyId: string;
  accessKeySecret: string;
  gateway?: string;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocket;
}

type TokenRecord = { id: string; expiresAt: number };

function percentEncode(value: string) {
  return encodeURIComponent(value).replace(/!/g, "%21").replace(/'/g, "%27").replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\*/g, "%2A");
}

export function signAliyunTokenRequest(accessKeyId: string, accessKeySecret: string, timestamp: string, nonce: string) {
  const params: Record<string, string> = {
    AccessKeyId: accessKeyId, Action: "CreateToken", Format: "JSON", RegionId: "cn-shanghai",
    SignatureMethod: "HMAC-SHA1", SignatureNonce: nonce, SignatureVersion: "1.0", Timestamp: timestamp,
    Version: "2019-02-28",
  };
  const canonical = Object.keys(params).sort().map((key) => `${percentEncode(key)}=${percentEncode(params[key]!)}`).join("&");
  const stringToSign = `GET&${percentEncode("/")}&${percentEncode(canonical)}`;
  const signature = createHmac("sha1", `${accessKeySecret}&`).update(stringToSign).digest("base64");
  return `Signature=${percentEncode(signature)}&${canonical}`;
}

export class AliyunAsrProvider implements AsrProvider {
  readonly name = "aliyun";
  private token: TokenRecord | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketFactory: (url: string) => WebSocket;

  constructor(private readonly options: AliyunAsrOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
  }

  private async accessToken() {
    if (this.token && this.token.expiresAt - Date.now() / 1000 > 300) return this.token.id;
    const query = signAliyunTokenRequest(this.options.accessKeyId, this.options.accessKeySecret, new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), randomUUID());
    const response = await this.fetchImpl(`https://nls-meta.cn-shanghai.aliyuncs.com/?${query}`, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json() as { Token?: { Id?: string; ExpireTime?: number }; Message?: string };
    if (!response.ok || !body.Token?.Id || !body.Token.ExpireTime) throw new Error(`阿里云 ASR Token 获取失败: ${body.Message ?? response.status}`);
    this.token = { id: body.Token.Id, expiresAt: body.Token.ExpireTime };
    return this.token.id;
  }

  async transcribe(pcm16k: Buffer): Promise<AsrResult> {
    const token = await this.accessToken();
    const gateway = this.options.gateway ?? "wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1";
    const ws = this.webSocketFactory(`${gateway}?token=${encodeURIComponent(token)}`);
    const taskId = randomUUID().replace(/-/g, "");
    const message = (name: string, payload: Record<string, unknown> = {}) => JSON.stringify({
      header: { appkey: this.options.appKey, message_id: randomUUID().replace(/-/g, ""), task_id: taskId, namespace: "SpeechRecognizer", name },
      payload,
    });

    return await new Promise<AsrResult>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, result?: AsrResult) => {
        if (settled) return; settled = true; clearTimeout(timer); ws.close();
        error ? reject(error) : resolve(result!);
      };
      const timer = setTimeout(() => finish(new Error("阿里云 ASR 响应超时")), 45_000);
      ws.once("error", (error) => finish(error));
      ws.once("open", () => ws.send(message("StartRecognition", {
        format: "pcm", sample_rate: 16000, enable_intermediate_result: false,
        enable_punctuation_prediction: true, enable_inverse_text_normalization: true,
      })));
      ws.on("message", async (data, isBinary) => {
        if (isBinary || settled) return;
        try {
          const event = JSON.parse(data.toString()) as { header?: { name?: string; status?: number; status_text?: string }; payload?: { result?: string } };
          const name = event.header?.name;
          if (name === "RecognitionStarted") {
            for (let offset = 0; offset < pcm16k.length && !settled; offset += 3200) {
              ws.send(pcm16k.subarray(offset, offset + 3200));
              if (offset + 3200 < pcm16k.length) await new Promise((r) => setTimeout(r, 80));
            }
            ws.send(message("StopRecognition"));
          } else if (name === "RecognitionCompleted") {
            const text = event.payload?.result ?? ""; const durationSec = pcm16k.length / 32_000;
            finish(undefined, { text, segments: text ? [{ start: 0, end: durationSec, text }] : [], durationSec });
          } else if (name === "TaskFailed") {
            finish(new Error(`阿里云 ASR 失败 ${event.header?.status ?? ""}: ${event.header?.status_text ?? "未知错误"}`));
          }
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
    });
  }
}

export interface DashScopeAsrOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
}

/** 阿里云百炼(DashScope)的 Qwen3-ASR。一个 API Key 就够，不需要 NLS 那套
 *  AppKey + AccessKey；走 OpenAI 兼容接口，音频按 WAV base64 直接传。*/
/** 词库拼成一句给识别模型的提示。太长会挤占上下文，截到 60 个词 */
export function hintText(hints?: string[]) {
  const words = (hints ?? []).map((w) => w.trim()).filter(Boolean).slice(0, 60);
  return words.length ? `这段录音里可能出现这些词，优先按它们识别：${words.join("、")}。` : "";
}

export class DashScopeAsrProvider implements AsrProvider {
  readonly name = "dashscope";
  readonly model: string;
  constructor(private readonly options: DashScopeAsrOptions) { this.model = options.model; }

  async transcribe(pcm16k: Buffer, hints?: string[]): Promise<AsrResult> {
    const durationSec = pcm16k.length / 32_000;
    if (pcm16k.length === 0) return { text: "", segments: [], durationSec: 0 };
    const audio = pcm16MonoToWav(pcm16k).toString("base64");
    const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
      method: "POST", signal: AbortSignal.timeout(60_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({
        model: this.options.model,
        messages: [
          { role: "system", content: [{ type: "text", text: hintText(hints) }] },
          { role: "user", content: [{ type: "input_audio", input_audio: { data: `data:audio/wav;base64,${audio}`, format: "wav" } }] },
        ],
        modalities: ["text"],
        asr_options: { language: "zh", enable_itn: true },
      }),
    });
    if (!response.ok) {
      throw new Error(`DashScope ASR 失败 ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const payload = await response.json() as { choices?: { message?: { content?: unknown } }[] };
    const content = payload.choices?.[0]?.message?.content;
    // 兼容两种返回：纯字符串，或 [{ type: "text", text: "..." }]
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.map((part) => typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "").join("")
      : "";
    return { text: text.trim(), segments: [], durationSec };
  }
}

/* ────────────────────────────────────────────────────────────────
 * 百炼实时语音识别（WebSocket 双工），可跑 fun-asr-realtime / paraformer-realtime-v2。
 * 音频直接以二进制帧推上去，不用放到公网地址——录音文件识别那套接口要求传 URL。
 * 协议：run-task → task-started → 推音频 → finish-task → result-generated… → task-finished
 *
 * 实测（2026-09-19，线上 6 段佩戴者清楚说话的录音）：
 *   fun-asr-realtime 准确度几乎和 qwen3-asr-flash 一样，每段 0.9–3.5 秒；
 *   paraformer-realtime-v2 明显丢词，不推荐。
 * 但 fun-asr-realtime 据第三方整理是 ¥0.00033/秒，比 qwen3-asr-flash 还贵，所以默认没用它，
 * 留作 ECONOMY_ASR=funasr 的可选项。
 * ──────────────────────────────────────────────────────────────── */
export class DashScopeRealtimeAsrProvider implements AsrProvider {
  readonly name = "dashscope-realtime";
  readonly model: string;
  constructor(private readonly options: { apiKey: string; model: string; url?: string; webSocketFactory?: (url: string, key: string) => WebSocket }) {
    this.model = options.model;
  }

  async transcribe(pcm16k: Buffer): Promise<AsrResult> {
    const durationSec = pcm16k.length / 32_000;
    if (pcm16k.length === 0) return { text: "", segments: [], durationSec: 0 };
    const url = this.options.url ?? "wss://dashscope.aliyuncs.com/api-ws/v1/inference/";
    const ws = this.options.webSocketFactory?.(url, this.options.apiKey)
      ?? new WebSocket(url, { headers: { authorization: `bearer ${this.options.apiKey}` } });
    const taskId = randomUUID().replace(/-/g, "");
    const header = (action: string) => ({ action, task_id: taskId, streaming: "duplex" });

    return await new Promise<AsrResult>((resolve, reject) => {
      const sentences = new Map<number, string>();
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer); ws.close();
        if (error) return reject(error);
        const text = [...sentences.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join("");
        resolve({ text: text.trim(), segments: [], durationSec });
      };
      const timer = setTimeout(() => finish(new Error("实时识别响应超时")), 60_000);
      ws.once("error", (e) => finish(e));
      ws.once("open", () => ws.send(JSON.stringify({
        header: header("run-task"),
        payload: { task_group: "audio", task: "asr", function: "recognition", model: this.model,
          parameters: { format: "pcm", sample_rate: 16000, language_hints: ["zh"] }, input: {} },
      })));
      ws.on("message", async (data, isBinary) => {
        if (isBinary || settled) return;
        try {
          const msg = JSON.parse(data.toString()) as { header?: { event?: string; error_message?: string; error_code?: string };
            payload?: { output?: { sentence?: { text?: string; sentence_end?: boolean; begin_time?: number } } } };
          const event = msg.header?.event;
          if (event === "task-started") {
            // 实时接口按 100ms 一帧推；我们手里是整句录音，推得比实时快一些没问题
            for (let off = 0; off < pcm16k.length && !settled; off += 3200) {
              ws.send(pcm16k.subarray(off, off + 3200));
              if ((off / 3200) % 10 === 9) await new Promise((r) => setTimeout(r, 20));
            }
            ws.send(JSON.stringify({ header: header("finish-task"), payload: { input: {} } }));
          } else if (event === "result-generated") {
            const sentence = msg.payload?.output?.sentence;
            if (sentence?.text !== undefined && sentence.sentence_end) sentences.set(sentence.begin_time ?? sentences.size, sentence.text);
          } else if (event === "task-finished") {
            finish();
          } else if (event === "task-failed") {
            finish(new Error(`实时识别失败 ${msg.header?.error_code ?? ""}: ${msg.header?.error_message ?? "未知错误"}`));
          }
        } catch (e) { finish(e instanceof Error ? e : new Error(String(e))); }
      });
      ws.once("close", () => finish(new Error("实时识别连接提前关闭")));
    });
  }
}

/* ────────────────────────────────────────────────────────────────
 * 经济档（本地）：自己服务器上跑的 SenseVoice（deploy/local-asr）。
 * 每小时几乎零成本，只有服务器月费。需要 4 核 8G 以上，现在这台 2 核 2G 跑不了。
 * ──────────────────────────────────────────────────────────────── */
export class SenseVoiceAsrProvider implements AsrProvider {
  readonly name = "sensevoice";
  readonly model = "sensevoice-local";
  constructor(private readonly options: { url: string }) {}

  async transcribe(pcm16k: Buffer): Promise<AsrResult> {
    const durationSec = pcm16k.length / 32_000;
    if (pcm16k.length === 0) return { text: "", segments: [], durationSec: 0 };
    const response = await fetch(`${this.options.url.replace(/\/$/, "")}/asr`, {
      method: "POST", signal: AbortSignal.timeout(60_000),
      headers: { "content-type": "application/octet-stream" }, body: pcm16k,
    });
    if (!response.ok) throw new Error(`本地 SenseVoice 失败 ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const body = await response.json() as { text?: string };
    return { text: (body.text ?? "").trim(), segments: [], durationSec };
  }
}

/** 按档位挑识别引擎。经济档在迁移到能跑本地识别的服务器之前，和高质量档用同一个云端引擎。*/
export class AsrRouter {
  constructor(private readonly providers: { high: AsrProvider; economy: AsrProvider }) {}
  forTier(tier: "high" | "economy") { return this.providers[tier]; }
}

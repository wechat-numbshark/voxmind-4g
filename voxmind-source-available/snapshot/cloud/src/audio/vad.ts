import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as ort from "onnxruntime-node";

/* 人声检测（Silero VAD v5）。
 *
 * 为什么需要它：线上 4110 段转写里 3310 段（80%）只有一个「嗯。」——语音识别
 * 对着环境噪音"听出"了语气词。每一段都照价计费，还都会再调一次大模型。按音量
 * 判断分不清人声和噪音，Silero 是专门区分人声的小模型（约 2MB，CPU 上一帧不到 1 毫秒）。
 *
 * 输入格式照官方 v5 封装：每帧 512 个采样（16kHz 下 32ms），前面拼上一帧末尾
 * 64 个采样作上下文；state 在一段音频内逐帧传递。*/

const FRAME = 512;
const CONTEXT = 64;
const FRAME_MS = 32;

export interface VadResult {
  /** 判为人声的总时长 */
  speechMs: number;
  /** 第一帧 / 最后一帧人声在这段里的偏移；没有人声时为 null */
  firstMs: number | null;
  lastMs: number | null;
  /** 每帧人声概率里的最大值，调参时看 */
  maxProb: number;
}

export interface VadOptions {
  /** 帧概率超过它算人声。默认 0.15 是用线上真实录音校准的（见 isSpeech 的说明） */
  threshold?: number;
  /** 先把整段按平均电平归一化再检测。默认开 */
  normalize?: boolean;
}

/** 按平均电平（RMS）拉到 -28dBFS，峰值用 tanh 软限幅，最多放大 60dB。
 *  设备录音里远处的声音电平很低，不归一化的话模型对真人声也几乎不响应。*/
export function normalizeLoudness(pcm16k: Buffer): Buffer {
  const s = new Int16Array(pcm16k.buffer, pcm16k.byteOffset, Math.floor(pcm16k.length / 2));
  let sum = 0;
  for (const v of s) sum += v * v;
  const rms = Math.sqrt(sum / Math.max(1, s.length)) || 1;
  const gain = Math.min(1000, (32768 * 10 ** (-28 / 20)) / rms);
  const out = Buffer.alloc(s.length * 2);
  for (let i = 0; i < s.length; i++) out.writeInt16LE(Math.round(Math.tanh((s[i]! * gain) / 32768) * 32767), i * 2);
  return out;
}

let session: Promise<ort.InferenceSession> | null = null;
const modelPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "models", "silero_vad.onnx");

function load() {
  session ??= ort.InferenceSession.create(modelPath, { intraOpNumThreads: 1, interOpNumThreads: 1 });
  return session;
}

export async function detectSpeech(pcm16k: Buffer, options: VadOptions = {}): Promise<VadResult> {
  const threshold = options.threshold ?? 0.15;
  const s = await load();
  const pcm = options.normalize === false ? pcm16k : normalizeLoudness(pcm16k);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  let state: ort.Tensor = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  const sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
  const input = new Float32Array(CONTEXT + FRAME);
  let speechFrames = 0, first: number | null = null, last: number | null = null, maxProb = 0;

  for (let i = 0, frame = 0; i + FRAME <= samples.length; i += FRAME, frame++) {
    input.copyWithin(0, FRAME, FRAME + CONTEXT);          // 上一帧末尾 64 个采样当上下文
    for (let j = 0; j < FRAME; j++) input[CONTEXT + j] = samples[i + j]! / 32768;
    const out = await s.run({ input: new ort.Tensor("float32", input.slice(), [1, CONTEXT + FRAME]), state, sr });
    state = out.stateN!;
    const prob = (out.output as ort.Tensor).data[0] as number;
    if (prob > maxProb) maxProb = prob;
    if (prob >= threshold) {
      speechFrames++;
      first ??= frame * FRAME_MS;
      last = (frame + 1) * FRAME_MS;
    }
  }
  return { speechMs: speechFrames * FRAME_MS, firstMs: first, lastMs: last, maxProb };
}

/** 最少多少毫秒人声才算"有人在说话" */
export const MIN_SPEECH_MS = 250;

/* 校准记录（2026-09-19，线上随机 80 段真实录音，归一化后）：
 *   阈值 0.15：识别出 10 字以上真话的 30 段保留 26 段；被识别成「嗯。」的 30 段只放过 4 段；空白 20 段放过 2 段。
 *   漏掉的 4 段全是远处播放的视频声（「点击视频下方链接」之类），本来就不该转写，更不该拿去抽指令。
 *   阈值 0.5 时真话只保留 14/30——别往上调。*/
export async function isSpeech(pcm16k: Buffer) {
  const r = await detectSpeech(pcm16k);
  return { ...r, speech: r.speechMs >= MIN_SPEECH_MS };
}

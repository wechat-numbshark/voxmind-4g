import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ObjectStore } from "../storage/object-store.js";
import { normalizeForModel } from "./clear.js";
import { pcm16MonoToWav } from "./wav.js";

const run = promisify(execFile);

/* 回放的 AI 降噪：DeepFilterNet3（官方 deep-filter 命令行，v0.5.6，静态编译、只用 CPU、不用 Python）。
 * 只用于回放和导出——识别用原始录音（降噪伪影会让识别错得更多）。
 *
 * 2026-10-04 在服务器上用用户的距离测试录音实测（15 秒一块）：
 * - 每块 1.2~1.6 秒（2 核机器上约 10 倍实时），所以按需处理、处理完缓存，同一块只算一次
 * - 直接喂原始录音会把人声当噪声一起压掉 15~24 dB——设备录得太小（人声 -50~-60 dBFS），模型没见过这么小的人声。
 *   先把人声拉到 -20 左右再降噪：贴着~2 米人声比背景高的从 13~23 dB 提到 28~38 dB；5~7 米提升小一些
 * - 衰减上限 24 dB（-a 24）：不追求把背景压没，压太狠人声会发闷、像在水里
 * 降噪后再走一遍清晰模式（音量、碰撞声、字间门）。*/

export const DEEP_FILTER_VERSION = "dfn3-0.5.6-a24";
const derivedKey = (objectKey: string) => `derived/${DEEP_FILTER_VERSION}/${objectKey}.pcm`;

export class Denoiser {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly objects: ObjectStore,
    private readonly bin = process.env.DEEP_FILTER_BIN ?? "/usr/local/bin/deep-filter") {}

  available() { return existsSync(this.bin); }

  /** 降噪后的 16kHz PCM。缓存命中直接返回；失败返回 null（调用方退回不降噪） */
  async process(objectKey: string, pcm16k: Buffer): Promise<Buffer | null> {
    if (!this.available()) return null;
    const key = derivedKey(objectKey);
    const cached = await this.objects.get(key).catch(() => null);
    if (cached) return cached.body;
    /* 一次只跑一个：服务器 2 核，还要转写、拆主题 */
    const job = this.queue.then(() => this.runOnce(pcm16k));
    this.queue = job.catch(() => undefined);
    const out = await job.catch(() => null);
    if (out) await this.objects.put(key, out, "audio/L16").catch(() => undefined);
    return out;
  }

  private async runOnce(pcm16k: Buffer) {
    const dir = await mkdtemp(join(tmpdir(), "voxmind-dfn-"));
    try {
      await writeFile(join(dir, "in16.wav"), pcm16MonoToWav(normalizeForModel(pcm16k)));
      await run("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-i", join(dir, "in16.wav"), "-ar", "48000", "-ac", "1", join(dir, "a.wav")], { timeout: 20_000 });
      await run(this.bin, ["-D", "-a", "24", "-o", join(dir, "out"), join(dir, "a.wav")], { timeout: 60_000 });
      await run("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-i", join(dir, "out", "a.wav"), "-ar", "16000", "-ac", "1", "-f", "s16le", join(dir, "out16.pcm")], { timeout: 20_000 });
      return await readFile(join(dir, "out16.pcm"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** 删音频时把降噪缓存一起删：删录音就要删干净，不能留一份「降噪版」 */
export function withDerivedCleanup(objects: ObjectStore): ObjectStore {
  return {
    put: (key, body, type) => objects.put(key, body, type),
    get: (key) => objects.get(key),
    delete: async (key) => {
      await objects.delete(key);
      if (!key.startsWith("derived/")) await objects.delete(derivedKey(key)).catch(() => undefined);
    },
  };
}

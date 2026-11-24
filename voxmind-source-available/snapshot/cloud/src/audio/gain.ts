/* 回放/导出的音量补偿。
 *
 * 设备录得偏小：2026-09-19 抽 12 段有人说话的录音实测，均值 -43~-54 dBFS、峰值 -20~-34 dBFS
 * （正常人声录音均值在 -20 左右）。转写不受影响（识别前会拉平），但人耳回放听着费劲。
 *
 * 用固定增益而不是逐块自动归一化：逐块归一化会把静音块的底噪放大上千倍，
 * 一句话跨几块时音量还会忽大忽小。固定增益 + 软限幅：小声部分线性放大，
 * 接近满幅的峰值用 tanh 压住，不会爆音。原始录音文件不动。*/

import type { UserPrefs } from "../domain.js";
import { clarify } from "./clear.js";

export const GAIN_DB: Record<Exclude<UserPrefs["playbackGain"], "clear" | "denoise">, number> = { standard: 18, loud: 26, original: 0 };

/** 回放/导出按用户选的模式处理。clear＝清晰模式（见 clear.ts），其余是固定增益。raw＝原样（给识别类用途） */
export function forPlayback(pcm16: Buffer, mode: UserPrefs["playbackGain"] | "raw"): Buffer {
  if (mode === "raw") return pcm16;
  if (mode === "clear" || mode === "denoise") return clarify(pcm16);   // denoise 的降噪那一步在 app 里做（要跑外部程序、带缓存）
  return applyGain(pcm16, GAIN_DB[mode]);
}

const KNEE = 0.6;   // 满幅的 60% 以下完全线性

export function applyGain(pcm16: Buffer, db: number): Buffer {
  if (!db) return pcm16;
  const gain = 10 ** (db / 20);
  const n = Math.floor(pcm16.length / 2);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = (pcm16.readInt16LE(i * 2) / 32768) * gain;
    const a = Math.abs(v);
    const y = a <= KNEE ? v : Math.sign(v) * (KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE)));
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(y * 32767))), i * 2);
  }
  return out;
}

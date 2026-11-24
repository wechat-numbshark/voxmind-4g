import { describe, expect, it } from "vitest";
import { clarify, speechLevelDb } from "../src/audio/clear.js";

/* 清晰模式：人声拉到正常音量，突然的碰撞声压下去 */

const RATE = 16_000;
function pcm(samples: Float32Array) {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2));
  return b;
}
function floats(b: Buffer) {
  const x = new Float32Array(b.length / 2);
  for (let i = 0; i < x.length; i++) x[i] = b.readInt16LE(i * 2) / 32768;
  return x;
}
const rmsDb = (x: Float32Array, from: number, to: number) => {
  let e = 0; for (let i = from; i < to; i++) e += x[i]! * x[i]!;
  return 20 * Math.log10(Math.sqrt(e / (to - from)));
};
const peakDb = (x: Float32Array, from: number, to: number) => {
  let p = 0; for (let i = from; i < to; i++) p = Math.max(p, Math.abs(x[i]!)); return 20 * Math.log10(p);
};

describe("回放清晰模式", () => {
  /* 3 秒"人声"（-58 dBFS 的 300Hz 调幅音）+ 第 2 秒一下碰撞（50ms、-8 dBFS 的宽带脉冲） */
  const x = new Float32Array(3 * RATE);
  const speechAmp = 10 ** (-55 / 20);
  for (let i = 0; i < x.length; i++) x[i] = speechAmp * Math.sin((2 * Math.PI * 300 * i) / RATE) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * i) / RATE));
  const bump = 2 * RATE;
  for (let i = bump; i < bump + 800; i++) x[i] = x[i]! + 0.4 * Math.sin((2 * Math.PI * 1500 * i) / RATE) * Math.exp(-(i - bump) / 200);

  const out = floats(clarify(pcm(x)));

  it("人声拉到正常音量附近", () => {
    expect(rmsDb(x, 0, RATE)).toBeLessThan(-55);
    expect(rmsDb(out, 0, RATE)).toBeGreaterThan(-30);
  });

  it("碰撞声比人声高出的部分压到 15 dB 以内（原来高出 40 dB 以上）", () => {
    const before = peakDb(x, bump, bump + 800) - rmsDb(x, 0, RATE);
    const after = peakDb(out, bump, bump + 800) - rmsDb(out, 0, RATE);
    expect(before).toBeGreaterThan(40);
    expect(after).toBeLessThan(15);
  });

  it("没有声音的块不硬拉（按固定 18dB），不会把底噪放大上千倍", () => {
    expect(speechLevelDb(new Float32Array(RATE))).toBeNull();
    const silent = new Float32Array(RATE).fill(10 ** (-90 / 20));
    expect(peakDb(floats(clarify(pcm(silent))), 0, RATE)).toBeLessThan(-60);
  });
});

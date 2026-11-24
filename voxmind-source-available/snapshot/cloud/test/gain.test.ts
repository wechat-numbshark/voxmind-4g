import { describe, expect, it } from "vitest";
import { applyGain } from "../src/audio/gain.js";

/* 回放增益：小声线性放大，接近满幅的软限幅不爆音 */
const pcm = (values: number[]) => { const b = Buffer.alloc(values.length * 2); values.forEach((v, i) => b.writeInt16LE(v, i * 2)); return b; };
const read = (b: Buffer) => Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));

describe("回放增益", () => {
  it("小声部分 +18dB 是线性的（约 7.94 倍）", () => {
    const [v] = read(applyGain(pcm([400]), 18));
    expect(v! / 400).toBeCloseTo(7.94, 1);
  });
  it("大声的峰值被压住，不会超过满幅也不会翻转", () => {
    const out = read(applyGain(pcm([20000, -20000, 32767]), 26));
    for (const v of out) expect(Math.abs(v)).toBeLessThanOrEqual(32767);
    expect(out[0]).toBeGreaterThan(0);
    expect(out[1]).toBeLessThan(0);
  });
  it("原声档不改任何字节", () => {
    const b = pcm([1, 2, 3]);
    expect(applyGain(b, 0)).toBe(b);
  });
});

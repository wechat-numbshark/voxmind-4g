import { describe, expect, it } from "vitest";
import { DEVICE_FEED_BYTES, fitDeviceFeed } from "../src/device-feed.js";

describe("device feed serialized budget", () => {
  it.each([DEVICE_FEED_BYTES.legacy, DEVICE_FEED_BYTES.v2])("bounds escaped unicode without mutating source: %s", (budget) => {
    const row = { t: "工具".repeat(80), n: '"\\\n中'.repeat(10), s: "executed", a: "23:59", e: "原话😀".repeat(20) };
    const input = { receipts: Array.from({ length: 4 }, (_, i) => ({ ...row, i: String(i) })),
      timeline: Array.from({ length: 10 }, () => ({ ...row })), today: { recordedSec: 2000, sentences: 50, done: 10 } };
    const original = JSON.stringify(input);
    const output = fitDeviceFeed(input, budget);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(budget);
    expect(JSON.stringify(input)).toBe(original);
    expect(output.receipts[0]?.i).toBe("0");
    expect(output.today).toEqual(input.today);
  });
});

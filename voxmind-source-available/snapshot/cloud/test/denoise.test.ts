import { describe, expect, it } from "vitest";
import { Denoiser, withDerivedCleanup } from "../src/audio/denoise.js";
import type { ObjectStore } from "../src/storage/object-store.js";

/* AI 降噪：程序不在就退回（返回 null），删音频时连缓存一起删 */

function memStore() {
  const m = new Map<string, Buffer>();
  const store: ObjectStore = {
    put: async (key, body, contentType) => { m.set(key, body); return { key, byteLength: body.length, contentType }; },
    get: async (key) => (m.has(key) ? { body: m.get(key)!, contentType: "audio/L16" } : null),
    delete: async (key) => { m.delete(key); },
  };
  return { m, store };
}

describe("回放 AI 降噪", () => {
  it("没装 deep-filter 时返回 null，调用方退回清晰模式", async () => {
    const { store } = memStore();
    const d = new Denoiser(store, "/no/such/deep-filter");
    expect(d.available()).toBe(false);
    expect(await d.process("dev/s/1.ogg", Buffer.alloc(3200))).toBeNull();
  });

  it("删一块音频时，它的降噪缓存一起删掉", async () => {
    const { m, store } = memStore();
    await store.put("dev/s/1.ogg", Buffer.from("a"), "audio/ogg");
    const derived = [...m.keys()];
    await store.put("derived/dfn3-0.5.6-a24/dev/s/1.ogg.pcm", Buffer.from("b"), "audio/L16");
    expect(m.size).toBe(2);
    await withDerivedCleanup(store).delete("dev/s/1.ogg");
    expect([...m.keys()]).toEqual([]);
    expect(derived).toEqual(["dev/s/1.ogg"]);
  });
});

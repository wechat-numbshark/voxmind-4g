import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AsrRouter, type AsrProvider } from "../src/asr/index.js";
import { MockToolExecutor } from "../src/connectors/mock.js";
import type { AudioChunk, ChunkState, TranscriptSegment } from "../src/domain.js";
import { IntentRouter, type IntentProvider } from "../src/intent/provider.js";
import type { EmbeddingProvider } from "../src/search/embeddings.js";
import { ActionService } from "../src/services/actions.js";
import { ExecutionService } from "../src/services/execution.js";
import { PricingService } from "../src/services/pricing.js";
import { SettingsService } from "../src/services/settings.js";
import { startTranscriptionWorker, TranscriptionService } from "../src/services/transcription.js";
import { MemoryRepository } from "../src/store/memory.js";

vi.mock("../src/audio/vad.js", () => ({
  isSpeech: async (pcm: Buffer) => ({ speech: true, speechMs: pcm.length / 32, firstMs: 0, lastMs: pcm.length / 32 }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(embeddings?: EmbeddingProvider) {
  const repository = new MemoryRepository();
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  await repository.createSession({ id: sessionId, deviceId: "latency-test", userId: "owner", startedAt: now });
  const transcribe = vi.fn(async (pcm: Buffer) => ({ text: "查询当前温度", segments: [], durationSec: pcm.length / 32000 }));
  const extract = vi.fn(async () => []);
  const asr: AsrProvider = { name: "fixture-asr", transcribe };
  const intent: IntentProvider = { name: "fixture-intent", extract };
  const service = new TranscriptionService({ repository,
    objects: { put: async () => {}, get: async () => ({ body: Buffer.alloc(32_000), contentType: "audio/pcm" }),
      delete: async () => {}, health: async () => ({ ok: true }) },
    asr: new AsrRouter({ high: asr, economy: asr }), intent: new IntentRouter({ high: intent, economy: intent }),
    actions: new ActionService(repository), executions: new ExecutionService(repository, new MockToolExecutor()),
    settings: new SettingsService(repository, "high"), pricing: new PricingService(repository), embeddings,
  });
  const chunk = async (sequence: number, stage: "pending" | "speech" = "speech") => {
    const c: AudioChunk = { sessionId, sequence, startMs: sequence * 1000, durationMs: 1000,
      sha256: "a".repeat(64), objectKey: `${sessionId}/${sequence}`, contentType: "audio/pcm", byteLength: 32_000,
      uploadedAt: new Date(Date.now() - 60_000).toISOString() };
    await repository.putChunk(c);
    if (stage === "speech") await repository.saveVad(sessionId, sequence, { speech: true, speechMs: 1000, firstMs: 0, lastMs: 1000 });
    return c;
  };
  const transcript = async (sequence: number) => {
    await chunk(sequence);
    const t: TranscriptSegment = { sessionId, sequence, startMs: sequence * 1000, endMs: (sequence + 1) * 1000,
      text: "历史录音", provider: "fixture", status: "succeeded", error: null, kind: "speech", endSequence: null,
      createdAt: now, updatedAt: now };
    await repository.finishRun(t, []);
    await repository.finishIntent(sessionId, sequence, "skipped");
  };
  return { repository, sessionId, service, chunk, transcript, transcribe, extract };
}

describe("independent transcription stages", () => {
  it("keeps transcribing and analyzing new commands while an old embedding request is blocked", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    let embeddingCalls = 0;
    const f = await fixture({ name: "fixture-embedding", dimensions: 2,
      async embed(texts) {
        embeddingCalls++;
        started.resolve();
        await release.promise;
        return { vectors: texts.map(() => [1, 0]), model: "fixture", inputTokens: 1 };
      } });
    await f.transcript(0);
    const stop = startTranscriptionWorker(f.service, 5);
    try {
      await started.promise;
      await f.chunk(20, "pending");
      await f.repository.addSpeechMark(f.sessionId, 20_100, 20_900);
      await vi.waitFor(() => expect(f.extract).toHaveBeenCalledTimes(1), { timeout: 1000, interval: 5 });
      expect(f.transcribe).toHaveBeenCalledTimes(1);
      expect(embeddingCalls).toBe(1); // Not restarted concurrently on each worker iteration.
    } finally {
      stop();
      release.resolve();
      await f.service.tick();
    }
  });

  it.each([
    ["vad", "claimVadChunks"], ["asr", "sessionsWithSpeech"],
    ["intent", "claimIntentSegments"], ["embedding", "claimEmbeddingSegments"],
  ] as const)("never overlaps the same %s stage when callers race", async (stage, method) => {
    const f = await fixture({ name: "fixture-embedding", dimensions: 2,
      async embed() { return { vectors: [], model: "fixture", inputTokens: 0 }; } });
    const release = deferred<never[]>();
    const claim = vi.spyOn(f.repository, method).mockImplementation(() => release.promise);
    const first = f.service.tickStage(stage);
    const second = f.service.tickStage(stage);
    await Promise.resolve();
    expect(claim).toHaveBeenCalledTimes(1);
    release.resolve([]);
    expect(await Promise.all([first, second])).toEqual([0, 0]);
    await f.service.tickStage(stage);
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it("releases a failed stage gate and retains deterministic drain completion", async () => {
    const f = await fixture();
    vi.spyOn(f.repository, "claimVadChunks").mockRejectedValueOnce(new Error("temporary repository failure"));
    await expect(f.service.tickStage("vad")).rejects.toThrow("temporary repository failure");
    await f.chunk(0, "pending");
    await f.repository.addSpeechMark(f.sessionId, 100, 900);
    expect(await f.service.drain()).toBeGreaterThanOrEqual(3);
    expect(f.transcribe).toHaveBeenCalledTimes(1);
    expect(f.extract).toHaveBeenCalledTimes(1);
    expect(await f.service.drain()).toBe(0);
  });
});

describe("same-session held-command priority", () => {
  it("starts from the marked chunk, then returns to older background audio without dropping it", async () => {
    const f = await fixture();
    await f.chunk(0);
    await f.chunk(20);
    await f.repository.addSpeechMark(f.sessionId, 20_100, 20_900);
    expect(await f.repository.sessionsWithSpeech(1)).toEqual([{ sessionId: f.sessionId, firstSequence: 20 }]);
    expect(await f.service.tickStage("asr")).toBe(1);
    expect((await f.repository.listTranscripts(f.sessionId)).map((t) => t.sequence)).toEqual([20]);
    expect(await f.repository.sessionsWithSpeech(1)).toEqual([{ sessionId: f.sessionId, firstSequence: 0 }]);
    expect(await f.service.tickStage("asr")).toBe(1);
    expect((await f.repository.listTranscripts(f.sessionId)).map((t) => t.sequence)).toEqual([0, 20]);
  });

  it("does not skip a command prefix whose VAD has not finished", async () => {
    const f = await fixture();
    await f.chunk(0);
    await f.chunk(20, "pending");
    await f.chunk(21);
    await f.repository.addSpeechMark(f.sessionId, 20_100, 21_900);
    expect(await f.repository.sessionsWithSpeech(1)).toEqual([{ sessionId: f.sessionId, firstSequence: 20 }]);
    expect(await f.service.tickStage("asr")).toBe(0);
    await f.repository.saveVad(f.sessionId, 20, { speech: true, speechMs: 1000, firstMs: 0, lastMs: 1000 });
    expect(await f.service.tickStage("asr")).toBe(1);
    expect((await f.repository.listTranscripts(f.sessionId))[0]).toMatchObject({ sequence: 20, endSequence: 21 });
  });

  it("stops at the held command's end instead of appending background speech", async () => {
    const f = await fixture();
    for (const seq of [0, 1, 2]) await f.chunk(seq);
    const states = await f.repository.chunkStates(f.sessionId, 0, 3);
    expect(f.service.pickRun(states, [{ startMs: 100, endMs: 900 }])?.map((c) => c.sequence)).toEqual([0]);
  });

  it("waits for a known command tail even after the normal unmarked-audio idle timeout", async () => {
    const f = await fixture();
    await f.chunk(0);
    const states: ChunkState[] = await f.repository.chunkStates(f.sessionId, 0, 1);
    expect(f.service.pickRun(states)).toHaveLength(1);
    expect(f.service.pickRun(states, [{ startMs: 100, endMs: 1900 }])).toBeNull();
  });
});

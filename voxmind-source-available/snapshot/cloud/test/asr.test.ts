import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsrRouter, signAliyunTokenRequest, type AsrProvider } from "../src/asr/index.js";
import type { ChunkState } from "../src/domain.js";
import { IntentRouter, type IntentProvider } from "../src/intent/provider.js";
import { MockToolExecutor } from "../src/connectors/mock.js";
import { ActionService } from "../src/services/actions.js";
import { ExecutionService } from "../src/services/execution.js";
import { PricingService } from "../src/services/pricing.js";
import { SettingsService } from "../src/services/settings.js";
import { TranscriptionService } from "../src/services/transcription.js";
import { detectPowerCommand, isFiller } from "../src/speech/text.js";
import { FileObjectStore } from "../src/storage/file-store.js";
import { MemoryRepository } from "../src/store/memory.js";
import { syntheticSpeechPcm } from "./fixtures/synthetic-speech.js";

describe("Aliyun ASR signing", () => {
  it("matches the official POP signature example", () => {
    const query = signAliyunTokenRequest("my_access_key_id", "my_access_key_secret", "2019-04-18T08:32:31Z", "b924c8c3-6d03-4c5d-ad36-d984d3116788");
    expect(query).toContain("Signature=hHq4yNsPitlfDJ2L0nQPdugdEzM%3D");
  });
});

describe("唤醒指令与语气词", () => {
  it("按拼音认「小沃」，同音字也算，但必须紧跟关机/开机", () => {
    expect(detectPowerCommand("小沃小沃，关机。", "小沃小沃")).toBe("off");
    expect(detectPowerCommand("小我小我关机", "小沃小沃")).toBe("off");     // 识别把「沃」写成了「我」
    expect(detectPowerCommand("小握，开机吧", "小沃小沃")).toBe("on");
    expect(detectPowerCommand("今天住的小窝挺好", "小沃小沃")).toBeNull();  // 没有关机/开机，不是指令
    expect(detectPowerCommand("我关机了", "小沃小沃")).toBeNull();          // 没叫唤醒词
  });
  it("「嗯。」「对对对」是语气词，真话不是", () => {
    expect(isFiller("嗯。")).toBe(true);
    expect(isFiller("对对对")).toBe(true);
    expect(isFiller("")).toBe(true);
    expect(isFiller("明天提醒我开会")).toBe(false);
  });
});

describe("转写流水线", () => {
  let dir: string;
  let repository: MemoryRepository;
  let objects: FileObjectStore;
  let speech: Buffer;
  let asrCalls: number[];            // 每次识别送进去的音频毫秒数
  let asrText: string;
  let intentCalls: { text: string; context?: string }[];
  let service: TranscriptionService;
  const sessionId = randomUUID();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "voxmind-pipeline-"));
    repository = new MemoryRepository();
    objects = new FileObjectStore(dir);
    speech = syntheticSpeechPcm();
    asrCalls = []; asrText = "明天下午三点提醒我给张伟打电话"; intentCalls = [];
    const asr: AsrProvider = { name: "fixture", model: "qwen3-asr-flash",
      async transcribe(pcm) { asrCalls.push(pcm.length / 32); return { text: asrText, segments: [], durationSec: pcm.length / 32000 }; } };
    const intent: IntentProvider = { name: "fixture-intent",
      async extract() { return []; },
      async extractMetered(text, _at, context) {
        intentCalls.push({ text, ...(context ? { context } : {}) });
        return { actions: [{ tool: "feishu.calendar.create", title: "给张伟打电话", detail: "明天 15:00", args: {}, evidence: text,
          confidence: 0.95, mode: "explicit", risk: "personal_write" }], usage: { inputTokens: 1000, outputTokens: 50 }, model: "qwen3.8-flash" };
      } };
    service = new TranscriptionService({
      repository, objects, asr: new AsrRouter({ high: asr, economy: asr }), intent: new IntentRouter({ high: intent, economy: intent }),
      actions: new ActionService(repository), executions: new ExecutionService(repository, new MockToolExecutor()),
      settings: new SettingsService(repository, "high"), pricing: new PricingService(repository),
      onPowerCommand: async (userId, command) => { if (command === "off") await repository.enqueueDeviceCommand(userId, "soft_off"); },
    });
    await repository.createSession({ id: sessionId, deviceId: "test", userId: "owner", startedAt: new Date().toISOString() });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** 5 秒一块：前面放一段合成信号（或不放），其余补低电平噪声 */
  async function chunk(sequence: number, withSpeech: boolean) {
    const pcm = Buffer.alloc(160_000);
    for (let i = 0; i < 80_000; i++) pcm.writeInt16LE(Math.round((Math.random() - 0.5) * 6), i * 2);
    if (withSpeech) speech.copy(pcm, 0, 0, Math.min(speech.length, pcm.length));
    const objectKey = `${sessionId}/${sequence}.pcm`;
    await objects.put(objectKey, pcm, "audio/pcm");
    await repository.putChunk({ sessionId, sequence, sha256: createHash("sha256").update(pcm).digest("hex"), objectKey,
      contentType: "audio/pcm", byteLength: pcm.length, startMs: sequence * 5000, durationMs: 5000, uploadedAt: new Date().toISOString() });
  }

  it("静音段不送识别，也不调大模型", async () => {
    await chunk(0, false);
    await service.drain();
    expect(asrCalls).toHaveLength(0);
    expect(intentCalls).toHaveLength(0);
    expect(await repository.listTranscripts(sessionId)).toMatchObject([{ sequence: 0, kind: "silent", text: "" }]);
    expect(await repository.usageRollup("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z")).toHaveLength(0);
  });

  it("相邻的人声段拼成一句识别一次，并裁掉结尾的静音", async () => {
    await chunk(0, true); await chunk(1, true); await chunk(2, false);
    await service.drain();
    expect(asrCalls).toHaveLength(1);
    // 两段共 10 秒。末段的合成信号约 3.6 秒后被 VAD 看成静音，裁掉之后应明显少于 10 秒
    expect(asrCalls[0]!).toBeGreaterThan(8000);
    expect(asrCalls[0]!).toBeLessThan(9500);
    const segments = await repository.listTranscripts(sessionId);
    expect(segments.find((s) => s.sequence === 0)).toMatchObject({ kind: "speech", endSequence: 1, startMs: 0, endMs: 10_000 });
    expect(segments.find((s) => s.sequence === 1)).toMatchObject({ kind: "merged" });
    expect(intentCalls).toEqual([{ text: "明天下午三点提醒我给张伟打电话" }]);
    const drafts = await repository.listDrafts("owner");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ evidenceStartMs: 0, evidenceEndMs: 10_000 });
  });

  it("一句话还没说完（下一段还没传上来）就先等着", async () => {
    await chunk(0, true);
    await service.drain();
    expect(asrCalls).toHaveLength(0);
    const state = (await repository.chunkStates(sessionId, 0, 5))[0]!;
    expect(state.stage).toBe("speech");
    // 等太久（设备断网或人不说了）就不再等
    const stale: ChunkState = { ...state, uploadedAt: new Date(Date.now() - 60_000).toISOString() };
    expect(service.pickRun([stale])).toHaveLength(1);
  });

  it("暂停过（块号连着、钟点隔开）：不拼成一句，前一句立刻识别", () => {
    const base = { sessionId, contentType: "audio/ogg", byteLength: 1, sha256: "x", objectKey: "k", durationMs: 5000,
      uploadedAt: new Date().toISOString(), stage: "speech" as const, attempts: 0, speechMs: 3000, vadFirstMs: 0, vadLastMs: 5000 };
    const before: ChunkState = { ...base, sequence: 3, startMs: 15_000 };
    const after: ChunkState = { ...base, sequence: 4, startMs: 15_000 + 5000 + 600_000 };   // 暂停了 10 分钟
    expect(service.pickRun([before, after])).toEqual([before]);
    const right: ChunkState = { ...after, startMs: 20_000 };                                // 接得上：还在等这句话说完
    expect(service.pickRun([before, right])).toBeNull();
    const old = new Date(Date.now() - 60_000).toISOString();
    expect(service.pickRun([{ ...before, uploadedAt: old }, { ...right, uploadedAt: old }])?.length).toBe(2);
  });

  it("按住说的命令整段已上传：不等下一段，立刻识别（暂停时按住录的那一小段后面不会有下一段）", async () => {
    await chunk(0, true);
    await repository.addSpeechMark(sessionId, 500, 4_000);      // 按住区间的结尾落在这一段里
    await service.drain();
    expect(asrCalls).toHaveLength(1);                            // 以前要白等 12 秒
  });

  it("按住区间还没录完（结尾在下一段里）：照常等", async () => {
    await chunk(0, true);
    await repository.addSpeechMark(sessionId, 500, 8_000);
    await service.drain();
    expect(asrCalls).toHaveLength(0);
  });

  it("同一会话的指令先于旧背景录音，之后仍处理旧录音", async () => {
    await chunk(0, true); await chunk(1, false);
    await chunk(40, true); await chunk(41, true);
    await repository.addSpeechMark(sessionId, 200_500, 204_000);
    await service.tickStage("vad");
    expect(await repository.sessionsWithSpeech(1)).toMatchObject([{ firstSequence: 40 }]);
    await service.tickStage("asr");
    expect((await repository.listTranscripts(sessionId)).find((s) => s.sequence === 40)).toMatchObject({ kind: "speech", endSequence: null });
    expect((await repository.chunkStates(sessionId, 0, 1))[0]?.stage).toBe("speech");
    await service.tickStage("asr");
    expect((await repository.chunkStates(sessionId, 0, 1))[0]?.stage).toBe("done");
  });

  it("乱序先到指令尾巴时等待开头；静音停顿也属于同一句", async () => {
    await repository.addSpeechMark(sessionId, 200_500, 214_000);
    await chunk(42, true);
    await service.drain();
    expect(asrCalls).toHaveLength(0);
    await chunk(40, true);
    await service.drain();
    expect(asrCalls).toHaveLength(0);
    await chunk(41, false);
    await service.drain();
    expect(asrCalls).toHaveLength(1);
    expect((await repository.listTranscripts(sessionId)).find((s) => s.sequence === 40)).toMatchObject({ endSequence: 42 });
    expect(intentCalls).toHaveLength(1);
  });

  it("慢阶段不会挡下一轮 VAD，同阶段仍然只能运行一份", async () => {
    let release!: (value: []) => void;
    const slow = new Promise<[]>(resolve => { release = resolve; });
    const intentClaim = vi.spyOn(repository, "claimIntentSegments").mockReturnValueOnce(slow);
    const vadClaim = vi.spyOn(repository, "claimVadChunks");
    const job = service.tickStage("intent");
    expect(service.tickStage("intent")).toBe(job);
    await service.tickStage("vad");
    await service.tickStage("vad");
    expect(vadClaim).toHaveBeenCalledTimes(2);
    expect(intentClaim).toHaveBeenCalledTimes(1);
    release([]);
    await job;
    await service.tickStage("intent");
    expect(intentClaim).toHaveBeenCalledTimes(2);
  });

  it("积压时按住说的那句先分析", async () => {
    const now = new Date().toISOString();
    for (const [seq, text] of [[10, "早先的闲聊"], [11, "又一句闲聊"], [12, "帮我建个任务"]] as [number, string][]) {
      await repository.finishTranscript({ sessionId, sequence: seq, text, startMs: seq * 5000, endMs: seq * 5000 + 3000, provider: "t",
        status: "succeeded", error: null, kind: "speech", endSequence: null, createdAt: now, updatedAt: now });
      repository.intentStatus.set(`${sessionId}:${seq}`, "pending");
    }
    await repository.addSpeechMark(sessionId, 60_500, 63_500);   // 只盖住第 12 句（60~64 秒）
    const first = await repository.claimIntentSegments(1);
    expect(first.map((x) => x.text)).toEqual(["帮我建个任务"]);
  });

  it("识别成「嗯。」的只记语气词，不调大模型", async () => {
    asrText = "嗯。";
    await chunk(0, true); await chunk(1, false);
    await service.drain();
    expect(asrCalls).toHaveLength(1);
    expect(intentCalls).toHaveLength(0);
    expect((await repository.listTranscripts(sessionId))[0]).toMatchObject({ kind: "filler" });
  });

  it("「小沃小沃，关机」排一条软关机指令，不当成待办", async () => {
    asrText = "小沃小沃，关机。";
    await chunk(0, true); await chunk(1, false);
    await service.drain();
    expect(intentCalls).toHaveLength(0);
    expect(await repository.takeDeviceCommand("owner")).toBe("soft_off");
    expect(await repository.takeDeviceCommand("owner")).toBeNull();
  });

  it("识别和大模型的用量都记账，按单价算出金额", async () => {
    await chunk(0, true); await chunk(1, false);
    await service.drain();
    const rows = await repository.usageRollup("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z");
    const asr = rows.find((r) => r.kind === "asr")!;
    const llm = rows.find((r) => r.kind === "llm")!;
    expect(asr.audioMs).toBeGreaterThan(3000);
    expect(asr.costYuan).toBeCloseTo((asr.audioMs / 1000) * 0.00024, 6);
    expect(llm).toMatchObject({ inputTokens: 1000, outputTokens: 50, model: "qwen3.8-flash" });
    expect(llm.costYuan).toBeCloseTo((1000 * 0.8 + 50 * 2.7) / 1e6, 8);
  });

  it("意图判断会带上前几句当上文", async () => {
    asrText = "张伟说合同下周签";
    await chunk(0, true); await chunk(1, false);
    await service.drain();
    asrText = "明天提醒我给他打电话";
    await chunk(2, true); await chunk(3, false);
    await service.drain();
    expect(intentCalls[1]).toEqual({ text: "明天提醒我给他打电话", context: "张伟说合同下周签" });
  });
});

describe("专业术语词库", () => {
  it("词库拼成识别提示；空词库不加任何东西", async () => {
    const { hintText } = await import("../src/asr/index.js");
    expect(hintText([])).toBe("");
    expect(hintText(undefined)).toBe("");
    expect(hintText(["VoxMind", "ML307C", " 张伟 "])).toBe("这段录音里可能出现这些词，优先按它们识别：VoxMind、ML307C、张伟。");
    // 太长会挤占上下文：只取前 60 个
    expect(hintText(Array.from({ length: 80 }, (_, i) => `词${i}`)).split("、")).toHaveLength(60);
  });
});

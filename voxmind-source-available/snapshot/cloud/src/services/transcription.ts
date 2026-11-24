import type { FastifyBaseLogger } from "fastify";
import { opusToPcm16k, type AsrRouter } from "../asr/index.js";
import { isSpeech } from "../audio/vad.js";
import type { AudioChunk, ChunkState, QualityTier, TranscriptSegment, UserPrefs } from "../domain.js";
import { extractWithUsage, type IntentRouter } from "../intent/provider.js";
import type { EmbeddingProvider } from "../search/embeddings.js";
import { detectPowerCommand, isFiller } from "../speech/text.js";
import type { ObjectStore } from "../storage/object-store.js";
import type { Repository } from "../store/repository.js";
import { changeTitle, checkChanges, TOOL_NAMES } from "./settings-tool.js";
import type { ActionService } from "./actions.js";
import type { ExecutionService } from "./execution.js";
import type { PricingService } from "./pricing.js";
import type { SettingsService } from "./settings.js";

/* 转写流水线：人声检测 → 按句识别 → 意图判断。三段各自独立推进。
 *
 * 改之前（2026-09-19 线上实测）的三个问题：
 *   1. 一段一段串行处理，每段要等语音识别 + 大模型两次网络调用（识别单次 0.8–8.9 秒），
 *      设备每 5 秒产出一段，处理跟不上，中位延迟 5.6 分钟。
 *   2. 每段都付费识别，4110 段里 3310 段只识别出一个「嗯。」，而且每个「嗯。」都再调一次大模型。
 *   3. 每 5 秒机械切一刀，一句话跨两段就被切断，识别和意图都只看到半句。
 * 现在：静音段不送识别；相邻的人声段拼成一句（最长 30 秒）一起识别；语气词不调大模型；
 * 意图判断从识别路径上拿开，单独并行跑，还带上前几句当上文。*/

const MAX_RUN = 6;                 // 一句最多拼 6 段 = 30 秒
const RUN_IDLE_MS = 12_000;        // 下一段迟迟没上传：说明设备断网或说完了，不再等
const TRIM_PAD_MS = 300;           // 首尾裁掉静音时两边留的余量
const CONTEXT_WINDOW_MS = 90_000;  // 意图判断的上文只看最近 90 秒
const ENVELOPE_MS = 200;           // 波形每 200ms 一个点（5 秒块＝25 字节）

/** 音量包络：每 200ms 取一次峰值压到 0~255。用户在网页上拖选录音段落时看的就是它。
 *  在人声检测这一步顺手算——音频已经解码在手，不必为画波形再解一次。*/
export function envelopeOf(pcm16k: Buffer): Buffer {
  const samples = new Int16Array(pcm16k.buffer, pcm16k.byteOffset, Math.floor(pcm16k.length / 2));
  const per = 16 * ENVELOPE_MS;
  const out = Buffer.alloc(Math.ceil(samples.length / per));
  for (let i = 0, b = 0; i < samples.length; i += per, b++) {
    let peak = 0;
    for (let j = i; j < i + per && j < samples.length; j++) {
      const v = samples[j]! < 0 ? -samples[j]! : samples[j]!;
      if (v > peak) peak = v;
    }
    out[b] = Math.min(255, Math.round(peak / 128));
  }
  return out;
}

export interface PipelineDeps {
  repository: Repository;
  objects: ObjectStore;
  asr: AsrRouter;
  intent: IntentRouter;
  actions: ActionService;
  executions: ExecutionService;
  settings: SettingsService;
  pricing: PricingService;
  /** 语义检索的向量模型；没配就跳过，搜索退回逐字匹配 */
  embeddings?: EmbeddingProvider;
  logger?: FastifyBaseLogger;
  /** 识别出「小沃，关机」时调用：给设备排一条软关机指令并留审计 */
  onPowerCommand?: (userId: string, command: "off" | "on", segment: TranscriptSegment) => Promise<void>;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  // A failed lane must not release the stage's gate while its siblings are still running.
  const results = await Promise.allSettled(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  }));
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

/** 按住说话的标记最晚多久能到：设备松手后在下一轮轮询里上报，一般几秒；给足 20 秒 */
const MARK_GRACE_MS = 20_000;
const PIPELINE_STAGES = ["vad", "asr", "intent", "embedding"] as const;
type PipelineStage = typeof PIPELINE_STAGES[number] | "envelope";

export class TranscriptionService {
  private readonly stageJobs = new Map<PipelineStage, Promise<number>>();
  private readonly stageDone = new Map<PipelineStage, number>();
  constructor(private readonly deps: PipelineDeps) {}

  private async pcmOf(chunk: AudioChunk) {
    const object = await this.deps.objects.get(chunk.objectKey);
    if (!object) throw new Error("持久化音频对象不存在");
    return chunk.contentType === "audio/pcm" || chunk.contentType === "audio/L16" ? object.body : opusToPcm16k(object.body);
  }

  /** Each stage has its own gate: a slow model must not block the next VAD/ASR batch.
   * Reusing the in-flight promise also makes manual tick/drain safe alongside the worker. */
  tickStage(stage: PipelineStage): Promise<number> {
    const running = this.stageJobs.get(stage);
    if (running) return running;
    if (stage === "envelope" && PIPELINE_STAGES.some((name) => this.stageJobs.has(name) || this.stageDone.get(name) !== 0)) {
      return Promise.resolve(0);
    }
    const startedAt = Date.now();
    const job = Promise.resolve().then(() => {
      switch (stage) {
        case "vad": return this.vadStage();
        case "asr": return this.runStage();
        case "intent": return this.intentStage();
        case "embedding": return this.embeddingStage();
        case "envelope": return this.envelopeStage();
      }
    }).then((done) => {
      this.stageDone.set(stage, done);
      if (done) this.deps.logger?.info({ stage, count: done, elapsedMs: Date.now() - startedAt }, "转写阶段完成");
      return done;
    }, (error: unknown) => {
      this.stageDone.delete(stage);
      this.deps.logger?.error({ stage, elapsedMs: Date.now() - startedAt, error: String(error) }, "转写阶段失败");
      throw error;
    }).finally(() => { this.stageJobs.delete(stage); });
    this.stageJobs.set(stage, job);
    return job;
  }

  /** Deterministic full round for tests and manual catch-up; production uses independent stage loops. */
  async tick() {
    const results = await Promise.allSettled(PIPELINE_STAGES.map((stage) => this.tickStage(stage)));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    const done = results.reduce((sum, result) => sum + (result.status === "fulfilled" ? result.value : 0), 0);
    // 新音频都处理完了才给老录音补波形，别和识别抢 CPU
    return done + (done === 0 ? await this.tickStage("envelope") : 0);
  }

  /** 连推到没事可做为止（测试和积压时用） */
  async drain(maxTicks = 200) {
    let total = 0;
    for (let i = 0; i < maxTicks; i++) {
      const done = await this.tick();
      total += done;
      if (!done) break;
    }
    return total;
  }

  /* ── 第一段：人声检测（便宜，并行 4 路）── */
  private async vadStage() {
    const chunks = await this.deps.repository.claimVadChunks(16);
    await mapLimit(chunks, 4, async (chunk) => {
      try {
        const pcm = await this.pcmOf(chunk);
        const r = await isSpeech(pcm);
        await this.deps.repository.saveEnvelope(chunk.sessionId, chunk.sequence, envelopeOf(pcm));
        await this.deps.repository.saveVad(chunk.sessionId, chunk.sequence,
          { speech: r.speech, speechMs: r.speechMs, firstMs: r.firstMs, lastMs: r.lastMs });
      } catch (error) {
        // 解码或检测出错时宁可送去识别，也不能把可能有人声的一段当静音丢掉
        this.deps.logger?.warn({ sessionId: chunk.sessionId, sequence: chunk.sequence, error: String(error) }, "人声检测失败，按有人声处理");
        await this.deps.repository.saveVad(chunk.sessionId, chunk.sequence, { speech: true, speechMs: chunk.durationMs, firstMs: 0, lastMs: chunk.durationMs });
      }
    });
    return chunks.length;
  }

  /* ── 补算历史录音的波形（新流水线上线前的老数据没有包络）── */
  private async envelopeStage() {
    const chunks = await this.deps.repository.chunksMissingEnvelope(4);
    for (const chunk of chunks) {
      try {
        await this.deps.repository.saveEnvelope(chunk.sessionId, chunk.sequence, envelopeOf(await this.pcmOf(chunk)));
      } catch (error) {
        // 音频已经被删掉或者解码失败：写一个空包络，免得每轮都来重试它
        await this.deps.repository.saveEnvelope(chunk.sessionId, chunk.sequence, Buffer.alloc(0));
        this.deps.logger?.warn({ sessionId: chunk.sessionId, sequence: chunk.sequence, error: String(error) }, "补算波形失败");
      }
    }
    return chunks.length;
  }

  /* ── 第二段：把相邻的人声段拼成一句去识别（不同会话并行 3 路）── */
  private async runStage() {
    const sessions = await this.deps.repository.sessionsWithSpeech(6);
    let done = 0;
    await mapLimit(sessions, 3, async ({ sessionId, firstSequence }) => {
      const states = await this.deps.repository.chunkStates(sessionId, firstSequence, MAX_RUN + 2);
      const marks = await this.deps.repository.listSpeechMarks(sessionId);
      const first = states[0];
      const mark = first && marks.find((m) => m.startMs < first.startMs + first.durationMs && m.endMs > first.startMs);
      const run = mark ? this.pickMarkedRun(await this.deps.repository.markedChunkStates(sessionId, mark.startMs, mark.endMs), mark)
        : this.pickRun(states, marks);
      if (!run) return;
      if (!(await this.deps.repository.claimRun(sessionId, run.map((c) => c.sequence)))) return;
      await this.transcribeRun(run);
      done++;
    });
    return done;
  }

  /** A command must arrive as a complete window, including silent pauses. Do not let
   * an out-of-order tail ('开空调') execute without a missing prefix ('不要'). */
  pickMarkedRun(states: ChunkState[], mark: { startMs: number; endMs: number }): ChunkState[] | null {
    const first = states[0], last = states.at(-1);
    if (!first || !last || states.length >= 128 || mark.endMs - mark.startMs > 120_000) return null;
    if (first.startMs > mark.startMs + 200 || last.startMs + last.durationMs + 80 < mark.endMs) return null;
    if (!states.some((s) => s.stage === "speech") || states.some((s) => !["speech", "silent"].includes(s.stage))) return null;
    if (states.some((s, i) => i > 0 && (s.sequence !== states[i - 1]!.sequence + 1 ||
      s.startMs - (states[i - 1]!.startMs + states[i - 1]!.durationMs) > 80))) return null;
    return states;
  }

  /** 从会话选出的优先人声段开始，决定这一句现在能不能识别；还要等就返回 null */
  /* 两块时间上接得上才算同一句：1.0.18 起暂停再继续还是同一个会话，块号连着、钟点却可能隔了几分钟 */
  private static contiguous(a: ChunkState, b: ChunkState) {
    return b.sequence === a.sequence + 1 && b.startMs - (a.startMs + a.durationMs) <= 1500;
  }

  pickRun(states: ChunkState[], marks: { startMs: number; endMs: number }[] = []): ChunkState[] | null {
    const run: ChunkState[] = [];
    for (const s of states) {
      if (s.stage !== "speech" || run.length >= MAX_RUN) break;
      if (run.length && !TranscriptionService.contiguous(run[run.length - 1]!, s)) break;
      run.push(s);
      // The held command is complete. Do not append the next five background chunks to it.
      const end = s.startMs + s.durationMs;
      if (marks.some((m) => m.startMs < end && m.endMs > run[0]!.startMs && m.endMs <= end)) return run;
    }
    if (!run.length) return null;
    if (run.length >= MAX_RUN) return run;
    const last = run[run.length - 1]!;
    /* 按住说的命令已经整段在手（这几段盖住了按住区间的结尾）：立刻识别，不再等"下一段是不是静音"。
     * 暂停时按住录的那一小段后面根本没有下一段，以前要白等 12 秒；周围有电视声时下一段永远不是
     * 静音，以前要一直拼到 30 秒才识别。*/
    const end = last.startMs + last.durationMs;
    if (marks.some((m) => m.startMs < end && m.endMs > run[0]!.startMs && m.endMs <= end)) return run;
    const next = states.find((s) => s.sequence === last.sequence + 1);
    if (next && !TranscriptionService.contiguous(last, next)) return run;                         // 中间暂停过：这句话已经说完
    if (next && ["silent", "done", "merged", "failed", "asr"].includes(next.stage)) return run;   // 这句话说完了
    if (next && (next.stage === "pending" || next.stage === "vad")) return null;                   // 下一段马上就检测完
    // A known command tail is still uploading: never turn a partial instruction into an action.
    if (marks.some((m) => m.startMs < end && m.endMs > end)) return null;
    // 下一段还没上传：等一会儿；设备断网或者人真的不说了，就先把手里这句识别掉
    return Date.now() - Date.parse(last.uploadedAt) > RUN_IDLE_MS ? run : null;
  }

  private async transcribeRun(run: ChunkState[]) {
    const startedAt = Date.now();
    const head = run[0]!, last = run[run.length - 1]!;
    const session = await this.deps.repository.getSession(head.sessionId);
    const settings = session ? await this.deps.settings.get(session.userId) : null;
    const tier: QualityTier = settings?.tier ?? "high";
    const asr = this.deps.asr.forTier(tier);
    try {
      // 拼接，并裁掉首段开头和末段结尾的静音——识别按秒计费，静音也要钱
      const parts = await Promise.all(run.map(async (c, i) => {
        const pcm = await this.pcmOf(c);
        const from = i === 0 && c.vadFirstMs !== null ? Math.max(0, c.vadFirstMs - TRIM_PAD_MS) : 0;
        const to = i === run.length - 1 && c.vadLastMs !== null ? Math.min(c.durationMs, c.vadLastMs + TRIM_PAD_MS) : c.durationMs;
        return pcm.subarray(Math.floor((from * 16)) * 2, Math.floor(to * 16) * 2);
      }));
      const pcm = Buffer.concat(parts);
      /* 带上用户的术语词库：这一段里出现人名、产品名时，识别会优先按词库里的写法 */
      const result = await asr.transcribe(pcm, settings?.prefs.vocabulary);
      const text = result.text.trim();
      const now = new Date().toISOString();
      const segment: TranscriptSegment = {
        sessionId: head.sessionId, sequence: head.sequence, text,
        startMs: head.startMs, endMs: last.startMs + last.durationMs, provider: asr.name,
        status: "succeeded", error: null, kind: isFiller(text) ? "filler" : "speech",
        endSequence: run.length > 1 ? last.sequence : null, createdAt: now, updatedAt: now,
      };
      await this.deps.repository.finishRun(segment, run.slice(1).map((c) => c.sequence));
      const audioMs = Math.round(pcm.length / 32);
      const model = asr.model ?? asr.name;
      await this.deps.repository.recordUsage({ at: now, userId: session?.userId ?? "unknown", sessionId: head.sessionId,
        kind: "asr", feature: "asr", provider: asr.name, model, tier, audioMs, inputTokens: 0, outputTokens: 0,
        costYuan: await this.deps.pricing.asrCost(model, audioMs) });
      this.deps.logger?.info({ sessionId: head.sessionId, sequence: head.sequence, chunks: run.length, audioMs,
        elapsedMs: Date.now() - startedAt, kind: segment.kind }, "一句话识别完成");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.repository.releaseRun(head.sessionId, run.map((c) => c.sequence), asr.name, message.slice(0, 1000));
      this.deps.logger?.error({ sessionId: head.sessionId, sequence: head.sequence, error: message }, "识别失败，稍后重试");
    }
  }

  /* ── 算语义检索向量：一次一批，按意思搜靠它 ── */
  private async embeddingStage() {
    const provider = this.deps.embeddings;
    if (!provider || provider.name === "disabled") return 0;
    const segments = await this.deps.repository.claimEmbeddingSegments(16);
    if (!segments.length) return 0;
    try {
      const result = await provider.embed(segments.map((s) => s.text));
      for (const [i, segment] of segments.entries()) {
        await this.deps.repository.saveEmbedding(segment.sessionId, segment.sequence, result.vectors[i] ?? null);
      }
      const session = await this.deps.repository.getSession(segments[0]!.sessionId);
      await this.deps.repository.recordUsage({ at: new Date().toISOString(), userId: session?.userId ?? "unknown",
        sessionId: segments[0]!.sessionId, kind: "embedding", feature: "search", provider: provider.name, model: result.model,
        tier: "high", audioMs: 0, inputTokens: result.inputTokens, outputTokens: 0,
        costYuan: await this.deps.pricing.llmCost(result.model, result.inputTokens, 0) });
    } catch (error) {
      // 记一次失败次数就行：同一句最多重试 3 次，之后只是搜不到它，不影响别的
      for (const segment of segments) await this.deps.repository.saveEmbedding(segment.sessionId, segment.sequence, null);
      this.deps.logger?.warn({ error: String(error), count: segments.length }, "算语义向量失败");
    }
    return segments.length;
  }

  /* ── 第三段：唤醒指令 + 意图判断（并行 3 路）── */
  private async intentStage() {
    const segments = await this.deps.repository.claimIntentSegments(6);
    let deferred = 0;
    await mapLimit(segments, 3, async (segment) => {
      try {
        const settings = await this.deps.settings.get(segment.userId);
        // 「小沃小沃，关机」是给设备的指令，不是待办，不送大模型
        const power = detectPowerCommand(segment.text, settings.wakeWord);
        if (power) {
          await this.deps.onPowerCommand?.(segment.userId, power, segment);
          await this.deps.repository.finishIntent(segment.sessionId, segment.sequence, "done");
          return;
        }
        /* 按住说话模式：只分析用户按着 OK 键说的那几句，其余照常转写、照常能搜，
         * 但不送大模型抽意图——既省钱，也不会冒出他没打算让它办的事。*/
        const held = await this.deps.repository.hasSpeechMark(segment.sessionId, segment.startMs, segment.endMs);
        /* 按住标记是设备"松手"之后才发来的。按得久、或者按着停顿了一下，前半句可能在松手之前
         * 就转完文字到了这里——那时还没有标记，以前直接当闲聊跳过，标记后到也不会回头再看，
         * 用户的命令就这么无声地丢了。只要有"只认按住"的设置，刚转出来不到 20 秒又没标记的
         * 先放回去等一等；20 秒后还没有，才真当闲聊。全自动的照常立刻分析，不受影响。*/
        if (!held && Date.now() - Date.parse(segment.createdAt) < MARK_GRACE_MS && (settings.prefs.ai.intentMode === "push_to_talk"
            || (await this.deps.repository.listToolPolicies(segment.userId)).some((p) => p.extract === "push_to_talk"))) {
          await this.deps.repository.deferIntent(segment.sessionId, segment.sequence);
          deferred += 1;
          return;
        }
        if (settings.prefs.ai.intentMode === "push_to_talk" && !held) {
          await this.deps.repository.finishIntent(segment.sessionId, segment.sequence, "skipped");
          return;
        }
        const provider = this.deps.intent.forTier(settings.tier);
        if (provider.name === "disabled") {
          await this.deps.repository.finishIntent(segment.sessionId, segment.sequence, "skipped");
          return;
        }
        const recent = (await this.deps.repository.recentSpeech(segment.sessionId, segment.sequence, 3))
          .filter((s) => segment.startMs - s.endMs <= CONTEXT_WINDOW_MS);
        const context = recent.map((s) => s.text).join(" ") || undefined;
        const recordedAt = new Date(Date.parse(segment.sessionStartedAt) + segment.startMs).toISOString();
        const result = await extractWithUsage(provider, segment.text, recordedAt, context);
        const now = new Date().toISOString();
        await this.deps.repository.recordUsage({ at: now, userId: segment.userId, sessionId: segment.sessionId,
          kind: "llm", feature: "intent", provider: provider.name, model: result.model, tier: settings.tier, audioMs: 0,
          inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
          costYuan: await this.deps.pricing.llmCost(result.model, result.usage.inputTokens, result.usage.outputTokens) });
        for (const candidate of result.actions) {
          /* 每类动作可以单独设：完全不抽 / 只在按住确认键说的时候才抽。
           * 比如"记账"一直自动，"发消息"只有按住说的才算。*/
          const policy = await this.deps.actions.policyFor(segment.userId, candidate.tool, candidate.risk);
          if (policy.extract === "off") continue;
          if (policy.extract === "push_to_talk" && !held) continue;
          /* 改设置：只认清单里的项、取值合法的才出卡；标题直接写改成什么，设备屏上一眼看懂 */
          const setting = candidate.tool === "settings.update" ? checkChanges(candidate.args.changes, TOOL_NAMES) : null;
          if (setting && !setting.ok.length) continue;
          const args = setting ? { changes: setting.ok }
            : candidate.tool === "expense.record"
            ? expenseArgs(candidate.args, settings.prefs.expense, recordedAt)
            : candidate.args;
          if (!args) continue;          // 记账没开、或者表没配：不生成一张注定失败的卡片
          const draft = await this.deps.actions.createDraft({ ...candidate, args, sessionId: segment.sessionId, userId: segment.userId,
            evidenceStartMs: segment.startMs, evidenceEndMs: segment.endMs,
            ...(setting ? { title: changeTitle(setting), detail: setting.summary, forceConfirm: setting.loosens } : {}) });
          if (draft.status === "confirmed") await this.deps.executions.execute(draft);
        }
        await this.deps.repository.finishIntent(segment.sessionId, segment.sequence, "done");
      } catch (error) {
        this.deps.logger?.error({ sessionId: segment.sessionId, sequence: segment.sequence, error: String(error) }, "意图判断失败");
        await this.deps.repository.finishIntent(segment.sessionId, segment.sequence, "failed");
      }
    });
    /* 放回去等标记的不算"干了活"：处理循环是"这一轮干了活就马上再跑"，算进去会原地空转 */
    return segments.length - deferred;
  }
}

export function startTranscriptionWorker(service: TranscriptionService, intervalMs: number) {
  let stopped = false;
  // Separate loops, not Promise.all per round: a slow embedding or intent request cannot
  // hold the next audio batch hostage. Each stage remains single-flight inside the service.
  const loop = async (stage: PipelineStage) => {
    while (!stopped) {
      const done = await service.tickStage(stage).catch(() => 0);
      if (!done) await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  for (const stage of [...PIPELINE_STAGES, "envelope"] as const) void loop(stage);
  return () => { stopped = true; };
}

/** 记账卡片要带上写到哪张表、哪几个字段；没配好就不生成卡片。
 *  类别只认用户自己表里的那几个，模型给了别的一律算"其他"。*/
function expenseArgs(raw: Record<string, unknown>, prefs: UserPrefs["expense"], recordedAt: string) {
  if (!prefs.enabled || !prefs.appToken || !prefs.tableId) return null;
  const amount = Number(raw.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const given = String(raw.category ?? "").trim();
  const category = prefs.categories.includes(given) ? given : (prefs.categories.includes("其他") ? "其他" : prefs.categories[0] ?? "");
  /* 说"昨天花了…"时按那天记；没说就按这句话录下来的时刻 */
  const spentAt = typeof raw.spentAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.spentAt)
    ? Date.parse(`${raw.spentAt}T12:00:00.000+08:00`) : Date.parse(recordedAt);
  return { appToken: prefs.appToken, tableId: prefs.tableId, amount: Math.round(amount * 100) / 100,
    category, note: String(raw.note ?? "").slice(0, 40), atMs: spentAt, fields: prefs.fields, notify: prefs.notifyFeishu };
}

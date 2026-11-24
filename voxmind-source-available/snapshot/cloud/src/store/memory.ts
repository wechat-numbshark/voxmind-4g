import type { ShareLink, AiOutput, Automation, Reminder, Suggestion, Topic } from "../domain.js";
import type { ActionDraft, AudioChunk, ChunkStage, ChunkState, Execution, Session, SessionStatus, Timeline, ToolPolicy, TranscriptSegment, UsageEntry, UserSettings } from "../domain.js";
import type { FirmwareRelease } from "../ota/types.js";
import type { AuditEntry, AuthSession, Device, User, UserRecord } from "../identity/types.js";
import type { FavoriteFolder, ChunkEnvelope, PutChunkResult, Repository, UsageRollupRow } from "./repository.js";

export class MemoryRepository implements Repository {
  readonly sessions = new Map<string, Session>();
  readonly chunks = new Map<string, AudioChunk>();
  readonly drafts = new Map<string, ActionDraft>();
  readonly policies = new Map<string, ToolPolicy>();
  readonly executions = new Map<string, Execution>();
  readonly transcripts = new Map<string, TranscriptSegment>();
  readonly integrations = new Map<string, { encryptedConfig: string; updatedAt: string }>();
  readonly users = new Map<string, UserRecord>();
  /** 流水线阶段，键是 "sessionId:sequence" */
  readonly stages = new Map<string, { stage: ChunkStage; attempts: number; speechMs: number | null; firstMs: number | null; lastMs: number | null }>();
  readonly intentStatus = new Map<string, "pending" | "running" | "done" | "skipped" | "failed">();
  readonly usage: UsageEntry[] = [];
  readonly envelopes = new Map<string, Buffer>();
  readonly embeddings = new Map<string, number[]>();
  private readonly embeddingTries = new Map<string, number>();
  readonly settings = new Map<string, UserSettings>();
  readonly commands: { userId: string; command: string; delivered: boolean }[] = [];
  readonly config = new Map<string, unknown>();
  readonly authSessions = new Map<string, AuthSession>();
  readonly devices = new Map<string, Device & { keyHash: string }>();
  readonly firmware = new Map<string, FirmwareRelease>();
  readonly audit: AuditEntry[] = [];
  private auditSeq = 0;
  private readonly transcriptClaims = new Set<string>();
  private readonly transcriptAttempts = new Map<string, number>();

  async migrate() {}
  async close() {}

  private deletedSessions = new Set<string>();
  async createSession(input: Pick<Session, "id" | "deviceId" | "userId" | "startedAt"> & { bootId?: string | null }) {
    const now = new Date().toISOString();
    const session: Session = { ...input, bootId: input.bootId ?? null, status: "recording", endedAt: null, createdAt: now, updatedAt: now };
    this.sessions.set(session.id, session);
    return session;
  }

  async getSession(id: string) { return this.sessions.get(id) ?? null; }

  async updateSessionStatus(id: string, status: SessionStatus, endedAt: string) {
    const current = this.sessions.get(id);
    if (!current) return null;
    const next = { ...current, status, endedAt, updatedAt: new Date().toISOString() };
    this.sessions.set(id, next);
    return next;
  }

  async putChunk(chunk: AudioChunk): Promise<PutChunkResult> {
    const key = `${chunk.sessionId}:${chunk.sequence}`;
    const current = this.chunks.get(key);
    if (current) return { chunk: current, created: false };
    this.chunks.set(key, chunk);
    this.stages.set(key, { stage: "pending", attempts: 0, speechMs: null, firstMs: null, lastMs: null });
    return { chunk, created: true };
  }

  async getChunk(sessionId: string, sequence: number) {
    return this.chunks.get(`${sessionId}:${sequence}`) ?? null;
  }


  async finishTranscript(segment: TranscriptSegment) {
    const key = `${segment.sessionId}:${segment.sequence}`;
    this.transcripts.set(key, segment); this.transcriptClaims.delete(key);
    const st = this.stages.get(key); if (st) st.stage = "done";
    return segment;
  }
  async failTranscript(sessionId: string, sequence: number, provider: string, error: string) {
    const key = `${sessionId}:${sequence}`; const chunk = this.chunks.get(key);
    if (!chunk) throw new Error("音频块不存在");
    const now = new Date().toISOString();
    const segment: TranscriptSegment = { sessionId, sequence, text: "", startMs: chunk.startMs,
      endMs: chunk.startMs + chunk.durationMs, provider, status: "failed", error, kind: "speech", endSequence: null, createdAt: now, updatedAt: now };
    this.transcripts.set(key, segment); this.transcriptClaims.delete(key); return segment;
  }
  async listTranscripts(sessionId: string) {
    return [...this.transcripts.values()].filter((x) => x.sessionId === sessionId).sort((a, b) => a.sequence - b.sequence);
  }

  async listTimeline(sessionId: string): Promise<Timeline | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const chunks = [...this.chunks.values()].filter((x) => x.sessionId === sessionId).sort((a, b) => a.sequence - b.sequence);
    const drafts = [...this.drafts.values()].filter((x) => x.sessionId === sessionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const draftIds = new Set(drafts.map((x) => x.id));
    const executions = [...this.executions.values()].filter((x) => draftIds.has(x.draftId));
    const transcripts = await this.listTranscripts(sessionId);
    return { session, chunks, transcripts, drafts, executions };
  }

  async listSessions(limit: number, userId?: string) {
    return [...this.sessions.values()].filter((s) => !userId || s.userId === userId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  async createDraft(draft: ActionDraft) {
    const current = await this.getDraftByIdempotencyKey(draft.idempotencyKey);
    if (current) return current;
    this.drafts.set(draft.id, draft); return draft;
  }
  async getDraft(id: string) { return this.drafts.get(id) ?? null; }
  async getDraftByIdempotencyKey(key: string) { return [...this.drafts.values()].find((x) => x.idempotencyKey === key) ?? null; }
  async listDrafts(userId: string, status?: string) {
    return [...this.drafts.values()].filter((x) => x.userId === userId && (!status || x.status === status));
  }
  async findChunkAt(sessionId: string, ms: number) {
    return [...this.chunks.values()].filter((c) => c.sessionId === sessionId && c.startMs <= ms)
      .sort((a, b) => b.startMs - a.startMs)[0] ?? null;
  }
  /* ── 转写流水线 ── */
  private seg(sessionId: string, sequence: number, patch: Partial<TranscriptSegment>): TranscriptSegment {
    const c = this.chunks.get(`${sessionId}:${sequence}`)!; const now = new Date().toISOString();
    return { sessionId, sequence, text: "", startMs: c.startMs, endMs: c.startMs + c.durationMs, provider: "vad",
      status: "succeeded", error: null, kind: "speech", endSequence: null, createdAt: now, updatedAt: now, ...patch };
  }
  private marked(sessionId: string, startMs: number, endMs: number) {
    return this.speechMarks.some((m) => m.sessionId === sessionId && m.startMs < endMs && m.endMs > startMs);
  }
  async claimVadChunks(limit: number) {
    const pending = [...this.stages].filter(([, st]) => st.stage === "pending").map(([key, st]) => ({ st, c: this.chunks.get(key)! }))
      .sort((a, b) => Number(this.marked(b.c.sessionId, b.c.startMs, b.c.startMs + b.c.durationMs))
        - Number(this.marked(a.c.sessionId, a.c.startMs, a.c.startMs + a.c.durationMs)));
    return pending.slice(0, limit).map(({ st, c }) => { st.stage = "vad"; return c; });
  }
  async saveVad(sessionId: string, sequence: number, r: { speech: boolean; speechMs: number; firstMs: number | null; lastMs: number | null }) {
    const key = `${sessionId}:${sequence}`;
    Object.assign(this.stages.get(key)!, { stage: r.speech ? "speech" : "silent", speechMs: r.speechMs, firstMs: r.firstMs, lastMs: r.lastMs });
    if (!r.speech) { this.transcripts.set(key, this.seg(sessionId, sequence, { kind: "silent" })); this.intentStatus.set(key, "skipped"); }
  }
  async sessionsWithSpeech(limit: number) {
    const first = new Map<string, { speech: number; marked: number; uploadedAt: string }>();
    for (const [key, st] of this.stages) {
      if (!["pending", "vad", "speech", "asr"].includes(st.stage)) continue;
      const c = this.chunks.get(key)!;
      const candidate = first.get(c.sessionId) ?? { speech: Infinity, marked: Infinity, uploadedAt: c.uploadedAt };
      if (st.stage === "speech") candidate.speech = Math.min(candidate.speech, c.sequence);
      if (this.marked(c.sessionId, c.startMs, c.startMs + c.durationMs)) candidate.marked = Math.min(candidate.marked, c.sequence);
      if (c.uploadedAt < candidate.uploadedAt) candidate.uploadedAt = c.uploadedAt;
      first.set(c.sessionId, candidate);
    }
    return [...first].filter(([, candidate]) => Number.isFinite(candidate.speech))
      .sort(([, a], [, b]) => Number(Number.isFinite(b.marked)) - Number(Number.isFinite(a.marked))
        || a.uploadedAt.localeCompare(b.uploadedAt))
      .slice(0, limit).map(([sessionId, candidate]) => ({ sessionId,
        firstSequence: Number.isFinite(candidate.marked) ? candidate.marked : candidate.speech }));
  }
  async chunkStates(sessionId: string, fromSequence: number, limit: number) {
    return [...this.chunks.values()].filter((c) => c.sessionId === sessionId && c.sequence >= fromSequence)
      .sort((a, b) => a.sequence - b.sequence).slice(0, limit)
      .map((c): ChunkState => { const st = this.stages.get(`${c.sessionId}:${c.sequence}`) ?? { stage: "done" as ChunkStage, attempts: 0, speechMs: null, firstMs: null, lastMs: null };
        return { ...c, stage: st.stage, attempts: st.attempts, speechMs: st.speechMs, vadFirstMs: st.firstMs, vadLastMs: st.lastMs }; });
  }
  async claimRun(sessionId: string, sequences: number[]) {
    const sts = sequences.map((q) => this.stages.get(`${sessionId}:${q}`));
    if (!sts.length || sts.some((st) => !st || !["speech", "silent"].includes(st.stage))) return false;
    for (const st of sts) { st!.stage = "asr"; st!.attempts++; }
    return true;
  }
  async markedChunkStates(sessionId: string, startMs: number, endMs: number) {
    return (await this.chunkStates(sessionId, 0, Number.MAX_SAFE_INTEGER))
      .filter((c) => c.startMs < endMs && c.startMs + c.durationMs > startMs).slice(0, 128);
  }
  async finishRun(head: TranscriptSegment, merged: number[]) {
    const key = `${head.sessionId}:${head.sequence}`;
    this.transcripts.set(key, head); this.stages.get(key)!.stage = "done";
    this.intentStatus.set(key, head.kind === "speech" ? "pending" : "skipped");
    for (const q of merged) {
      const k = `${head.sessionId}:${q}`;
      this.transcripts.set(k, this.seg(head.sessionId, q, { kind: "merged", provider: head.provider }));
      this.stages.get(k)!.stage = "merged"; this.intentStatus.set(k, "skipped");
    }
  }
  async releaseRun(sessionId: string, sequences: number[], provider: string, error: string) {
    for (const q of sequences) {
      const k = `${sessionId}:${q}`; const st = this.stages.get(k)!;
      st.stage = st.attempts >= 5 ? "failed" : "speech";
      if (st.stage === "failed") this.transcripts.set(k, this.seg(sessionId, q, { status: "failed", error, provider }));
    }
  }
  async claimIntentSegments(limit: number) {
    const out: (TranscriptSegment & { userId: string; sessionStartedAt: string })[] = [];
    const held = (key: string) => { const t = this.transcripts.get(key)!;
      return this.speechMarks.some((m) => m.sessionId === t.sessionId && m.startMs - 1000 <= t.endMs && m.endMs + 1000 >= t.startMs); };
    const order = [...this.intentStatus].sort(([a], [b]) => Number(held(b)) - Number(held(a)));
    for (const [key, status] of order) {
      if (out.length >= limit) break;
      if (status !== "pending") continue;
      this.intentStatus.set(key, "running");
      const t = this.transcripts.get(key)!; const session = this.sessions.get(t.sessionId)!;
      out.push({ ...t, userId: session.userId, sessionStartedAt: session.startedAt });
    }
    return out;
  }
  async finishIntent(sessionId: string, sequence: number, status: "done" | "skipped" | "failed") {
    this.intentStatus.set(`${sessionId}:${sequence}`, status);
  }
  async recentSpeech(sessionId: string, beforeSequence: number, limit: number) {
    return [...this.transcripts.values()].filter((t) => t.sessionId === sessionId && t.sequence < beforeSequence && t.kind === "speech" && t.status === "succeeded")
      .sort((a, b) => a.sequence - b.sequence).slice(-limit);
  }

  /* ── 语义检索 ── */
  async claimEmbeddingSegments(limit: number) {
    return [...this.transcripts.values()]
      .filter((t) => t.kind === "speech" && t.status === "succeeded" && t.text &&
        !this.embeddings.has(`${t.sessionId}:${t.sequence}`) && (this.embeddingTries.get(`${t.sessionId}:${t.sequence}`) ?? 0) < 3)
      .slice(0, limit).map((t) => ({ sessionId: t.sessionId, sequence: t.sequence, text: t.text }));
  }
  async saveEmbedding(sessionId: string, sequence: number, vector: number[] | null) {
    const key = `${sessionId}:${sequence}`;
    this.embeddingTries.set(key, (this.embeddingTries.get(key) ?? 0) + 1);
    if (vector) this.embeddings.set(key, vector);
  }
  async semanticSearch(vector: number[], limit: number, userId?: string) {
    return [...this.embeddings.entries()]
      .map(([key, v]) => {
        const t = this.transcripts.get(key)!; const s = this.sessions.get(t.sessionId)!;
        return { t, s, score: v.reduce((sum, x, i) => sum + x * (vector[i] ?? 0), 0) };
      })
      .filter(({ s }) => s && (!userId || s.userId === userId))
      .sort((a, b) => b.score - a.score).slice(0, limit)
      .map(({ t, s, score }) => ({ sessionId: t.sessionId, sequence: t.sequence, text: t.text, startMs: t.startMs,
        endMs: t.endMs, sessionStartedAt: s.startedAt, deviceId: s.deviceId, userId: s.userId, score }));
  }

  /* ── 波形、导出与删除 ── */
  async saveEnvelope(sessionId: string, sequence: number, envelope: Buffer) {
    this.envelopes.set(`${sessionId}:${sequence}`, envelope);
  }
  async listEnvelopes(sessionId: string) {
    return [...this.chunks.values()].filter((c) => c.sessionId === sessionId).sort((a, b) => a.sequence - b.sequence)
      .map((c): ChunkEnvelope => {
        const key = `${c.sessionId}:${c.sequence}`; const t = this.transcripts.get(key); const e = this.envelopes.get(key);
        return { sequence: c.sequence, startMs: c.startMs, durationMs: c.durationMs,
          envelope: e ? e.toString("base64") : null, kind: t?.kind ?? null, text: t?.text ?? "" };
      });
  }
  async chunksMissingEnvelope(limit: number) {
    return [...this.chunks.values()].filter((c) => !this.envelopes.has(`${c.sessionId}:${c.sequence}`)).slice(0, limit);
  }
  async chunksInRange(sessionId: string, fromMs: number, toMs: number) {
    return [...this.chunks.values()].filter((c) => c.sessionId === sessionId && c.startMs < toMs && c.startMs + c.durationMs > fromMs)
      .sort((a, b) => a.sequence - b.sequence);
  }
  async deleteChunks(sessionId: string, sequences: number[]) {
    const keys: string[] = [];
    for (const q of sequences) {
      const k = `${sessionId}:${q}`; const c = this.chunks.get(k);
      if (!c) continue;
      keys.push(c.objectKey);
      this.chunks.delete(k); this.transcripts.delete(k); this.stages.delete(k); this.intentStatus.delete(k); this.envelopes.delete(k);
    }
    return keys;
  }
  async expiredChunks(beforeIso: string, userIds: string[], limit: number) {
    return [...this.chunks.values()]
      .filter((c) => c.uploadedAt < beforeIso && userIds.includes(this.sessions.get(c.sessionId)?.userId ?? "")
        && !this.favorites.has(`${this.sessions.get(c.sessionId)?.userId}:${c.sessionId}`))   // 收藏的录音不过期
      .sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt)).slice(0, limit)
      .map((c) => ({ sessionId: c.sessionId, sequence: c.sequence, objectKey: c.objectKey }));
  }

  /* ── 用量、设置、指令、配置 ── */
  async recordUsage(entry: UsageEntry) { this.usage.push(entry); }
  async usageRollup(fromIso: string, toIso: string) {
    const rows = new Map<string, UsageRollupRow>();
    for (const e of this.usage) {
      if (e.at < fromIso || e.at >= toIso) continue;
      const day = new Date(Date.parse(e.at) + 8 * 3600_000).toISOString().slice(0, 10);
      const key = [day, e.userId, e.kind, e.feature ?? "", e.model, e.tier].join("|");
      const r = rows.get(key) ?? { day, userId: e.userId, kind: e.kind, feature: e.feature ?? "", model: e.model, tier: e.tier, calls: 0, audioMs: 0, inputTokens: 0, outputTokens: 0, costYuan: 0 };
      r.calls++; r.audioMs += e.audioMs; r.inputTokens += e.inputTokens; r.outputTokens += e.outputTokens; r.costYuan += e.costYuan;
      rows.set(key, r);
    }
    return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day));
  }
  async getUserSettings(userId: string) { return this.settings.get(userId) ?? null; }
  async usersWithRetention() {
    return [...this.settings.values()].filter((s) => s.retentionDays > 0).map((s) => ({ userId: s.userId, retentionDays: s.retentionDays }));
  }
  async saveUserSettings(v: UserSettings) { this.settings.set(v.userId, v); return v; }
  readonly powerLogs: { deviceId: string; userId: string; payload: unknown }[] = [];
  async savePowerLog(deviceId: string, userId: string, payload: unknown) { this.powerLogs.push({ deviceId, userId, payload }); }
  async enqueueDeviceCommand(userId: string, command: string) { this.commands.push({ userId, command, delivered: false }); }
  async takeDeviceCommand(userId: string) {
    const c = this.commands.find((x) => x.userId === userId && !x.delivered);
    if (!c) return null;
    c.delivered = true; return c.command;
  }
  async getConfig<T>(key: string) { return (this.config.get(key) as T | undefined) ?? null; }
  async putConfig(key: string, value: unknown) { this.config.set(key, value); }

  async listPendingDrafts(limit: number) {
    return [...this.drafts.values()].filter((x) => x.status === "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit);
  }
  async listExecutableDrafts(limit: number) {
    return [...this.drafts.values()].filter((x) => x.status === "confirmed")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit);
  }
  async updateDraft(id: string, patch: Partial<ActionDraft>) {
    const current = this.drafts.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
    this.drafts.set(id, next);
    return next;
  }
  async transitionDraft(id: string, from: ActionDraft["status"], to: ActionDraft["status"], detail?: string) {
    const current = this.drafts.get(id);
    if (!current || current.status !== from) return null;
    const next = { ...current, status: to, ...(detail !== undefined ? { detail } : {}), updatedAt: new Date().toISOString() };
    this.drafts.set(id, next);
    return next;
  }

  async getToolPolicy(userId: string, tool: string) { return this.policies.get(`${userId}:${tool}`) ?? null; }
  async listToolPolicies(userId: string) {
    return [...this.policies.values()].filter((policy) => policy.userId === userId).sort((a, b) => a.tool.localeCompare(b.tool));
  }
  async upsertToolPolicy(policy: ToolPolicy) { this.policies.set(`${policy.userId}:${policy.tool}`, policy); return policy; }

  async createExecution(execution: Execution) {
    const current = [...this.executions.values()].find((x) => x.idempotencyKey === execution.idempotencyKey);
    if (current) return { execution: current, created: false };
    this.executions.set(execution.id, execution);
    return { execution, created: true };
  }
  async claimExecution(seed: Execution, deadline: string) {
    // No await in this critical section: match the database transaction's single winner semantics.
    const draft = this.drafts.get(seed.draftId) ?? null;
    const current = [...this.executions.values()].find((x) => x.idempotencyKey === seed.idempotencyKey) ?? null;
    if (!draft || draft.status !== "confirmed") return { claimed: false, execution: current, draft };
    if (current && !["queued", "failed"].includes(current.status)) return { claimed: false, execution: current, draft };
    const now = new Date().toISOString();
    if (Date.parse(deadline) <= Date.now()) {
      const expired = { ...draft, status: "expired" as const, updatedAt: now };
      this.drafts.set(draft.id, expired);
      return { claimed: false, execution: current, draft: expired };
    }
    const execution = { ...(current ?? seed), status: "running" as const, error: null, updatedAt: now };
    const next = { ...draft, status: "executing" as const, updatedAt: now };
    this.executions.set(execution.id, execution);
    this.drafts.set(draft.id, next);
    return { claimed: true, execution, draft: next };
  }
  async recoverStaleExecutions(before: string) {
    const now = new Date().toISOString();
    const error = "执行连接中断，结果未知；请核实后重新发出指令";
    let count = 0;
    for (const execution of this.executions.values()) {
      const completedDraft = this.drafts.get(execution.draftId);
      if (execution.status === "succeeded" && execution.updatedAt < before && completedDraft?.status === "executing")
        this.drafts.set(completedDraft.id, { ...completedDraft, status: "executed", updatedAt: now });
      if (!["running", "queued"].includes(execution.status) || execution.updatedAt >= before) continue;
      this.executions.set(execution.id, { ...execution, status: "unknown", error, updatedAt: now });
      const draft = this.drafts.get(execution.draftId);
      if (draft && ["executing", "confirmed"].includes(draft.status))
        this.drafts.set(draft.id, { ...draft, status: "failed", detail: error, updatedAt: now });
      count++;
    }
    return count;
  }
  async getExecution(id: string) { return this.executions.get(id) ?? null; }
  async getExecutionByDraft(draftId: string) { return [...this.executions.values()].find((x) => x.draftId === draftId) ?? null; }
  async updateExecution(id: string, patch: Partial<Execution>) {
    const current = this.executions.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
    this.executions.set(id, next);
    return next;
  }
  async searchTranscripts(query: string, limit: number, userId?: string) {
    const needle = query.toLowerCase();
    return [...this.transcripts.values()]
      .filter((t) => t.status === "succeeded" && t.kind === "speech" && t.text.toLowerCase().includes(needle))
      .map((t) => ({ t, s: this.sessions.get(t.sessionId)! }))
      .filter(({ s }) => s && (!userId || s.userId === userId))
      .sort((a, b) => b.s.startedAt.localeCompare(a.s.startedAt) || b.t.sequence - a.t.sequence)
      .slice(0, limit)
      .map(({ t, s }) => ({ sessionId: t.sessionId, sequence: t.sequence, text: t.text, startMs: t.startMs,
        endMs: t.endMs, sessionStartedAt: s.startedAt, deviceId: s.deviceId, userId: s.userId }));
  }
  async adminStats() {
    const day = Date.now() - 24 * 3600 * 1000;
    const chunks = [...this.chunks.values()];
    const recent = chunks.filter((c) => Date.parse(c.uploadedAt) > day);
    const execs = [...this.executions.values()];
    const devices = [...this.devices.values()].filter((d) => d.status === "active");
    return {
      users: this.users.size, devicesActive: devices.length,
      devicesOnline: devices.filter((d) => d.lastSeenAt && Date.parse(d.lastSeenAt) > Date.now() - 600_000).length,
      chunks24h: recent.length, audioMs24h: recent.reduce((n, c) => n + c.durationMs, 0),
      audioBytesTotal: chunks.reduce((n, c) => n + c.byteLength, 0),
      transcriptsQueued: chunks.filter((c) => !this.transcripts.has(`${c.sessionId}:${c.sequence}`)).length,
      transcriptsFailed: [...this.transcripts.values()].filter((t) => t.status === "failed").length,
      draftsPending: [...this.drafts.values()].filter((d) => d.status === "pending").length,
      executions24h: execs.filter((e) => e.status === "succeeded" && Date.parse(e.createdAt) > day).length,
      executionsFailed: execs.filter((e) => e.status === "failed" || e.status === "unknown").length,
      lastUploadAt: chunks.map((c) => c.uploadedAt).sort().at(-1) ?? null,
    };
  }
  async listRecentExecutions(limit: number) {
    return [...this.executions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
      .map((e) => { const d = this.drafts.get(e.draftId);
        return { id: e.id, draftId: e.draftId, status: e.status, provider: e.provider, externalId: e.externalId,
          error: e.error, createdAt: e.createdAt, updatedAt: e.updatedAt,
          tool: d?.tool ?? "", title: d?.title ?? "", userId: d?.userId ?? "" }; });
  }

  async countUsers() { return this.users.size; }
  async createUser(user: UserRecord) { this.users.set(user.id, user); return strip(user); }
  async getUserById(id: string) { return this.users.get(id) ?? null; }
  async getUserByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null;
  }
  async listUsers() { return [...this.users.values()].map(strip); }
  async updateUser(id: string, patch: Partial<UserRecord>) {
    const current = this.users.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
    this.users.set(id, next);
    return strip(next);
  }

  async createAuthSession(session: AuthSession) { this.authSessions.set(session.id, session); }
  async getAuthSession(id: string) {
    const s = this.authSessions.get(id);
    if (!s) return null;
    if (Date.parse(s.expiresAt) <= Date.now()) { this.authSessions.delete(id); return null; }
    return s;
  }
  async touchAuthSession(id: string, lastSeenAt: string) {
    const s = this.authSessions.get(id);
    if (s) this.authSessions.set(id, { ...s, lastSeenAt });
  }
  async deleteAuthSession(id: string) { this.authSessions.delete(id); }
  async deleteAuthSessionsForUser(userId: string) {
    for (const [id, s] of this.authSessions) if (s.userId === userId) this.authSessions.delete(id);
  }

  readonly shareLinks = new Map<string, ShareLink>();
  async createShareLink(link: ShareLink) { this.shareLinks.set(link.id, link); return link; }
  async findShareLink(tokenHash: string) { return [...this.shareLinks.values()].find((l) => l.tokenHash === tokenHash) ?? null; }
  async touchShareLink(id: string) {
    const l = this.shareLinks.get(id);
    if (l) this.shareLinks.set(id, { ...l, uses: l.uses + 1, lastUsedAt: new Date().toISOString() });
  }
  async listShareLinks(userId: string, filter: { sessionId?: string; folderId?: string } = {}) {
    return [...this.shareLinks.values()].filter((l) => l.userId === userId && (!filter.sessionId || l.sessionId === filter.sessionId)
      && (!filter.folderId || l.folderId === filter.folderId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async revokeShareLink(id: string, userId: string) {
    const l = this.shareLinks.get(id);
    if (!l || l.userId !== userId || l.revokedAt) return false;
    this.shareLinks.set(id, { ...l, revokedAt: new Date().toISOString() });
    return true;
  }

  async deleteSessions(ids: string[]) {
    const keys: string[] = [];
    const gone = new Set(ids);
    for (const [k, c] of this.chunks) if (gone.has(c.sessionId)) { keys.push(c.objectKey); this.chunks.delete(k); }
    for (const [k, t] of this.transcripts) if (gone.has(t.sessionId)) this.transcripts.delete(k);
    for (const [k, t] of this.topics) if (gone.has(t.sessionId)) this.topics.delete(k);
    for (const id of ids) this.deletedSessions.add(id);
    for (const [k, l] of this.shareLinks) if (l.sessionId && gone.has(l.sessionId) && !l.revokedAt) this.shareLinks.set(k, { ...l, revokedAt: new Date().toISOString() });
    return keys;
  }

  readonly favorites = new Map<string, string>();            // "userId:sessionId" → 加星时间
  readonly favFolders = new Map<string, FavoriteFolder>();
  readonly favItems = new Set<string>();                      // "folderId:sessionId"
  readonly favExclusions = new Set<string>();                 // "folderId:sessionId"：手动拿出来过，自动规则不再放回
  async setFolderKeywords(userId: string, id: string, keywords: string[]) {
    const f = this.favFolders.get(id);
    if (!f || f.userId !== userId) return false;
    this.favFolders.set(id, { ...f, keywords });
    return true;
  }
  async applyFolderRules(userId?: string) {
    let added = 0;
    for (const f of this.favFolders.values()) {
      if (!f.keywords.length || (userId && f.userId !== userId)) continue;
      const words = f.keywords.map((k) => k.toLowerCase());
      for (const s of this.sessions.values()) {
        const key = `${f.id}:${s.id}`;
        if (s.userId !== f.userId || this.deletedSessions.has(s.id) || this.favItems.has(key) || this.favExclusions.has(key)) continue;
        const texts = [...[...this.transcripts.values()].filter((t) => t.sessionId === s.id).map((t) => t.text),
          ...[...this.topics.values()].filter((t) => t.sessionId === s.id).flatMap((t) => [t.title, t.summary])].map((x) => x.toLowerCase());
        if (!texts.some((x) => words.some((w) => x.includes(w)))) continue;
        await this.setFavorite(f.userId, s.id, true);
        this.favItems.add(key);
        added++;
      }
    }
    return added;
  }
  async listFavorites(userId: string) {
    const folders = [...this.favFolders.values()].filter((f) => f.userId === userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const items = [...this.favorites].filter(([k]) => k.startsWith(`${userId}:`))
      .map(([k, at]) => ({ sessionId: k.slice(userId.length + 1), favoritedAt: at }))
      .filter((x) => !this.deletedSessions.has(x.sessionId))
      .map((x) => ({ ...x, folderIds: folders.filter((f) => this.favItems.has(`${f.id}:${x.sessionId}`)).map((f) => f.id) }))
      .sort((a, b) => b.favoritedAt.localeCompare(a.favoritedAt));
    return { folders, items };
  }
  async setFavorite(userId: string, sessionId: string, on: boolean) {
    const key = `${userId}:${sessionId}`;
    if (on) { if (!this.favorites.has(key)) this.favorites.set(key, new Date().toISOString()); return; }
    this.favorites.delete(key);
    for (const f of this.favFolders.values()) if (f.userId === userId) { this.favItems.delete(`${f.id}:${sessionId}`); this.favExclusions.add(`${f.id}:${sessionId}`); }
  }
  async createFavoriteFolder(folder: FavoriteFolder) { this.favFolders.set(folder.id, folder); return folder; }
  async renameFavoriteFolder(userId: string, id: string, name: string) {
    const f = this.favFolders.get(id);
    if (!f || f.userId !== userId) return false;
    this.favFolders.set(id, { ...f, name });
    return true;
  }
  async deleteFavoriteFolder(userId: string, id: string) {
    const f = this.favFolders.get(id);
    if (!f || f.userId !== userId) return false;
    this.favFolders.delete(id);
    for (const [k, l] of this.shareLinks) if (l.folderId === id) this.shareLinks.delete(k);
    for (const k of [...this.favItems]) if (k.startsWith(`${id}:`)) this.favItems.delete(k);
    return true;
  }
  async setFolderItem(userId: string, folderId: string, sessionId: string, on: boolean) {
    const f = this.favFolders.get(folderId);
    if (!f || f.userId !== userId) return false;
    if (on) { await this.setFavorite(userId, sessionId, true); this.favItems.add(`${folderId}:${sessionId}`); this.favExclusions.delete(`${folderId}:${sessionId}`); }
    else { this.favItems.delete(`${folderId}:${sessionId}`); this.favExclusions.add(`${folderId}:${sessionId}`); }
    return true;
  }

  async listSessionSummaries(limit: number, userId?: string, ids?: string[]) {
    return [...this.sessions.values()].filter((s) => (!userId || s.userId === userId) && !this.deletedSessions.has(s.id) && (!ids || ids.includes(s.id)))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit)
      .map((s) => {
        const chunks = [...this.chunks.values()].filter((c) => c.sessionId === s.id);
        const topics = [...this.topics.values()].filter((t) => t.sessionId === s.id).sort((a, b) => a.startMs - b.startMs);
        return { id: s.id, deviceId: s.deviceId, startedAt: s.startedAt, status: s.status,
          durationMs: chunks.reduce((n, c) => n + c.durationMs, 0),
          lastUploadAt: chunks.map((c) => c.uploadedAt).sort().at(-1) ?? null,
          topicCount: topics.length, title: topics[0]?.title ?? null, bootId: s.bootId ?? null,
          actionCount: [...this.drafts.values()].filter((d) => d.sessionId === s.id).length,
          sentenceCount: [...this.transcripts.values()].filter((t) => t.sessionId === s.id && t.kind === "speech" && t.status === "succeeded").length };
      });
  }

  /* ── 按住说话的标记 ─────────────────────────────────────────── */
  readonly speechMarks: { sessionId: string; startMs: number; endMs: number; at?: number }[] = [];
  async deferIntent(sessionId: string, sequence: number) { this.intentStatus.set(`${sessionId}:${sequence}`, "pending"); }
  async addSpeechMark(sessionId: string, startMs: number, endMs: number) {
    this.speechMarks.push({ sessionId, startMs, endMs, at: Date.now() });
  }
  /* 内存版只看有没有出草稿，用于测试；转写进度的判断在 Postgres 版 */
  async latestTalkStatus(userId: string) {
    const mine = this.speechMarks.filter((m) => this.sessions.get(m.sessionId)?.userId === userId && Date.now() - (m.at ?? 0) < 300_000);
    const m = mine[mine.length - 1];
    if (!m) return null;
    const hit = [...this.drafts.values()].some((d) => d.sessionId === m.sessionId && d.evidenceStartMs !== null
      && d.evidenceStartMs <= m.endMs + 1000 && (d.evidenceEndMs ?? d.evidenceStartMs) >= m.startMs - 1000);
    return { sessionId: m.sessionId, startMs: m.startMs, state: hit ? "done" as const : "busy" as const };
  }
  async listSpeechMarks(sessionId: string) {
    return this.speechMarks.filter((m) => m.sessionId === sessionId).map(({ startMs, endMs }) => ({ startMs, endMs }));
  }
  async hasSpeechMark(sessionId: string, startMs: number, endMs: number) {
    return this.speechMarks.some((m) => m.sessionId === sessionId && m.startMs - 1000 <= endMs && m.endMs + 1000 >= startMs);
  }

  /* ── AI 主题与产出物 ────────────────────────────────────────── */
  readonly topics = new Map<string, Topic>();
  readonly outputs = new Map<string, AiOutput>();
  readonly topicsUntil = new Map<string, number>();
  async listTopics(sessionId: string) {
    return [...this.topics.values()].filter((t) => t.sessionId === sessionId).sort((a, b) => a.startMs - b.startMs);
  }
  async getTopic(id: string) { return this.topics.get(id) ?? null; }
  async listTopicLabels(userId: string) {
    const groups = new Map<string, { label: string; count: number; lastAt: string }>();
    for (const t of this.topics.values()) {
      if (t.userId !== userId || !t.label) continue;
      const session = this.sessions.get(t.sessionId);
      const at = new Date(Date.parse(session?.startedAt ?? t.createdAt) + t.startMs).toISOString();
      const hit = groups.get(t.label) ?? { label: t.label, count: 0, lastAt: at };
      hit.count++;
      if (at > hit.lastAt) hit.lastAt = at;
      groups.set(t.label, hit);
    }
    return [...groups.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }
  async topicsByLabel(userId: string, label: string, limit: number) {
    return [...this.topics.values()].filter((t) => t.userId === userId && t.label === label)
      .map((t) => ({ ...t, sessionStartedAt: this.sessions.get(t.sessionId)?.startedAt ?? t.createdAt }))
      .sort((a, b) => b.sessionStartedAt.localeCompare(a.sessionStartedAt) || b.startMs - a.startMs)
      .slice(0, limit);
  }

  async createTopic(t: Topic) { this.topics.set(t.id, t); return t; }
  async updateTopic(id: string, patch: Partial<Topic>) {
    const current = this.topics.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, id: current.id };
    this.topics.set(id, next);
    return next;
  }
  async deleteTopic(id: string) { this.topics.delete(id); }
  async replaceAiTopics(sessionId: string, fromMs: number, toMs: number, topics: Topic[]) {
    for (const t of [...this.topics.values()])
      if (t.sessionId === sessionId && t.source === "ai" && t.startMs >= fromMs && t.startMs < toMs) this.topics.delete(t.id);
    for (const t of topics) this.topics.set(t.id, t);
  }
  async topicsForSessions(ids: string[]) {
    return [...this.topics.values()].filter((t) => ids.includes(t.sessionId)).sort((a, b) => a.startMs - b.startMs);
  }
  async searchTopics(query: string, limit: number, userId?: string) {
    const q = query.toLowerCase();
    return [...this.topics.values()]
      .filter((t) => (!userId || t.userId === userId) && (t.title.toLowerCase().includes(q) || t.summary.toLowerCase().includes(q)))
      .slice(0, limit).map((t) => ({ ...t, sessionStartedAt: this.sessions.get(t.sessionId)?.startedAt ?? t.createdAt }));
  }
  async topicCandidates() {
    const out = [];
    for (const s of this.sessions.values()) {
      const speech = [...this.transcripts.values()].filter((t) => t.sessionId === s.id && t.kind === "speech" && t.status === "succeeded");
      if (!speech.length) continue;
      const until = this.topicsUntil.get(s.id) ?? 0;
      const end = Math.max(...speech.map((t) => t.endMs));
      if (end <= until) continue;
      const uploads = [...this.chunks.values()].filter((c) => c.sessionId === s.id).map((c) => c.uploadedAt).sort();
      out.push({ sessionId: s.id, userId: s.userId, startedAt: s.startedAt, topicsUntilMs: until, speechEndMs: end,
        newSpeechMs: speech.filter((t) => t.startMs >= until).reduce((n, t) => n + t.endMs - t.startMs, 0),
        lastUploadAt: uploads.at(-1) ?? s.startedAt });
    }
    return out;
  }
  async setTopicsUntil(sessionId: string, ms: number) { this.topicsUntil.set(sessionId, ms); }
  /* ── 提醒 ── */
  private reminders = new Map<string, Reminder>();
  async createReminder(r: Reminder) { this.reminders.set(r.id, r); return r; }
  async dueReminders(nowIso: string, limit: number) {
    return [...this.reminders.values()].filter((r) => r.status === "pending" && r.remindAt <= nowIso)
      .sort((a, b) => a.remindAt.localeCompare(b.remindAt)).slice(0, limit);
  }
  async activeReminder(userId: string, nowIso: string, notBeforeIso = "") {
    const candidates = [...this.reminders.values()]
      .filter((r) => r.userId === userId && (r.status === "sent" || r.status === "pending") && r.remindAt <= nowIso
        && r.remindAt >= notBeforeIso)
      .sort((a, b) => (a.status === "sent" ? 0 : 1) - (b.status === "sent" ? 0 : 1) || a.remindAt.localeCompare(b.remindAt));
    return candidates[0] ?? null;
  }
  async getReminder(id: string) { return this.reminders.get(id) ?? null; }
  async updateReminder(id: string, patch: Partial<Reminder>) {
    const current = this.reminders.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.reminders.set(id, next);
    return next;
  }
  async listReminders(userId: string, limit: number) {
    return [...this.reminders.values()].filter((r) => r.userId === userId)
      .sort((a, b) => b.remindAt.localeCompare(a.remindAt)).slice(0, limit);
  }
  async cancelRemindersForDraft(draftId: string) {
    let n = 0;
    for (const [id, r] of this.reminders) {
      if (r.draftId === draftId && (r.status === "pending" || r.status === "sent")) {
        this.reminders.set(id, { ...r, status: "cancelled" }); n++;
      }
    }
    return n;
  }

  /* ── 建议 ── */
  private suggestions = new Map<string, Suggestion>();
  async createSuggestions(list: Suggestion[]) { for (const s of list) this.suggestions.set(s.id, s); return list; }
  async listSuggestions(userId: string, filter: { status?: string; sessionId?: string; topicIds?: string[]; sinceIso?: string; limit?: number }) {
    return [...this.suggestions.values()]
      .filter((s) => s.userId === userId
        && (!filter.status || s.status === filter.status)
        && (!filter.sessionId || s.sessionId === filter.sessionId)
        && (!filter.topicIds || (s.topicId !== null && filter.topicIds.includes(s.topicId)))
        && (!filter.sinceIso || s.createdAt >= filter.sinceIso))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, filter.limit ?? 100);
  }
  async getSuggestion(id: string) { return this.suggestions.get(id) ?? null; }
  async updateSuggestion(id: string, patch: Partial<Suggestion>) {
    const current = this.suggestions.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.suggestions.set(id, next);
    return next;
  }

  /* ── 自动化 ── */
  private automations = new Map<string, Automation>();
  async createAutomation(a: Automation) { this.automations.set(a.id, a); return a; }
  async listAutomations(userId: string) {
    return [...this.automations.values()].filter((a) => a.userId === userId).sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
  }
  async getAutomation(id: string) { return this.automations.get(id) ?? null; }
  async updateAutomation(id: string, patch: Partial<Automation>) {
    const current = this.automations.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.automations.set(id, next);
    return next;
  }
  async deleteAutomation(id: string) { return this.automations.delete(id); }
  async dueAutomations(nowIso: string, limit: number) {
    return [...this.automations.values()].filter((a) => a.enabled && a.nextRunAt <= nowIso)
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt)).slice(0, limit);
  }

  async createOutput(o: AiOutput) { this.outputs.set(o.id, o); return o; }
  async getOutput(id: string) { return this.outputs.get(id) ?? null; }
  async listOutputs(ids: string[]) {
    return [...this.outputs.values()].filter((o) => ids.includes(o.targetId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /* ── 设备屏幕的回执与今日概况 ───────────────────────────────── */
  readonly deviceDismissed = new Set<string>();
  async deviceFeedDrafts(userId: string, sinceIso: string, receiptsSinceIso: string) {
    return [...this.drafts.values()]
      .filter((d) => d.userId === userId && (d.createdAt >= sinceIso ||
        ((d.status === "executed" || d.status === "failed") && d.updatedAt >= receiptsSinceIso && !this.deviceDismissed.has(d.id))))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 40)
      .map((d) => ({ ...d, dismissed: this.deviceDismissed.has(d.id) }));
  }
  async deviceFeedVersion(userId: string, sinceIso: string) {
    const mine = [...this.drafts.values()].filter((d) => d.userId === userId && d.updatedAt >= sinceIso);
    const at = mine.reduce((m, d) => (d.updatedAt > m ? d.updatedAt : m), "");
    return `${mine.length}-${at}-${mine.filter((d) => this.deviceDismissed.has(d.id)).length}`;
  }
  async dismissDraftOnDevice(userId: string, id: string) {
    const d = this.drafts.get(id);
    if (!d || d.userId !== userId || this.deviceDismissed.has(id)) return false;
    this.deviceDismissed.add(id);
    this.drafts.set(id, { ...d, updatedAt: new Date().toISOString() });
    return true;
  }
  async dayTotals(userId: string, sinceIso: string) {
    const sessions = new Set([...this.sessions.values()].filter((s) => s.userId === userId).map((s) => s.id));
    const recordedMs = [...this.chunks.values()].filter((c) => sessions.has(c.sessionId) && c.uploadedAt >= sinceIso)
      .reduce((sum, c) => sum + c.durationMs, 0);
    const sentences = [...this.transcripts.values()].filter((t) => sessions.has(t.sessionId) && t.createdAt >= sinceIso
      && t.kind === "speech" && t.status === "succeeded").length;
    return { recordedMs, sentences };
  }

  /* ── 固件与远程升级 ─────────────────────────────────────────── */
  async createFirmware(release: FirmwareRelease) {
    this.firmware.set(release.id, release);
    return release;
  }
  async listFirmware() {
    return [...this.firmware.values()].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }
  async getFirmware(id: string) { return this.firmware.get(id) ?? null; }
  async updateFirmware(id: string, patch: Partial<FirmwareRelease>) {
    const current = this.firmware.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, id: current.id };
    this.firmware.set(id, next);
    return next;
  }
  async deleteFirmware(id: string) { this.firmware.delete(id); }

  async createDevice(device: Device, keyHash: string) {
    this.devices.set(device.id, { ...device, keyHash });
    return device;
  }
  async getDevice(id: string) {
    const d = this.devices.get(id);
    return d ? stripKey(d) : null;
  }
  async getDeviceByKeyHash(keyHash: string) {
    const d = [...this.devices.values()].find((x) => x.keyHash === keyHash);
    return d ? stripKey(d) : null;
  }
  async listDevices(userId?: string) {
    return [...this.devices.values()].filter((d) => !userId || d.userId === userId).map(stripKey);
  }
  async updateDevice(id: string, patch: Partial<Device>) {
    const current = this.devices.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, id: current.id };
    this.devices.set(id, next);
    return stripKey(next);
  }

  async appendAudit(entry: Omit<AuditEntry, "id">) {
    this.audit.unshift({ ...entry, id: String(++this.auditSeq) });
  }
  async listAudit(limit: number, filter?: { actorId?: string; action?: string }) {
    return this.audit
      .filter((e) => (!filter?.actorId || e.actorId === filter.actorId) &&
                     (!filter?.action || e.action === filter.action))
      .slice(0, limit);
  }

  async getIntegration(userId: string, provider: string) { return this.integrations.get(`${userId}:${provider}`) ?? null; }
  async upsertIntegration(userId: string, provider: string, encryptedConfig: string) {
    this.integrations.set(`${userId}:${provider}`, { encryptedConfig, updatedAt: new Date().toISOString() });
  }
}

function strip(u: UserRecord): User { const { passwordHash: _ignored, ...rest } = u; return rest; }
function stripKey(d: Device & { keyHash: string }): Device { const { keyHash: _ignored, ...rest } = d; return rest; }

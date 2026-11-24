import type { AiOutput, Topic } from "../domain.js";
import type { ShareLink } from "../domain.js";
import type { ActionDraft, Automation, AudioChunk, ChunkState, Execution, QualityTier, Reminder, Session, SessionStatus, Suggestion, Timeline, ToolPolicy, TranscriptSegment, UsageEntry, UserSettings } from "../domain.js";
import type { FirmwareRelease } from "../ota/types.js";
import type { AuditEntry, AuthSession, Device, User, UserRecord } from "../identity/types.js";

export interface ChunkEnvelope {
  sequence: number;
  startMs: number;
  durationMs: number;
  /** base64 的包络字节；历史数据还没补算时为 null */
  envelope: string | null;
  kind: string | null;
  text: string;
}

export interface UsageRollupRow {
  day: string;          // 北京时间 YYYY-MM-DD
  userId: string;
  kind: "asr" | "llm" | "embedding";
  feature: string;      // 空串＝加这一列之前记的账
  model: string;
  tier: QualityTier;
  calls: number;
  audioMs: number;
  inputTokens: number;
  outputTokens: number;
  costYuan: number;
}

/** keywords：自动归档规则——转写或主题里提到其中任何一个词的录音自动收进来；空＝不自动 */
export interface FavoriteFolder { id: string; userId: string; name: string; createdAt: string; keywords: string[] }
export interface FavoriteItem { sessionId: string; folderIds: string[]; favoritedAt: string }

export interface SessionSummary {
  id: string;
  deviceId: string;
  startedAt: string;
  status: string;
  durationMs: number;
  lastUploadAt: string | null;
  topicCount: number;
  title: string | null;          // 第一个主题的标题；没拆主题就是 null
  bootId: string | null;         // 开机号，同一次开机的几段（中间暂停过）相同
  actionCount: number;
  sentenceCount: number;
}

export interface SearchHit {
  sessionId: string;
  sequence: number;
  text: string;
  startMs: number;
  endMs: number;
  sessionStartedAt: string;
  deviceId: string;
  userId: string;
}

export interface AdminStats {
  users: number;
  devicesActive: number;
  devicesOnline: number;
  chunks24h: number;
  audioMs24h: number;
  audioBytesTotal: number;
  transcriptsQueued: number;
  transcriptsFailed: number;
  draftsPending: number;
  executions24h: number;
  executionsFailed: number;
  lastUploadAt: string | null;
}

export interface ExecutionRow {
  id: string;
  draftId: string;
  status: string;
  provider: string;
  externalId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  tool: string;
  title: string;
  userId: string;
}

export interface PutChunkResult {
  chunk: AudioChunk;
  created: boolean;
}

export interface Repository {
  migrate(): Promise<void>;
  close(): Promise<void>;
  createSession(input: Pick<Session, "id" | "deviceId" | "userId" | "startedAt"> & { bootId?: string | null }): Promise<Session>;
  /** 删录音（按段、按天、按开机）：音频、转写、主题、按住标记都删，会话标记已删、列表里不再出现。
   *  动作和建议记录保留（它们挂在会话上，硬删会级联删掉＝篡改历史）。返回要删的音频对象键 */
  deleteSessions(ids: string[]): Promise<string[]>;
  createShareLink(link: ShareLink): Promise<ShareLink>;
  /** 按密钥的哈希找；过期、撤销的也返回，由调用方判断 */
  findShareLink(tokenHash: string): Promise<ShareLink | null>;
  touchShareLink(id: string): Promise<void>;
  listShareLinks(userId: string, filter?: { sessionId?: string; folderId?: string }): Promise<ShareLink[]>;
  revokeShareLink(id: string, userId: string): Promise<boolean>;
  getSession(id: string): Promise<Session | null>;
  updateSessionStatus(id: string, status: SessionStatus, endedAt: string): Promise<Session | null>;
  putChunk(chunk: AudioChunk): Promise<PutChunkResult>;
  getChunk(sessionId: string, sequence: number): Promise<AudioChunk | null>;
  /** 覆盖某个会话内时间点的那一块，用于从卡片的原话跳回原声 */
  findChunkAt(sessionId: string, ms: number): Promise<AudioChunk | null>;
  finishTranscript(segment: TranscriptSegment): Promise<TranscriptSegment>;
  failTranscript(sessionId: string, sequence: number, provider: string, error: string): Promise<TranscriptSegment>;
  listTranscripts(sessionId: string): Promise<TranscriptSegment[]>;
  listTimeline(sessionId: string): Promise<Timeline | null>;
  /** userId 省略＝全部用户（只有管理员能这么查） */
  listSessions(limit: number, userId?: string): Promise<Session[]>;
  createDraft(draft: ActionDraft): Promise<ActionDraft>;
  getDraft(id: string): Promise<ActionDraft | null>;
  getDraftByIdempotencyKey(key: string): Promise<ActionDraft | null>;
  listDrafts(userId: string, status?: string): Promise<ActionDraft[]>;
  listExecutableDrafts(limit: number): Promise<ActionDraft[]>;
  /** 所有用户的待确认卡片，用于超时作废扫描 */
  listPendingDrafts(limit: number): Promise<ActionDraft[]>;
  updateDraft(id: string, patch: Partial<ActionDraft>): Promise<ActionDraft | null>;
  /** Compare-and-set only the state fields; a delayed confirmation/cancellation must not undo execution. */
  transitionDraft(id: string, from: ActionDraft["status"], to: ActionDraft["status"], detail?: string): Promise<ActionDraft | null>;
  getToolPolicy(userId: string, tool: string): Promise<ToolPolicy | null>;
  listToolPolicies(userId: string): Promise<ToolPolicy[]>;
  upsertToolPolicy(policy: ToolPolicy): Promise<ToolPolicy>;
  createExecution(execution: Execution): Promise<{ execution: Execution; created: boolean }>;
  /** Atomically claim a confirmed draft and its execution. Only the winner may call the provider. */
  claimExecution(execution: Execution, deadline: string): Promise<{ claimed: boolean; execution: Execution | null; draft: ActionDraft | null }>;
  /** Interrupted calls have unknown outcomes, never an implicit retry. */
  recoverStaleExecutions(before: string): Promise<number>;
  getExecution(id: string): Promise<Execution | null>;
  getExecutionByDraft(draftId: string): Promise<Execution | null>;
  updateExecution(id: string, patch: Partial<Execution>): Promise<Execution | null>;
  getIntegration(userId: string, provider: string): Promise<{ encryptedConfig: string; updatedAt: string } | null>;
  upsertIntegration(userId: string, provider: string, encryptedConfig: string): Promise<void>;

  /* ── 转写流水线：人声检测 → 按句识别 → 意图 ──────────────────── */
  /** 取一批还没做人声检测的块（pending → vad） */
  claimVadChunks(limit: number): Promise<AudioChunk[]>;
  /** 静音块直接记一条 silent 段落并结束；有人声的进入 speech 等着拼句 */
  saveVad(sessionId: string, sequence: number, result: { speech: boolean; speechMs: number; firstMs: number | null; lastMs: number | null }): Promise<void>;
  /** 有待识别人声的会话：优先返回按住区间的首个未完成块，否则最早 speech 块。
   * 按住区间前缀还在 pending/vad/asr 时也返回此前缀，防止截掉命令开头。 */
  sessionsWithSpeech(limit: number): Promise<{ sessionId: string; firstSequence: number }[]>;
  chunkStates(sessionId: string, fromSequence: number, limit: number): Promise<ChunkState[]>;
  markedChunkStates(sessionId: string, startMs: number, endMs: number): Promise<ChunkState[]>;
  /** 原子地把整句 speech/silent 块锁成 asr；有任何一块状态不对就整体放弃 */
  claimRun(sessionId: string, sequences: number[]): Promise<boolean>;
  /** 一句话识别完：首块存文本，其余块记 merged */
  finishRun(head: TranscriptSegment, mergedSequences: number[]): Promise<void>;
  /** 识别失败：退回 speech 重试，超过 5 次记 failed */
  releaseRun(sessionId: string, sequences: number[], provider: string, error: string): Promise<void>;
  claimIntentSegments(limit: number): Promise<(TranscriptSegment & { userId: string; sessionStartedAt: string })[]>;
  finishIntent(sessionId: string, sequence: number, status: "done" | "skipped" | "failed"): Promise<void>;
  /** 同一会话里这句之前的几句话，给意图判断当上文 */
  recentSpeech(sessionId: string, beforeSequence: number, limit: number): Promise<TranscriptSegment[]>;

  /* ── 语义检索 ───────────────────────────────────────────────── */
  /** 还没算向量的句子（文本非空的 speech 段），失败超过 3 次的不再重试 */
  claimEmbeddingSegments(limit: number): Promise<{ sessionId: string; sequence: number; text: string }[]>;
  saveEmbedding(sessionId: string, sequence: number, vector: number[] | null): Promise<void>;
  /** 按向量找最接近的句子。向量已归一化，相似度就是点积，范围 -1~1 */
  semanticSearch(vector: number[], limit: number, userId?: string): Promise<(SearchHit & { score: number })[]>;

  /* ── 波形、导出与删除 ───────────────────────────────────────── */
  /** 音量包络：每 200ms 一个字节（0~255），画波形用，不必下载音频 */
  saveEnvelope(sessionId: string, sequence: number, envelope: Buffer): Promise<void>;
  listEnvelopes(sessionId: string): Promise<ChunkEnvelope[]>;
  /** 还没算过包络的块（历史数据补算用） */
  chunksMissingEnvelope(limit: number): Promise<AudioChunk[]>;
  /** 覆盖 [fromMs, toMs) 的音频块 */
  chunksInRange(sessionId: string, fromMs: number, toMs: number): Promise<AudioChunk[]>;
  /** 删除这些块（连同转写）。返回被删掉的对象键，调用方负责删文件 */
  deleteChunks(sessionId: string, sequences: number[]): Promise<string[]>;
  /** 早于某时刻、属于这些用户的块，保留期清理用 */
  expiredChunks(beforeIso: string, userIds: string[], limit: number): Promise<{ sessionId: string; sequence: number; objectKey: string }[]>;

  /* ── 用量与成本 ─────────────────────────────────────────────── */
  recordUsage(entry: UsageEntry): Promise<void>;
  usageRollup(fromIso: string, toIso: string): Promise<UsageRollupRow[]>;

  /* ── 用户设置、设备指令、系统配置 ───────────────────────────── */
  getUserSettings(userId: string): Promise<UserSettings | null>;
  /** 设了保留期的用户，定时清理用 */
  usersWithRetention(): Promise<{ userId: string; retentionDays: number }[]>;
  saveUserSettings(settings: UserSettings): Promise<UserSettings>;
  enqueueDeviceCommand(userId: string, command: string): Promise<void>;
  /** 设备上传的一份耗电测量记录（原样存 JSON，分析时直接查库） */
  savePowerLog(deviceId: string, userId: string, payload: unknown): Promise<void>;
  /** 取出并标记送达最早一条未送达的指令 */
  takeDeviceCommand(userId: string): Promise<string | null>;
  getConfig<T>(key: string): Promise<T | null>;
  putConfig(key: string, value: unknown): Promise<void>;

  /* ── 检索与统计 ─────────────────────────────────────────────── */
  /** 子串搜索转写文本（ILIKE，没有中文分词索引）。userId 省略＝全部用户 */
  searchTranscripts(query: string, limit: number, userId?: string): Promise<SearchHit[]>;
  adminStats(): Promise<AdminStats>;
  listRecentExecutions(limit: number): Promise<ExecutionRow[]>;

  /* ── 账号 ───────────────────────────────────────────────────── */
  countUsers(): Promise<number>;
  createUser(user: UserRecord): Promise<User>;
  getUserById(id: string): Promise<UserRecord | null>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  listUsers(): Promise<User[]>;
  updateUser(id: string, patch: Partial<UserRecord>): Promise<User | null>;

  /* ── 登录会话 ───────────────────────────────────────────────── */
  createAuthSession(session: AuthSession): Promise<void>;
  getAuthSession(id: string): Promise<AuthSession | null>;
  touchAuthSession(id: string, lastSeenAt: string): Promise<void>;
  deleteAuthSession(id: string): Promise<void>;
  /** 停用账号或改密码时调用：让那个人已经发出去的所有会话立刻失效 */
  deleteAuthSessionsForUser(userId: string): Promise<void>;

  /* ── 设备 ───────────────────────────────────────────────────── */
  createDevice(device: Device, keyHash: string): Promise<Device>;
  getDevice(id: string): Promise<Device | null>;
  /** 按密钥哈希查。明文密钥只在发放的那一刻存在过，库里永远只有哈希 */
  getDeviceByKeyHash(keyHash: string): Promise<Device | null>;
  listDevices(userId?: string): Promise<Device[]>;
  updateDevice(id: string, patch: Partial<Device>): Promise<Device | null>;

  /** 录音列表要的：每次录音的时长、主题数、第一个主题标题、动作数。
   *  列表页不该为了显示时长去拉整条时间线（一次几 MB）。*/
  /** ids 给了就只查这几段（收藏里可能有很早的录音，不在最近 200 段里） */
  listSessionSummaries(limit: number, userId?: string, ids?: string[]): Promise<SessionSummary[]>;
  /* ── 收藏：录音（会话）可以加星，也可以放进用户自己建的文件夹；一段可以同时在几个文件夹里 ── */
  listFavorites(userId: string): Promise<{ folders: FavoriteFolder[]; items: FavoriteItem[] }>;
  setFavorite(userId: string, sessionId: string, on: boolean): Promise<void>;
  createFavoriteFolder(folder: FavoriteFolder): Promise<FavoriteFolder>;
  renameFavoriteFolder(userId: string, id: string, name: string): Promise<boolean>;
  deleteFavoriteFolder(userId: string, id: string): Promise<boolean>;
  /** 放进/拿出文件夹；放进去的同时会加星 */
  setFolderItem(userId: string, folderId: string, sessionId: string, on: boolean): Promise<boolean>;
  setFolderKeywords(userId: string, id: string, keywords: string[]): Promise<boolean>;
  /** 按自动归档规则把新提到关键词的录音收进文件夹；用户手动拿出来过的不再放回。userId 省略＝所有用户。返回新放进去几段 */
  applyFolderRules(userId?: string): Promise<number>;

  /* ── 按住说话的标记 ─────────────────────────────────────────── */
  /** 设备上按住 OK 键说的那一段（会话内的毫秒区间） */
  addSpeechMark(sessionId: string, startMs: number, endMs: number): Promise<void>;
  /** 这次录音里所有"按住说话"的区间（转文字时用来判断命令说完没有） */
  listSpeechMarks(sessionId: string): Promise<{ startMs: number; endMs: number }[]>;
  /** 意图判断先不做，放回待处理：按住标记还没到，等一等再看 */
  deferIntent(sessionId: string, sequence: number): Promise<void>;
  /** 这句话是不是落在某个"按住说话"区间里（前后各放宽 1 秒） */
  hasSpeechMark(sessionId: string, startMs: number, endMs: number): Promise<boolean>;
  /** 这个人最近一次「按住说」（5 分钟内）处理到哪了：busy＝录音还没传完/还在转写或分析；
   *  done＝已经出了卡片或办完了；none＝处理完了但没听出要办的事。设备松手后据此显示「处理中」 */
  latestTalkStatus(userId: string): Promise<{ sessionId: string; startMs: number; state: "busy" | "done" | "none" } | null>;

  /* ── AI 主题与产出物 ────────────────────────────────────────── */
  listTopics(sessionId: string): Promise<Topic[]>;
  getTopic(id: string): Promise<Topic | null>;
  createTopic(topic: Topic): Promise<Topic>;
  updateTopic(id: string, patch: Partial<Topic>): Promise<Topic | null>;
  deleteTopic(id: string): Promise<void>;
  /** 重新拆分 [fromMs, toMs) 这一段：删掉落在里面的 AI 主题，写入新的。人工主题不动 */
  replaceAiTopics(sessionId: string, fromMs: number, toMs: number, topics: Topic[]): Promise<void>;
  topicsForSessions(sessionIds: string[]): Promise<Topic[]>;
  /** 用过的客户/项目标签，带条数和最近一次时间 */
  listTopicLabels(userId: string): Promise<{ label: string; count: number; lastAt: string }[]>;
  /** 某个客户/项目下的主题，最近的在前 */
  topicsByLabel(userId: string, label: string, limit: number): Promise<(Topic & { sessionStartedAt: string })[]>;
  searchTopics(query: string, limit: number, userId?: string): Promise<(Topic & { sessionStartedAt: string })[]>;
  /** 有新的人声还没拆过主题的会话 */
  topicCandidates(): Promise<{ sessionId: string; userId: string; startedAt: string; topicsUntilMs: number;
    speechEndMs: number; newSpeechMs: number; lastUploadAt: string }[]>;
  setTopicsUntil(sessionId: string, ms: number): Promise<void>;
  /* ── 提醒 ── */
  createReminder(reminder: Reminder): Promise<Reminder>;
  /** 到点该推的（pending 且 remind_at <= now），跨所有用户 */
  dueReminders(nowIso: string, limit: number): Promise<Reminder[]>;
  /** 这个用户当前该显示的那一条（已推未确认的优先，其次刚到点的） */
  /** notBeforeIso：比它还早的提醒不再弹（"过几天自动收起"）；不传就不限 */
  activeReminder(userId: string, nowIso: string, notBeforeIso?: string): Promise<Reminder | null>;
  getReminder(id: string): Promise<Reminder | null>;
  updateReminder(id: string, patch: Partial<Reminder>): Promise<Reminder | null>;
  listReminders(userId: string, limit: number): Promise<Reminder[]>;
  /** 任务被取消/退回时，把它的提醒一起撤掉 */
  cancelRemindersForDraft(draftId: string): Promise<number>;

  /* ── 建议（看出来了但没替你做的事） ── */
  createSuggestions(list: Suggestion[]): Promise<Suggestion[]>;
  listSuggestions(userId: string, filter: { status?: string; sessionId?: string; topicIds?: string[]; sinceIso?: string; limit?: number }): Promise<Suggestion[]>;
  getSuggestion(id: string): Promise<Suggestion | null>;
  updateSuggestion(id: string, patch: Partial<Suggestion>): Promise<Suggestion | null>;

  /* ── 自动化 ── */
  createAutomation(a: Automation): Promise<Automation>;
  listAutomations(userId: string): Promise<Automation[]>;
  getAutomation(id: string): Promise<Automation | null>;
  updateAutomation(id: string, patch: Partial<Automation>): Promise<Automation | null>;
  deleteAutomation(id: string): Promise<boolean>;
  /** 到点该跑的（enabled 且 next_run_at <= now），跨所有用户 */
  dueAutomations(nowIso: string, limit: number): Promise<Automation[]>;

  createOutput(output: AiOutput): Promise<AiOutput>;
  getOutput(id: string): Promise<AiOutput | null>;
  listOutputs(targetIds: string[]): Promise<AiOutput[]>;

  /* ── 设备屏幕的回执与今日概况 ───────────────────────────────── */
  /** since 之后创建的卡片 + since 之前但 24 小时内执行完、还没在设备上划掉的回执 */
  deviceFeedDrafts(userId: string, sinceIso: string, receiptsSinceIso: string): Promise<(ActionDraft & { dismissed: boolean })[]>;
  /** 变了设备才重新拉 feed：设备每 1.5 秒轮询一次，不能每次都把整张清单发下去 */
  deviceFeedVersion(userId: string, sinceIso: string): Promise<string>;
  dismissDraftOnDevice(userId: string, id: string): Promise<boolean>;
  dayTotals(userId: string, sinceIso: string): Promise<{ recordedMs: number; sentences: number }>;

  /* ── 固件与远程升级 ─────────────────────────────────────────── */
  createFirmware(release: FirmwareRelease): Promise<FirmwareRelease>;
  listFirmware(): Promise<FirmwareRelease[]>;
  getFirmware(id: string): Promise<FirmwareRelease | null>;
  updateFirmware(id: string, patch: Partial<FirmwareRelease>): Promise<FirmwareRelease | null>;
  deleteFirmware(id: string): Promise<void>;

  /* ── 审计 ───────────────────────────────────────────────────── */
  appendAudit(entry: Omit<AuditEntry, "id">): Promise<void>;
  listAudit(limit: number, filter?: { actorId?: string; action?: string }): Promise<AuditEntry[]>;
}

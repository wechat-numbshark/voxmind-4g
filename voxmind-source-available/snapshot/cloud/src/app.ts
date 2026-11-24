import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import cors from "@fastify/cors";
import { z, ZodError } from "zod";
import type { AppConfig } from "./config.js";
import { opusToPcm16k } from "./asr/index.js";
import { pcm16MonoToWav } from "./audio/wav.js";
import { ActionDraft, AudioChunk, LedMode, PowerSchedule, UserPrefs, QualityTier, ToolPolicy } from "./domain.js";
import { wavHeader } from "./audio/wav.js";
import { adminAuth, clientIp, deviceAuth, userAuth } from "./security/auth.js";
import { clearSessionCookie, parseCookies, serializeSessionCookie, SESSION_COOKIE } from "./security/cookie.js";
import { IdentityService } from "./services/identity.js";
import { DEFAULT_PRICES, PricingService, type PriceBook } from "./services/pricing.js";
import { changeTitle, checkChanges, SettingsToolExecutor, TOOL_NAMES, withSettingsTool } from "./services/settings-tool.js";
import { SettingsService } from "./services/settings.js";
import { deviceCommandPhrases } from "./speech/text.js";
import { DeviceHeartbeat, UserRole } from "./identity/types.js";
import { DeviceOtaReport, FirmwareRollout } from "./ota/types.js";
import { OtaService } from "./services/ota.js";
import { beijingDay, DailyService } from "./ai/daily.js";
import { DiarizeService } from "./ai/diarize.js";
import { AutomationService, nextRun, scheduleLabel } from "./services/automations.js";
import { ReminderService, deviceReminderBody, deviceReminderTitle, deviceReminderWhen } from "./services/reminders.js";
import { THEMES, deviceTheme } from "./themes.js";
import { Automation, AutomationAction, AutomationSchedule } from "./domain.js";
import { DisabledLlm, type LlmClient } from "./ai/llm.js";
import { TopicService } from "./ai/topics.js";
import { MINUTES_TEMPLATES, OutputService, type MinutesTemplate } from "./ai/outputs.js";
import { ChatService } from "./ai/chat.js";
import { DEVICE_FEED_BYTES, fitDeviceFeed } from "./device-feed.js";
import { forPlayback } from "./audio/gain.js";
import { Denoiser, withDerivedCleanup } from "./audio/denoise.js";
import { DEVICE_GLYPHS } from "./device-glyphs.js";
import { ActionService } from "./services/actions.js";
import type { ObjectStore } from "./storage/object-store.js";
import type { Repository, SearchHit } from "./store/repository.js";
import type { ToolExecutor } from "./connectors/types.js";
import { ExecutionService } from "./services/execution.js";
import { SecretBox } from "./security/secrets.js";
import { signClipToken, verifyClipToken } from "./security/clip-token.js";
import { markdownToDocx } from "./export/docx.js";
import { FeishuUserExecutor } from "./connectors/feishu-user.js";
import { FeishuOnboardingService } from "./services/feishu-onboarding.js";
import type { IntentProvider } from "./intent/provider.js";
import type { EmbeddingProvider } from "./search/embeddings.js";

export interface AppDependencies { config: AppConfig; repository: Repository; objects: ObjectStore; executor: ToolExecutor;
  intent?: IntentProvider; embeddings?: EmbeddingProvider; llm?: LlmClient }

const CreateSessionBody = z.object({ sessionId: z.string().uuid().optional(), deviceId: z.string().min(1).max(128), userId: z.string().min(1).max(128).default("owner"), startedAt: z.string().datetime().optional(),
  bootId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional() });
const SessionParams = z.object({ id: z.string().uuid() });
const ChunkParams = z.object({ id: z.string().uuid(), sequence: z.coerce.number().int().nonnegative() });
const DraftParams = z.object({ id: z.string().uuid() });
const DraftQuery = z.object({ userId: z.string().default("owner"), status: ActionDraft.shape.status.optional(),
  tool: z.string().max(160).optional(), days: z.coerce.number().int().min(1).max(3650).optional(),
  q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional() });
const CreateDraftBody = ActionDraft.pick({ sessionId: true, userId: true, tool: true, title: true, detail: true, args: true, evidence: true, evidenceStartMs: true, evidenceEndMs: true, confidence: true, mode: true, risk: true }).partial({ detail: true, evidence: true, evidenceStartMs: true, evidenceEndMs: true });
const ReviseBody = z.object({ title: z.string().min(1).max(80).optional(), detail: z.string().max(500).optional(), args: z.record(z.string(), z.unknown()).optional() }).refine((x) => Object.keys(x).length > 0, "至少提供一个修改字段");
const EndBody = z.object({ status: z.enum(["ended", "interrupted"]).default("ended"), endedAt: z.string().datetime().optional() });
const TextCommandBody = z.object({ text: z.string().min(1).max(10_000), userId: z.string().min(1).max(128).default("owner"),
  sessionId: z.string().uuid().optional(), recordedAt: z.string().datetime().optional() });
const TOOL_RISKS = {
  "note.create": "record", "feishu.task.create": "personal_write", "feishu.calendar.create": "personal_write",
  "feishu.doc.create": "personal_write", "feishu.message.send": "external_write",
  "webhook.call": "external_write", "homeassistant.service.call": "physical_control",
  "iot.light.set": "physical_control", "iot.switch.set": "physical_control", "iot.climate.set": "physical_control",
  "iot.ir.send": "physical_control", "irrigation.zone.run": "physical_control",
  /* 说出来的定时规则：建规则本身只写自己这边，到点真做那件事时再按那件事的风险走 */
  "automation.create": "personal_write", "automation.cancel": "personal_write",
  /* 用说话 / 聊天改设置：改的只是自己这边的配置 */
  "settings.update": "personal_write",
  /* 记一笔账：写进你自己的飞书多维表格 */
  "expense.record": "personal_write",
} as const;

export async function createApp(deps: AppDependencies): Promise<FastifyInstance> {
  /* 分享链接的密钥在网址里：请求日志里把它遮掉，免得密钥躺在日志文件里 */
  const maskUrl = (url: string) => url.replace(/\/v1\/share\/[^/?#]+/, "/v1/share/***");
  const app = Fastify({ bodyLimit: 8 * 1024 * 1024,
    logger: deps.config.NODE_ENV !== "test" && { serializers: {
      req: (req: FastifyRequest) => ({ method: req.method, url: maskUrl(req.url), hostname: req.hostname,
        remoteAddress: req.ip, ...(req.socket?.remotePort ? { remotePort: req.socket.remotePort } : {}) }) } } });
  /* 提醒服务要先有，动作和执行才好把"排提醒/撤提醒"挂上去 */
  const settingsForReminders = new SettingsService(deps.repository, deps.config.DEFAULT_TIER);
  const reminderService = new ReminderService({ repository: deps.repository, settings: settingsForReminders });
  const actions = new ActionService(deps.repository, (draftId) => reminderService.cancelForDraft(draftId), app.log);
  const executions = new ExecutionService(deps.repository,
    withSettingsTool(deps.executor, new SettingsToolExecutor(settingsForReminders, deps.repository, TOOL_NAMES)),
    (draft) => reminderService.scheduleForDraft(draft));
  const feishuOnboarding = new FeishuOnboardingService(deps.repository, new SecretBox(deps.config.TOKEN_ENCRYPTION_KEY), deps.config.PUBLIC_BASE_URL,
    deps.config.LARK_APP_ID && deps.config.LARK_APP_SECRET ? { appId: deps.config.LARK_APP_ID, appSecret: deps.config.LARK_APP_SECRET } : undefined);
  const identity = new IdentityService(deps.repository, deps.config);
  const ota = new OtaService(deps.repository, deps.objects, deps.config.PUBLIC_BASE_URL);
  const settings = new SettingsService(deps.repository, deps.config.DEFAULT_TIER);
  /* 删音频走这个：顺带把 AI 降噪的缓存删掉 */
  const objects = withDerivedCleanup(deps.objects);
  const denoiser = new Denoiser(deps.objects);
  /* 回放/导出：选了 AI 降噪就先降噪（缓存过直接用），再走清晰模式；降噪不可用或失败退回清晰模式 */
  const playbackPcm = async (objectKey: string, pcm: Buffer, mode: Parameters<typeof forPlayback>[1]) => {
    if (mode !== "denoise") return forPlayback(pcm, mode);
    return forPlayback((await denoiser.process(objectKey, pcm)) ?? pcm, "clear");
  };
  const pricing = new PricingService(deps.repository);
  const llm = deps.llm ?? new DisabledLlm();
  const topicService = new TopicService({ repository: deps.repository, llm, settings, pricing });
  /* 分角色转写：要给百炼一条能下载的临时地址，所以 URL 用本机的公网地址拼 */
  const diarize = deps.config.DASHSCOPE_API_KEY
    ? new DiarizeService({ repository: deps.repository, pricing, apiKey: deps.config.DASHSCOPE_API_KEY,
        baseUrl: deps.config.DASHSCOPE_BASE_URL?.replace(/\/compatible-mode.*$/, "") || undefined,
        logger: app.log,
        clipUrl: (sessionId: string, fromMs: number, toMs: number) =>
          `${deps.config.PUBLIC_BASE_URL.replace(/\/$/, "")}/v1/clips/${signClipToken(deps.config.TOKEN_ENCRYPTION_KEY, { sessionId, fromMs, toMs })}.wav` })
    : undefined;
  const outputService = new OutputService({ repository: deps.repository, llm, pricing,
    ...(diarize ? { diarize } : {}), logger: app.log });
  const dailyService = new DailyService({ repository: deps.repository, llm, pricing, settings, actions });
  /* 消费汇总要读多维表格，用的是同一套飞书用户授权 */
  const expenseReader = deps.config.EXECUTION_MODE === "live"
    ? (appToken: string, tableId: string, fields: { date: string; amount: string; category: string; note: string }, from: number, to: number) =>
        new FeishuUserExecutor(deps.repository, new SecretBox(deps.config.TOKEN_ENCRYPTION_KEY))
          .expenseRecords(appToken, tableId, fields, from, to)
    : undefined;
  const reminders = reminderService;
  const automations = new AutomationService({ repository: deps.repository, actions, executions, settings, daily: dailyService,
    ...(expenseReader ? { expenses: expenseReader } : {}), logger: app.log });
  const chatService = new ChatService({ repository: deps.repository, llm, pricing, actions, executions,
    deviceHints: deps.config.EVA_DEVICE_HINTS,
    ...(deps.config.CHAT_MODEL ? { model: deps.config.CHAT_MODEL } : {}),
    search: async (q, userId) => (await hybridSearch(q, 12, userId)).hits });
  /** 设备要的配置：唤醒词（含离线识别用的拼音指令串）和定时开关机。心跳和开机时都会拉 */
  const deviceConfig = async (userId: string) => {
    const s = await settings.get(userId);
    /* 音质三档：码率 + 编码复杂度。复杂度直接对应设备 CPU——调低就流畅，代价是同样码率下压得差一点 */
    /* 复杂度 0 时设备黑屏录音只跑 80MHz（复杂度 5 要 160MHz，80MHz 下跟不上会重启）。
     * 2026-10-03 同一段中文干净/加噪声各压一遍，复杂度 0 和 5 的识别结果逐字相同，所以标准档也用 0 */
    const audio = { smooth: { bitrate: 16000, complexity: 0 }, standard: { bitrate: 24000, complexity: 0 },
      high: { bitrate: 32000, complexity: 5 } }[s.prefs.audio.quality];
    return { wakeWord: s.wakeWord, wakePhrases: deviceCommandPhrases(s.wakeWord), schedule: s.schedule, ledMode: s.ledMode, screenOffSec: s.prefs.screenOffSec,
      wakeOnCard: s.prefs.screenWake.onCard, wakeOnDone: s.prefs.screenWake.onDone, wakeOnTap: s.prefs.screenWake.onTap, doubleTapOff: s.prefs.screenWake.doubleTapOff, powerKey: s.prefs.powerKey,
      theme: deviceTheme(s.prefs.theme),
      chunkSec: s.prefs.audio.chunkSec, audioBitrate: audio.bitrate, audioComplexity: audio.complexity,
      timezone: "Asia/Shanghai", serverTime: new Date().toISOString() };
  };
  /** 设备字库只有 GB2312 + ASCII：别的字符（emoji、U+00B7 的「·」）在屏上是方块。
   *  发给设备的文字先过一遍：「·」换成字库里有的「・」，其他字库外的字去掉。*/
  const deviceText = (text: string) => {
    let out = "";
    for (const ch of text.replace(/\u00B7/g, "\u30FB")) {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x80 || DEVICE_GLYPHS.has(ch)) out += ch;
    }
    return out;
  };
  /** 现有量产固件的类型表只认识旧的 Home Assistant 工具名。新 IoT 工具在云端仍保留
   *  真实 tool，发到 2 英寸屏时临时映射成“智能家居”，避免被旧固件误标成默认“待办”。
   *  新固件已补齐原生标签，完成 OTA 覆盖后可移除这层兼容。 */
  const deviceTool = (tool: string, native = false) => !native && (tool.startsWith("iot.") || tool.startsWith("irrigation."))
    ? "homeassistant.service.call" : tool;
  /** 北京时间 ts 所在那天的零点（ISO）。设备和用户都在东八区，"今天"按这个算 */
  const dayStart = (ts: number) => {
    const shifted = ts + 8 * 3_600_000;
    return new Date(shifted - (shifted % 86_400_000) - 8 * 3_600_000).toISOString();
  };
  const requireDevice = deviceAuth(identity);
  const requireUser = userAuth(identity, deps.config.ADMIN_API_KEY);
  const requireAdmin = adminAuth(identity, deps.config.ADMIN_API_KEY);

  /* 数据范围。管理员可以用 ?userId= 看别人的，普通成员永远只能看自己的。
   * 这里就是修掉"带着管理密钥加个 ?userId=别人 就能读写别人录音"那个洞的地方：
   * 路由一律走这两个函数，不再直接读 query 里的 userId。*/
  const scopeOf = (request: FastifyRequest, requested?: string) => {
    const principal = request.principal!;
    return principal.role === "admin" && requested ? requested : principal.userId;
  };
  const mayAccess = (request: FastifyRequest, ownerId: string) =>
    request.principal!.role === "admin" || request.principal!.userId === ownerId;
  const auditFrom = (request: FastifyRequest, action: string, targetType: string, targetId: string,
                     detail: Record<string, unknown> = {}) =>
    identity.audit({ actorType: request.principal!.kind === "device" ? "device" : "user",
      actorId: request.principal!.deviceId ?? request.principal!.userId,
      action, targetType, targetId, detail, ip: clientIp(request) });
  await app.register(cors, { origin: false });

  /* 网页几个页面在轮询（今天 5 秒、录音 20 秒、任务中心 30 秒），每次都把整包发回去。
   * 加一层 ETag：内容没变就回 304，只花一个响应头的流量。手机上用 4G 看的时候差别明显。*/
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.method !== "GET" || reply.statusCode !== 200) return payload;
    if (typeof payload !== "string" || !request.url.startsWith("/v1/")) return payload;
    /* 设备接口不做：它有自己的 feedVersion，再加一层只是多算一次哈希 */
    if (request.url.startsWith("/v1/device")) return payload;
    const etag = `W/"${createHash("sha1").update(payload).digest("base64url")}"`;
    reply.header("etag", etag);
    /* no-cache＝可以存但每次都要回来验证。不加这个，浏览器的 fetch 根本不会带 If-None-Match，
     * ETag 也就白设了。private＝中间的 CDN 不许存别人的数据。*/
    reply.header("cache-control", "private, no-cache");
    if (request.headers["if-none-match"] === etag) {
      reply.code(304);
      return "";
    }
    return payload;
  });
  app.addContentTypeParser(/^audio\//, { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: "请求参数错误", details: error.issues });
    const candidate = typeof error === "object" && error !== null ? error as { statusCode?: unknown; message?: unknown } : {};
    const statusCode = typeof candidate.statusCode === "number" ? candidate.statusCode : 500;
    if (statusCode < 500) return reply.code(statusCode).send({ error: typeof candidate.message === "string" ? candidate.message : "请求失败" });
    app.log.error(error);
    return reply.code(500).send({ error: "服务器内部错误" });
  });

  app.get("/health", async () => ({ ok: true, service: "voxmind", version: "0.2.0" }));
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
  /* 网页控制台：Vite 构建产物在 web/dist。带哈希的静态资源长缓存；
   * /app/* /admin/* 这类前端路由一律回落到 index.html，刷新和分享链接才不会 404。*/
  const webDist = join(webRoot, "dist");
  const hasWeb = await readFile(join(webDist, "index.html")).then(() => true, () => false);
  if (hasWeb) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false, index: false,
      setHeaders: (res, filePath) => {
        // Vite 给打包产物文件名加了 8 位哈希，内容一变名字就变，可以永久缓存
        res.header("cache-control", /[/\\]assets[/\\][^/\\]+-[\w-]{8}\.\w+$/.test(filePath)
          ? "public, max-age=31536000, immutable" : "no-cache");
      } });
    const spa = async (_request: FastifyRequest, reply: FastifyReply) =>
      reply.type("text/html; charset=utf-8").header("cache-control", "no-cache").send(await readFile(join(webDist, "index.html")));
    app.get("/", spa);
    for (const prefix of ["/app", "/admin", "/login"]) { app.get(prefix, spa); app.get(`${prefix}/*`, spa); }
    app.get("/assets/*", async (request, reply) => {
      const rest = (request.params as { "*": string })["*"];
      return reply.sendFile(`assets/${rest}`);
    });
  }
  app.get("/ready", async (_request, reply) => {
    try { await deps.repository.listSessions(1); return { ready: true }; }
    catch { return reply.code(503).send({ ready: false }); }
  });

  app.post("/v1/device-sessions", { preHandler: requireDevice }, async (request, reply) => {
    const body = CreateSessionBody.parse(request.body);
    const id = body.sessionId ?? randomUUID();
    const existing = await deps.repository.getSession(id);
    if (existing) {
      if (existing.deviceId !== body.deviceId || existing.userId !== body.userId) return reply.code(409).send({ error: "会话 UUID 已属于其他设备或用户" });
      return reply.send({ session: existing, duplicate: true });
    }
    const session = await deps.repository.createSession({ id, deviceId: body.deviceId, userId: body.userId,
      startedAt: body.startedAt ?? new Date().toISOString(), bootId: body.bootId ?? null });
    return reply.code(201).send({ session, duplicate: false });
  });

  app.put("/v1/device-sessions/:id/chunks/:sequence", { preHandler: requireDevice }, async (request, reply) => {
    const params = ChunkParams.parse(request.params);
    const session = await deps.repository.getSession(params.id);
    if (!session) return reply.code(404).send({ error: "会话不存在" });
    if (session.status !== "recording") return reply.code(409).send({ error: "会话已经结束" });
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: "音频块不能为空" });
    const actualHash = createHash("sha256").update(body).digest("hex");
    const claimedHash = String(request.headers["x-content-sha256"] ?? "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(claimedHash)) return reply.code(400).send({ error: "缺少或无效的 x-content-sha256" });
    if (claimedHash !== actualHash) return reply.code(422).send({ error: "音频块 SHA-256 不匹配", actualSha256: actualHash });
    const existing = await deps.repository.getChunk(params.id, params.sequence);
    if (existing && existing.sha256 !== actualHash) return reply.code(409).send({ error: "相同序号已经存在不同内容" });
    if (existing) return reply.send({ chunk: existing, duplicate: true, durable: true });
    const durationMs = z.coerce.number().int().positive().max(120_000).parse(request.headers["x-duration-ms"]);
    const startMs = z.coerce.number().int().nonnegative().parse(request.headers["x-start-ms"] ?? params.sequence * durationMs);
    const contentType = String(request.headers["content-type"] ?? "application/octet-stream").split(";")[0]!;
    const extension = contentType.includes("ogg") ? "ogg" : contentType.includes("opus") ? "opus" : contentType.includes("pcm") ? "pcm" : "bin";
    const objectKey = `${session.deviceId}/${session.id}/${String(params.sequence).padStart(8, "0")}-${actualHash.slice(0, 12)}.${extension}`;
    await deps.objects.put(objectKey, body, contentType);
    const chunk = AudioChunk.parse({ sessionId: session.id, sequence: params.sequence, sha256: actualHash, objectKey, contentType, byteLength: body.length, startMs, durationMs, uploadedAt: new Date().toISOString() });
    const result = await deps.repository.putChunk(chunk);
    return reply.code(result.created ? 201 : 200).send({ chunk: result.chunk, duplicate: !result.created, durable: true });
  });

  app.post("/v1/device-sessions/:id/end", { preHandler: requireDevice }, async (request, reply) => {
    const { id } = SessionParams.parse(request.params);
    const body = EndBody.parse(request.body ?? {});
    const current = await deps.repository.getSession(id);
    if (!current) return reply.code(404).send({ error: "会话不存在" });
    if (current.status !== "recording") return { session: current, duplicate: true };
    const session = await deps.repository.updateSessionStatus(id, body.status, body.endedAt ?? new Date().toISOString());
    return { session, duplicate: false };
  });

  app.get("/v1/sessions", { preHandler: requireUser }, async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50),
      userId: z.string().optional() }).parse(request.query);
    return { sessions: await deps.repository.listSessionSummaries(query.limit, scopeOf(request, query.userId)) };
  });
  app.get("/v1/system-status", { preHandler: requireAdmin }, async () => {
    const feishu = await feishuOnboarding.status("owner");
    return { version: "0.2.0", executionMode: deps.config.EXECUTION_MODE,
      asr: { provider: deps.config.ASR_PROVIDER, ready: deps.config.ASR_PROVIDER !== "disabled" },
      llm: { provider: deps.config.LLM_PROVIDER, ready: deps.config.LLM_PROVIDER !== "disabled" },
      feishu: { ready: feishu.authorized },
      webhook: { ready: Boolean(deps.config.WEBHOOK_ALLOWED_ORIGINS) },
      homeAssistant: { ready: Boolean(deps.config.HOME_ASSISTANT_URL && deps.config.HOME_ASSISTANT_TOKEN) },
      publicBaseUrl: deps.config.PUBLIC_BASE_URL };
  });
  app.get("/v1/device-provisioning", { preHandler: requireAdmin }, async () => ({
    apiBaseUrl: deps.config.PUBLIC_BASE_URL,
    deviceId: "demo-voxmind-not-a-real-device",
    deviceKey: deps.config.DEVICE_API_KEY,
  }));
  app.get("/v1/integrations/feishu/status", { preHandler: requireAdmin }, async () => feishuOnboarding.status("owner"));
  app.post("/v1/integrations/feishu/registration/start", { preHandler: requireAdmin }, async () => feishuOnboarding.start("owner"));
  app.get("/v1/integrations/feishu/registration/status", { preHandler: requireAdmin }, async () => feishuOnboarding.poll("owner"));
  app.get("/v1/integrations/feishu/authorize-url", { preHandler: requireAdmin }, async () => ({ url: await feishuOnboarding.authorizeUrl("owner") }));
  app.get("/v1/integrations/feishu/callback", async (request, reply) => {
    const query = z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(request.query);
    await feishuOnboarding.callback(query.code, query.state);
    return reply.type("text/html; charset=utf-8").send("<!doctype html><meta charset=utf-8><title>VoxMind 飞书授权</title><style>body{font:16px system-ui;background:#07131f;color:#edf8f8;display:grid;place-items:center;height:100vh;margin:0}main{max-width:480px;padding:32px}h1{color:#70e1d1}</style><main><h1>授权成功</h1><p>VoxMind 已连接你的飞书账号，可以关闭此页面。</p></main>");
  });
  app.get("/v1/sessions/:id/timeline", { preHandler: requireUser }, async (request, reply) => {
    const { id } = SessionParams.parse(request.params);
    const timeline = await deps.repository.listTimeline(id);
    if (!timeline) return reply.code(404).send({ error: "会话不存在" });
    // 别人的录音一律当作不存在，不要用 403 暴露"这个 id 是有效的"
    if (!mayAccess(request, timeline.session.userId)) return reply.code(404).send({ error: "会话不存在" });
    return { timeline };
  });
  app.get("/v1/sessions/:id/chunks/:sequence/audio", { preHandler: requireUser }, async (request, reply) => {
    const params = ChunkParams.parse(request.params);
    const owner = await deps.repository.getSession(params.id);
    if (!owner || !mayAccess(request, owner.userId)) return reply.code(404).send({ error: "音频块不存在" });
    const chunk = await deps.repository.getChunk(params.id, params.sequence);
    if (!chunk) return reply.code(404).send({ error: "音频块不存在" });
    const object = await deps.objects.get(chunk.objectKey);
    if (!object) return reply.code(410).send({ error: "音频对象已经丢失" });
    // 设备上传的是 Ogg/Opus；iPhone Safari 等浏览器不一定能直接播，统一转成 WAV 回放。
    const pcm = chunk.contentType === "audio/pcm" || chunk.contentType === "audio/L16"
      ? object.body
      : await opusToPcm16k(object.body);
    const mode = (await settings.get(owner.userId)).prefs.playbackGain;
    // 缓存只留 1 分钟：用户改了回放音量，下一次播放就要听到新的
    return reply.type("audio/wav").header("cache-control", "private, max-age=60").send(pcm16MonoToWav(await playbackPcm(chunk.objectKey, pcm, mode)));
  });

  /* ────────────────────────────────────────────────────────────
   * 波形、导出、删除（docs/20 §10 的隐私底线）
   * ──────────────────────────────────────────────────────────── */
  const ownedSession = async (request: FastifyRequest, id: string) => {
    const session = await deps.repository.getSession(id);
    return session && mayAccess(request, session.userId) ? session : null;
  };

  /** 画波形用：每块一段 base64 包络（每 200ms 一个字节），不用下载音频 */
  app.get("/v1/sessions/:id/waveform", { preHandler: requireUser }, async (request, reply) => {
    const { id } = SessionParams.parse(request.params);
    if (!(await ownedSession(request, id))) return reply.code(404).send({ error: "会话不存在" });
    return { chunks: await deps.repository.listEnvelopes(id) };
  });

  /* 一次最多导出 30 分钟：逐块解码写进临时文件再流式发出，
   * 内存里始终只有一块，2 核 2G 的服务器也扛得住。*/
  const MAX_EXPORT_MS = 30 * 60_000;

  /* 把一段录音拼成 WAV 落到临时文件。导出和"分角色转写"都用它——后者要给百炼一条能下载的地址 */
  const buildWavClip = async (sessionId: string, fromMs: number, toMs: number, mode: Parameters<typeof forPlayback>[1]) => {
    const chunks = await deps.repository.chunksInRange(sessionId, fromMs, toMs);
    if (!chunks.length) return null;
    const path = join(tmpdir(), `voxmind-export-${randomUUID()}.pcm`);
    const file = await open(path, "w");
    let bytes = 0;
    try {
      for (const chunk of chunks) {
        const object = await deps.objects.get(chunk.objectKey);
        if (!object) continue;
        const pcm = chunk.contentType === "audio/pcm" || chunk.contentType === "audio/L16"
          ? object.body : await opusToPcm16k(object.body);
        // 首尾两块可能只要一部分：按毫秒换算成采样点（16 采样/毫秒、每采样 2 字节）
        const from = Math.max(0, fromMs - chunk.startMs);
        const to = Math.min(chunk.durationMs, toMs - chunk.startMs);
        const processed = mode === "denoise" ? await playbackPcm(chunk.objectKey, pcm, mode) : null;
        const slice = processed ? processed.subarray(Math.floor(from * 16) * 2, Math.floor(to * 16) * 2)
          : forPlayback(pcm.subarray(Math.floor(from * 16) * 2, Math.floor(to * 16) * 2), mode);
        await file.write(slice);
        bytes += slice.length;
      }
    } finally { await file.close(); }
    if (!bytes) { await rm(path, { force: true }); return null; }
    return { path, bytes };
  };
  const wavStream = (path: string, bytes: number) => {
    const stream = Readable.from((async function* () {
      yield wavHeader(bytes);
      for await (const part of createReadStream(path)) yield part as Buffer;
    })());
    stream.once("close", () => void rm(path, { force: true }));
    return stream;
  };

  /* 分角色转写要给百炼一条能下载的地址。地址本身带签名、30 分钟过期、只指向那一段。*/
  app.get("/v1/clips/:token.wav", async (request, reply) => {
    const { token } = z.object({ token: z.string().min(10).max(400) }).parse(request.params);
    const claim = verifyClipToken(deps.config.TOKEN_ENCRYPTION_KEY, token);
    if (!claim) return reply.code(404).send({ error: "链接无效或已过期" });
    const clip = await buildWavClip(claim.sessionId, claim.fromMs, claim.toMs, "raw");   // 给识别用，原样
    if (!clip) return reply.code(404).send({ error: "这一段没有音频" });
    return reply.type("audio/wav").header("content-length", String(44 + clip.bytes))
      .header("cache-control", "private, no-store").send(wavStream(clip.path, clip.bytes));
  });

  app.get("/v1/sessions/:id/export.wav", { preHandler: requireUser }, async (request, reply) => {
    const { id } = SessionParams.parse(request.params);
    const q = z.object({ from: z.coerce.number().int().min(0).default(0),
      to: z.coerce.number().int().min(1).default(Number.MAX_SAFE_INTEGER) }).parse(request.query);
    const session = await ownedSession(request, id);
    if (!session) return reply.code(404).send({ error: "会话不存在" });
    if (q.to - q.from > MAX_EXPORT_MS) return reply.code(400).send({ error: "一次最多导出 30 分钟，请分段导出" });
    const chunks = await deps.repository.chunksInRange(id, q.from, q.to);
    if (!chunks.length) return reply.code(404).send({ error: "这一段没有音频" });

    const clip = await buildWavClip(id, q.from, q.to, (await settings.get(session.userId)).prefs.playbackGain);
    if (!clip) return reply.code(404).send({ error: "这一段没有音频" });
    const { bytes } = clip;

    await auditFrom(request, "audio.export", "session", id, { fromMs: q.from, toMs: q.to, bytes });
    const name = `voxmind-${session.startedAt.slice(0, 10)}-${Math.round(q.from / 1000)}s.wav`;
    const stream = wavStream(clip.path, bytes);
    /* 站点挂在 CDN 后面时，.wav 这种带扩展名的地址可能被边缘节点按静态资源缓存住——
     * 那等于把别人的录音留在第三方节点上。标成 private+no-store，CDN 一律不缓存。*/
    return reply.type("audio/wav").header("content-length", String(44 + bytes))
      .header("cache-control", "private, no-store")
      .header("content-disposition", `attachment; filename="${name}"`).send(stream);
  });

  /* 一段录音（或其中 fromMs~toMs 一截）的文字稿：导出和「复制给 AI」共用 */
  const transcriptLines = async (session: { id: string; startedAt: string }, fromMs: number, toMs: number) => {
    const started = Date.parse(session.startedAt);
    return (await deps.repository.listTranscripts(session.id))
      .filter((t) => t.kind === "speech" && t.status === "succeeded" && t.text.trim() && t.startMs < toMs && t.endMs > fromMs)
      .map((t) => `[${new Date(started + t.startMs).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}] ${t.text}`);
  };

  /* ── 复制给 AI：带密钥的只读链接 ──
   * 用户在录音页点「复制给 AI」，拿到一个链接贴给任何 AI 助手，它打开链接就能读这一段的全文。
   * 密钥 24 字节随机数（猜不出来），库里只存 SHA-256；默认 7 天过期，随时可撤销，录音删了链接跟着失效。*/
  const shareHash = (token: string) => createHash("sha256").update(token).digest("hex");
  app.post("/v1/sessions/:id/share", { preHandler: requireUser }, async (request, reply) => {
    const { id } = SessionParams.parse(request.params);
    const body = z.object({ from: z.number().int().min(0).optional(), to: z.number().int().min(1).optional(),
      days: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7) }).parse(request.body ?? {});
    const session = await ownedSession(request, id);
    if (!session) return reply.code(404).send({ error: "会话不存在" });
    const token = randomBytes(24).toString("base64url");
    const now = Date.now();
    const link = await deps.repository.createShareLink({ id: randomUUID(), userId: session.userId, sessionId: id, folderId: null,
      fromMs: body.from ?? 0, toMs: body.to ?? null, tokenHash: shareHash(token), createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + body.days * 86_400_000).toISOString(), revokedAt: null, lastUsedAt: null, uses: 0 });
    await auditFrom(request, "share.create", "session", id, { linkId: link.id, days: body.days, fromMs: link.fromMs, toMs: link.toMs });
    const base = (deps.config.PUBLIC_BASE_URL || `${request.protocol}://${request.host}`).replace(/\/$/, "");
    return reply.code(201).send({ id: link.id, url: `${base}/v1/share/${token}`, expiresAt: link.expiresAt });
  });
  /* 整个收藏文件夹复制给 AI：链接里是文件夹里每段录音的全文（按时间排），读取时按当时文件夹里有哪几段算 */
  app.post("/v1/favorite-folders/:id/share", { preHandler: requireUser }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { days } = z.object({ days: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7) }).parse(request.body ?? {});
    const userId = scopeOf(request);
    if (!(await deps.repository.listFavorites(userId)).folders.some((f) => f.id === id)) return reply.code(404).send({ error: "文件夹不存在" });
    const token = randomBytes(24).toString("base64url");
    const now = Date.now();
    const link = await deps.repository.createShareLink({ id: randomUUID(), userId, sessionId: null, folderId: id, fromMs: 0, toMs: null,
      tokenHash: shareHash(token), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + days * 86_400_000).toISOString(),
      revokedAt: null, lastUsedAt: null, uses: 0 });
    await auditFrom(request, "share.create", "folder", id, { linkId: link.id, days });
    const base = (deps.config.PUBLIC_BASE_URL || `${request.protocol}://${request.host}`).replace(/\/$/, "");
    return reply.code(201).send({ id: link.id, url: `${base}/v1/share/${token}`, expiresAt: link.expiresAt });
  });
  app.get("/v1/shares", { preHandler: requireUser }, async (request) => {
    const q = z.object({ sessionId: z.string().uuid().optional(), folderId: z.string().uuid().optional() }).parse(request.query);
    const links = await deps.repository.listShareLinks(scopeOf(request), { ...(q.sessionId ? { sessionId: q.sessionId } : {}), ...(q.folderId ? { folderId: q.folderId } : {}) });
    return { shares: links.map(({ tokenHash: _t, ...rest }) => rest) };
  });
  app.delete("/v1/shares/:id", { preHandler: requireUser }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!(await deps.repository.revokeShareLink(id, scopeOf(request)))) return reply.code(404).send({ error: "链接不存在或已撤销" });
    await auditFrom(request, "share.revoke", "share", id, {});
    return { revoked: true };
  });
  /* 公开读取：不要登录，凭链接里的密钥。给 AI 读的纯文字（?format=json 给程序用） */
  app.get("/v1/share/:token", async (request, reply) => {
    const { token } = z.object({ token: z.string().min(16).max(100) }).parse(request.params);
    const link = await deps.repository.findShareLink(shareHash(token));
    const dead = !link || link.revokedAt || Date.parse(link.expiresAt) < Date.now();
    if (dead) return reply.code(404).type("text/plain; charset=utf-8").send("这个链接不存在、已过期或已被撤销。\n");
    const at = (ms: number) => new Date(ms).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    const note = `说明：这是一台随身录音设备自动转写的文字，可能有同音错字，请按上下文理解。每行开头是北京时间。`;
    const send = (text: string) => reply.type("text/plain; charset=utf-8").header("cache-control", "private, no-store")
      .header("x-robots-tag", "noindex").send(text);
    /* 一段录音（或其中一截）→ 主题 + 带时间的全文 */
    const sessionPart = async (session: { id: string; startedAt: string }, fromMs: number, toMs: number, level: string) => {
      const lines = await transcriptLines(session, fromMs, toMs);
      const started = Date.parse(session.startedAt);
      const topics = (await deps.repository.listTopics(session.id)).filter((t) => t.startMs < toMs && t.endMs > fromMs);
      return { started, topics, lines, text: [
        ...(topics.length ? [`${level} 主题`, ...topics.map((t) => `- ${at(started + t.startMs)} ${t.title}${t.summary ? `：${t.summary}` : ""}`), ""] : []),
        `${level} 全文`, ...(lines.length ? lines : ["（这一段没有识别出说话内容）"]), ""].join("\n") };
    };
    if (link.folderId) {
      const fav = await deps.repository.listFavorites(link.userId);
      const folder = fav.folders.find((f) => f.id === link.folderId);
      if (!folder) return reply.code(404).type("text/plain; charset=utf-8").send("这个文件夹已经删除。\n");
      const ids = fav.items.filter((i) => i.folderIds.includes(folder.id)).map((i) => i.sessionId);
      const sessions = (ids.length ? await deps.repository.listSessionSummaries(500, link.userId, ids) : [])
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(0, 60);
      await deps.repository.touchShareLink(link.id);
      const parts: string[] = [];
      let size = 0;
      for (const [i, s] of sessions.entries()) {
        const part = await sessionPart(s, 0, Number.MAX_SAFE_INTEGER, "###");
        const block = `## 第 ${i + 1} 段：${at(part.started)}${s.title ? ` ${s.title}` : ""}\n${part.text}`;
        if (size + block.length > 400_000) { parts.push(`（后面还有 ${sessions.length - i} 段，太长没放进来）`); break; }
        parts.push(block); size += block.length;
      }
      return send([`# VoxMind 收藏夹「${folder.name}」`, `共 ${sessions.length} 段录音，按时间先后排列。`, note, "",
        ...(parts.length ? parts : ["（这个文件夹现在是空的）"]), ""].join("\n"));
    }
    const session = link.sessionId ? await deps.repository.getSession(link.sessionId) : null;
    if (!session) return reply.code(404).type("text/plain; charset=utf-8").send("这段录音已经删除。\n");
    const toMs = link.toMs ?? Number.MAX_SAFE_INTEGER;
    const part = await sessionPart(session, link.fromMs, toMs, "##");
    await deps.repository.touchShareLink(link.id);
    if ((request.query as { format?: string }).format === "json") {
      return reply.header("cache-control", "private, no-store").send({ startedAt: new Date(part.started + link.fromMs).toISOString(),
        topics: part.topics.map((t) => ({ title: t.title, summary: t.summary, at: at(part.started + t.startMs) })), lines: part.lines });
    }
    return send([`# VoxMind 录音文字稿`, `开始：${at(part.started + link.fromMs)}`, note, "", part.text].join("\n"));
  });

  app.get("/v1/sessions/:id/export.txt", { preHandler: requireUser }, async (request, reply) => {
    const { id } = SessionParams.parse(request.params);
    const q = z.object({ from: z.coerce.number().int().min(0).default(0),
      to: z.coerce.number().int().min(1).default(Number.MAX_SAFE_INTEGER) }).parse(request.query);
    const session = await ownedSession(request, id);
    if (!session) return reply.code(404).send({ error: "会话不存在" });
    const started = Date.parse(session.startedAt);
    const lines = await transcriptLines(session, q.from, q.to);
    await auditFrom(request, "transcript.export", "session", id, { fromMs: q.from, toMs: q.to, lines: lines.length });
    return reply.type("text/plain; charset=utf-8")
      .header("cache-control", "private, no-store")
      .header("content-disposition", `attachment; filename="voxmind-${session.startedAt.slice(0, 10)}.txt"`)
      .send(`VoxMind 录音转写\n设备 ${session.deviceId}\n开始 ${new Date(started).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}\n\n${lines.join("\n")}\n`);
  });

  /** 删掉一段录音：音频和转写都删，已经产生的动作记录保留（否则等于篡改历史） */
  app.delete("/v1/sessions/:id/audio", { preHandler: requireUser }, async (request, reply) => {
    const { id } = SessionParams.parse(request.params);
    const q = z.object({ from: z.coerce.number().int().min(0).default(0),
      to: z.coerce.number().int().min(1).default(Number.MAX_SAFE_INTEGER) }).parse(request.query);
    if (!(await ownedSession(request, id))) return reply.code(404).send({ error: "会话不存在" });
    const chunks = await deps.repository.chunksInRange(id, q.from, q.to);
    if (!chunks.length) return reply.code(404).send({ error: "这一段没有音频" });
    const keys = await deps.repository.deleteChunks(id, chunks.map((c) => c.sequence));
    for (const key of keys) await objects.delete(key).catch(() => {});
    await auditFrom(request, "audio.delete", "session", id, { fromMs: q.from, toMs: q.to, chunks: keys.length });
    return { deleted: keys.length };
  });

  /** 删录音：按段、按天、按开机，网页把要删的会话一次传上来。
   *  正在录的那段不让删：设备还在往里传，删了又会冒出来，而且看起来像删不掉 */
  app.post("/v1/sessions/delete", { preHandler: requireUser }, async (request, reply) => {
    const { ids } = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }).parse(request.body);
    const owned: string[] = [];
    for (const id of new Set(ids)) {
      const session = await ownedSession(request, id);
      if (!session) continue;
      const last = (await deps.repository.chunksInRange(id, 0, Number.MAX_SAFE_INTEGER)).reduce((m: string, c) => (c.uploadedAt > m ? c.uploadedAt : m), "");
      if (session.status === "recording" && last && Date.now() - Date.parse(last) < 2 * 60_000) {
        return reply.code(409).send({ error: "正在录的这段删不了，等设备暂停或关机后再删", sessionId: id });
      }
      owned.push(id);
    }
    if (!owned.length) return reply.code(404).send({ error: "没有可删的录音" });
    const keys = await deps.repository.deleteSessions(owned);
    for (const key of keys) await objects.delete(key).catch(() => {});
    await auditFrom(request, "session.delete", "session", owned[0]!, { sessions: owned.length, chunks: keys.length });
    return { deleted: owned.length, chunks: keys.length };
  });

  /* ── 收藏：录音加星、放进自己建的文件夹（一段可以在几个文件夹里）。聊天里的 AI 也能整理 ── */
  app.get("/v1/favorites", { preHandler: requireUser }, async (request) => {
    const userId = scopeOf(request);
    const fav = await deps.repository.listFavorites(userId);
    const sessions = fav.items.length ? await deps.repository.listSessionSummaries(500, userId, fav.items.map((i) => i.sessionId)) : [];
    return { folders: fav.folders.map((f) => ({ id: f.id, name: f.name, createdAt: f.createdAt, keywords: f.keywords,
      count: fav.items.filter((i) => i.folderIds.includes(f.id)).length })), items: fav.items, sessions };
  });
  app.put("/v1/favorites/:sessionId", { preHandler: requireUser }, async (request, reply) => {
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(request.params);
    if (!(await ownedSession(request, sessionId))) return reply.code(404).send({ error: "会话不存在" });
    await deps.repository.setFavorite(scopeOf(request), sessionId, true);
    return { favorite: true };
  });
  app.delete("/v1/favorites/:sessionId", { preHandler: requireUser }, async (request) => {
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(request.params);
    await deps.repository.setFavorite(scopeOf(request), sessionId, false);
    return { favorite: false };
  });
  const FolderName = z.string().trim().min(1, "文件夹名不能为空").max(40);
  app.post("/v1/favorite-folders", { preHandler: requireUser }, async (request, reply) => {
    const { name } = z.object({ name: FolderName }).parse(request.body);
    const folder = await deps.repository.createFavoriteFolder({ id: randomUUID(), userId: scopeOf(request), name, createdAt: new Date().toISOString(), keywords: [] });
    return reply.code(201).send({ folder });
  });
  app.patch("/v1/favorite-folders/:id", { preHandler: requireUser }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    /* 改名，或者设自动归档关键词（空数组＝关掉）。设了关键词马上把以前的录音按规则过一遍 */
    const body = z.object({ name: FolderName.optional(), keywords: z.array(z.string().trim().min(1).max(20)).max(10).optional() })
      .refine((b) => b.name !== undefined || b.keywords !== undefined, "要改名字或关键词").parse(request.body);
    const userId = scopeOf(request);
    if (body.name !== undefined && !(await deps.repository.renameFavoriteFolder(userId, id, body.name))) return reply.code(404).send({ error: "文件夹不存在" });
    if (body.keywords !== undefined) {
      if (!(await deps.repository.setFolderKeywords(userId, id, [...new Set(body.keywords)]))) return reply.code(404).send({ error: "文件夹不存在" });
      return { ok: true, added: await deps.repository.applyFolderRules(userId) };
    }
    return { ok: true };
  });
  app.delete("/v1/favorite-folders/:id", { preHandler: requireUser }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!(await deps.repository.deleteFavoriteFolder(scopeOf(request), id))) return reply.code(404).send({ error: "文件夹不存在" });
    return { ok: true };   // 文件夹删了，里面的录音还在收藏里
  });
  app.put("/v1/favorite-folders/:id/items/:sessionId", { preHandler: requireUser }, async (request, reply) => {
    const { id, sessionId } = z.object({ id: z.string().uuid(), sessionId: z.string().uuid() }).parse(request.params);
    if (!(await ownedSession(request, sessionId))) return reply.code(404).send({ error: "会话不存在" });
    if (!(await deps.repository.setFolderItem(scopeOf(request), id, sessionId, true))) return reply.code(404).send({ error: "文件夹不存在" });
    return { ok: true };
  });
  app.delete("/v1/favorite-folders/:id/items/:sessionId", { preHandler: requireUser }, async (request, reply) => {
    const { id, sessionId } = z.object({ id: z.string().uuid(), sessionId: z.string().uuid() }).parse(request.params);
    if (!(await deps.repository.setFolderItem(scopeOf(request), id, sessionId, false))) return reply.code(404).send({ error: "文件夹不存在" });
    return { ok: true };
  });

  app.post("/v1/action-drafts", { preHandler: requireUser }, async (request, reply) => {
    const body = CreateDraftBody.parse(request.body);
    const session = await deps.repository.getSession(body.sessionId);
    if (!session || !mayAccess(request, session.userId)) return reply.code(404).send({ error: "会话不存在" });
    const input = { ...body, userId: scopeOf(request, body.userId) };
    const draft = await actions.createDraft(input);
    const execution = draft.status === "confirmed" ? await executions.execute(draft) : null;
    return reply.code(201).send({ draft: execution ? await deps.repository.getDraft(draft.id) : draft, execution });
  });
  app.post("/v1/text-commands", { preHandler: requireUser }, async (request, reply) => {
    if (!deps.intent || deps.intent.name === "disabled") return reply.code(503).send({ error: "意图模型尚未配置" });
    const parsed = TextCommandBody.parse(request.body);
    const input = { ...parsed, userId: scopeOf(request, parsed.userId) };
    const recordedAt = input.recordedAt ?? new Date().toISOString();
    let sessionId = input.sessionId;
    if (sessionId && !(await deps.repository.getSession(sessionId))) return reply.code(404).send({ error: "会话不存在" });
    if (!sessionId) {
      sessionId = randomUUID();
      await deps.repository.createSession({ id: sessionId, deviceId: "web-console", userId: input.userId, startedAt: recordedAt });
      await deps.repository.updateSessionStatus(sessionId, "ended", recordedAt);
    }
    const candidates = await deps.intent.extract(input.text, recordedAt);
    const results = [];
    for (const candidate of candidates) {
      const setting = candidate.tool === "settings.update" ? checkChanges(candidate.args.changes, TOOL_NAMES) : null;
      if (setting && !setting.ok.length) continue;
      const draft = await actions.createDraft({ ...candidate, sessionId, userId: input.userId,
        ...(setting ? { args: { changes: setting.ok }, title: changeTitle(setting), detail: setting.summary, forceConfirm: setting.loosens } : {}) });
      const execution = draft.status === "confirmed" ? await executions.execute(draft) : null;
      results.push({ draft: execution ? await deps.repository.getDraft(draft.id) : draft, execution });
    }
    return reply.code(201).send({ sessionId, provider: deps.intent.name, actions: results });
  });
  app.get("/v1/action-drafts", { preHandler: requireUser }, async (request) => {
    const query = DraftQuery.parse(request.query);
    const all = await deps.repository.listDrafts(scopeOf(request, query.userId), query.status);
    /* 「任务中心」要能翻历史：按类型、时间、关键词筛，最新的在前。
     * 不传这些参数时行为和以前一样（「今天」页就是这么用的）。*/
    const since = query.days ? Date.now() - query.days * 86_400_000 : 0;
    const needle = query.q?.trim().toLowerCase();
    const filtered = all.filter((d) =>
      (!query.tool || d.tool === query.tool) &&
      (!since || Date.parse(d.createdAt) >= since) &&
      (!needle || `${d.title} ${d.detail} ${d.evidence}`.toLowerCase().includes(needle)));
    const total = filtered.length;
    const drafts = query.limit || query.offset
      ? [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 50))
      : filtered;
    /* 网页上的进程单要显示倒计时和"回放原声"：作废时刻由策略算，原声块由证据时间点查 */
    return { total, drafts: await Promise.all(drafts.map(async (draft) => ({ ...draft,
      expiresAt: await actions.expiresAt(draft),
      evidenceChunk: draft.evidenceStartMs === null ? null
        : (await deps.repository.findChunkAt(draft.sessionId, draft.evidenceStartMs))?.sequence ?? null,
      // 是不是按住设备确认键说出来的：网页上单独标出来，和"AI 自己听出来的"区分
      pushToTalk: draft.status === "pending" && draft.evidenceStartMs !== null && draft.evidenceEndMs !== null
        ? await deps.repository.hasSpeechMark(draft.sessionId, draft.evidenceStartMs, draft.evidenceEndMs) : false,
    }))) };
  });
  app.get("/v1/device-actions", { preHandler: requireDevice }, async (request) => {
    // userId 取自设备绑定的那个人，而不是 URL——设备不该能点名要别人的卡片
    const userId = request.principal!.userId;
    const drafts = await deps.repository.listDrafts(userId, "pending");
    // 设备每 1.5 秒拉一次卡片，指令（比如语音说的「小沃，关机」）顺路带下去，不另开通道
    const command = await deps.repository.takeDeviceCommand(request.principal!.userId);
    const head = drafts[0];
    /* 版本里带上日期和回执范围：过了零点"今天"换了一天、或者后台改了范围，
     * 回执列表都会变，但草稿表本身没动——不带的话设备要等 5 分钟兜底才重新拉 */
    const userPrefs = (await settings.get(userId)).prefs;
    const feedVersion = `${await deps.repository.deviceFeedVersion(userId, dayStart(Date.now() - 86_400_000))}-${dayStart(Date.now()).slice(0, 10)}-${userPrefs.deviceReceipts}`;
    /* 到点提醒也从这条轮询捎回去，不另开通道。最多晚一次轮询（4.5 秒）*/
    const prefs = userPrefs.reminders;
    const active = prefs.enabled ? await reminders.activeFor(userId) : null;
    const reminder = active ? { id: active.id, title: deviceText(deviceReminderTitle(active.title)).slice(0, 40),
      body: deviceText(deviceReminderBody(active.title, active.body)).slice(0, 60),
      /* "今天 10:00" / "昨天 10:00" / "9月26日 10:00（5 天前）"：积压的旧提醒一眼看得出来 */
      at: deviceReminderWhen(active.remindAt),
      hold: prefs.mode === "until_ack", hideSec: prefs.mode === "auto_hide" ? prefs.autoHideSec : 0,
      vibrate: prefs.vibrate } : null;
    /* 最近一次「按住说」处理到哪了：设备松手后挂一条「处理中」，等到 done/none 再收。
     * s＋m（会话＋开始毫秒）让设备认出说的是不是它刚松手的那一次 */
    const t = await deps.repository.latestTalkStatus(userId);
    const talk = t ? { s: t.sessionId, m: t.startMs, st: t.state } : null;
    if (!head) return { pendingCount: 0, action: null, command, feedVersion, reminder, talk };
    // 设备只有 2 英寸屏和 1.5KB 响应缓冲：原话截到 60 字，正好是屏上两行。
    // 完整原文在网页和飞书上看。
    const clean = deviceText(head.evidence);
    const evidence = clean.length > 60 ? `${clean.slice(0, 60)}…` : clean;
    return { pendingCount: drafts.length, action: {
      id: head.id, tool: deviceTool(head.tool, request.headers["x-voxmind-protocol"] === "2"), title: deviceText(head.title), detail: deviceText(head.detail), evidence,
      confidence: head.confidence, revision: head.revision, createdAt: head.createdAt,
      // null = 不会过期；设备据此决定要不要显示倒计时
      expiresInSec: await actions.remainingSec(head),
    /* reminder 两个分支都要带。以前有待确认卡片时这里漏了它，设备那边按"服务器不再推＝
     * 别处已确认"把提醒收起；卡片处理完它又冒出来——看着像"隔一阵突然跳出一条旧提醒"。*/
    }, command, feedVersion, reminder, talk };
  });

  /* 设备屏幕的回执流（A 屏）和今日时刻表（B 屏）。
   * 字段都用短名、标题截到 16 字：设备响应缓冲只有 3KB，走的是 4G。
   * 设备只在 device-actions 里的 feedVersion 变了、或者每 5 分钟（刷新今日时长）才来拉。*/
  app.get("/v1/device-feed", { preHandler: requireDevice }, async (request) => {
    const native = request.headers["x-voxmind-protocol"] === "2";
    const userId = request.principal!.userId;
    const since = dayStart(Date.now());
    /* 回执范围按设置来：today＝今天零点以来办完的（以前是"最近 24 小时"，早上会看到昨晚的事）；
     * all＝累积，没在设备上划掉的都算，最新的 4 条上屏 */
    const scope = (await settings.get(userId)).prefs.deviceReceipts;
    const receiptsSince = scope === "all" ? new Date(0).toISOString() : since;
    const drafts = await deps.repository.deviceFeedDrafts(userId, since, receiptsSince);
    const clock = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, hour: "2-digit", minute: "2-digit" });
    /* 屏宽 240px、16px 字：一行 13 个字。列表上显示两行，点开的详情页能放三四行，
     * 所以发 40 个字过去——以前截到 15 个字，设备上连一行都没占满，点开也没别的可看。*/
    const short = (raw: string, max = 40) => { const text = deviceText(raw); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
    /* 办完的回执推不推到设备屏，按动作类型来（「执行规则」里每类一个开关）。
     * 失败的一律推——出了岔子必须让人知道，不能被"这类不通知"吞掉。*/
    const settled = drafts.filter((d) => (d.status === "executed" || d.status === "failed") && !d.dismissed);
    const notify = new Map<string, boolean>();
    for (const d of settled) {
      if (notify.has(d.tool)) continue;
      notify.set(d.tool, (await actions.policyFor(userId, d.tool, d.risk)).notifyDevice);
    }
    const receipts = settled.filter((d) => d.status === "failed" || notify.get(d.tool) !== false).slice(0, 4)
      .map((d) => ({ i: d.id, t: deviceTool(d.tool, native), n: short(d.title), s: d.status, a: clock(d.updatedAt),
        /* 点开详情时要看的原话：判断"是它听错了还是我说错了"就靠这句 */
        e: short(d.evidence, 60) }));
    /* 时刻表现在在设备上可以上下滚，多给几条 */
    const timeline = drafts.filter((d) => d.createdAt >= since && d.status !== "cancelled" && d.status !== "expired").slice(0, 10)
      .map((d) => ({ t: deviceTool(d.tool, native), n: short(d.title), s: d.status, a: clock(d.createdAt), e: short(d.evidence, 60) }));
    const totals = await deps.repository.dayTotals(userId, since);
    const done = drafts.filter((d) => d.createdAt >= since && d.status === "executed").length;
    return fitDeviceFeed({ receipts, timeline, today: { recordedSec: Math.round(totals.recordedMs / 1000), sentences: totals.sentences, done } },
      native ? DEVICE_FEED_BYTES.v2 : DEVICE_FEED_BYTES.legacy);
  });

  /* 网页「今天」顶上那一条：和设备屏上的数字同一个来源，两边对得上。再加今天花了多少钱。*/
  app.get("/v1/today", { preHandler: requireUser }, async (request) => {
    const userId = scopeOf(request);
    const since = dayStart(Date.now());
    const totals = await deps.repository.dayTotals(userId, since);
    const drafts = await deps.repository.listDrafts(userId);
    const todays = drafts.filter((d) => d.createdAt >= since);
    const usage = (await deps.repository.usageRollup(since, new Date(Date.now() + 60_000).toISOString()))
      .filter((r) => r.userId === userId);
    return { recordedSec: Math.round(totals.recordedMs / 1000), sentences: totals.sentences,
      done: todays.filter((d) => d.status === "executed").length,
      failed: todays.filter((d) => d.status === "failed").length,
      pending: drafts.filter((d) => d.status === "pending").length,
      costYuan: usage.reduce((n, r) => n + r.costYuan, 0) };
  });

  /* 设备上报「按住 OK 键说的这一段」。设备不知道当前是什么模式，一律上报，服务端决定用不用。*/
  app.post("/v1/device-marks", { preHandler: requireDevice }, async (request, reply) => {
    const body = z.object({ sessionId: z.string().uuid(), startMs: z.number().int().min(0),
      endMs: z.number().int().min(0) }).parse(request.body);
    if (body.endMs <= body.startMs) return reply.code(400).send({ error: "结束要在开始之后" });
    const session = await deps.repository.getSession(body.sessionId);
    if (!session || session.userId !== request.principal!.userId) return reply.code(404).send({ error: "会话不存在" });
    await deps.repository.addSpeechMark(body.sessionId, body.startMs, body.endMs);
    return { ok: true };
  });

  /* 设备上按了确认：这条提醒就算收到了，不再弹 */
  app.post("/v1/device-reminders/:id/ack", { preHandler: requireDevice }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const acked = await reminders.ack(id, request.principal!.userId);
    return acked ? { ok: true } : reply.code(404).send({ error: "提醒不存在" });
  });

  app.get("/v1/reminders", { preHandler: requireUser }, async (request) => ({
    reminders: await deps.repository.listReminders(scopeOf(request), 50),
  }));

  app.post("/v1/reminders/:id/ack", { preHandler: requireUser }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const acked = await reminders.ack(id, request.principal!.userId);
    return acked ? { reminder: acked } : reply.code(404).send({ error: "提醒不存在" });
  });

  app.post("/v1/device-receipts/:id/dismiss", { preHandler: requireDevice }, async (request, reply) => {
    const { id } = DraftParams.parse(request.params);
    const ok = await deps.repository.dismissDraftOnDevice(request.principal!.userId, id);
    return ok ? { ok } : reply.code(404).send({ error: "回执不存在或已经划掉了" });
  });
  app.post("/v1/device-actions/:id/confirm", { preHandler: requireDevice }, async (request, reply) => {
    const { id } = DraftParams.parse(request.params);
    const owned = await deps.repository.getDraft(id);
    if (!owned || owned.userId !== request.principal!.userId) return reply.code(404).send({ error: "动作卡片不存在" });
    const result = await actions.confirm(id);
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    await auditFrom(request, "draft.confirm", "draft", id, { tool: owned.tool, via: "device" });
    const execution = await executions.execute(result.draft);
    return { ...result, draft: await deps.repository.getDraft(id), execution };
  });
  app.post("/v1/device-actions/:id/cancel", { preHandler: requireDevice }, async (request, reply) => {
    const { id } = DraftParams.parse(request.params);
    const owned = await deps.repository.getDraft(id);
    if (!owned || owned.userId !== request.principal!.userId) return reply.code(404).send({ error: "动作卡片不存在" });
    const result = await actions.cancel(id);
    if (result.ok) await auditFrom(request, "draft.cancel", "draft", id, { tool: owned.tool, via: "device" });
    return result.ok ? result : reply.code(result.code).send({ error: result.error });
  });

  /* 设备心跳：电量/网络/固件版本。管理端的"设备中心"全靠它，以前这些数
   * 只在设备自己的串口诊断里打印，云端一无所知。*/
  app.post("/v1/device-heartbeat", { preHandler: requireDevice }, async (request) => {
    const beat = DeviceHeartbeat.parse(request.body ?? {});
    const deviceId = request.principal!.deviceId!;
    await identity.heartbeat(deviceId, beat);
    /* 升级信息搭心跳的顺风车：设备走 4G，能少一次连接就少一次 */
    const device = deviceId === "legacy-shared-key" ? null : await ota.confirmFromHeartbeat(deviceId, beat.firmware);
    return { ok: true, config: await deviceConfig(request.principal!.userId),
      ota: device ? await ota.offerFor(device) : null };
  });

  app.get("/v1/device-config", { preHandler: requireDevice }, async (request) => deviceConfig(request.principal!.userId));

  /* 耗电测量结果：设备脱离 USB 跑完一轮分阶段实验后整份上传。只存不算，分析时直接查库 */
  app.post("/v1/device-power-log", { preHandler: requireDevice }, async (request) => {
    const body = z.object({
      phases: z.array(z.object({ id: z.string().max(40), label: z.string().max(80), fromS: z.number(), toS: z.number() })).max(20),
      samples: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()])).max(2000),
    }).parse(request.body);
    await deps.repository.savePowerLog(request.principal!.deviceId ?? "unknown", request.principal!.userId, body);
    return { ok: true };
  });

  /* 网页选主题时画预览用：和推给设备的是同一份定义 */
  app.get("/v1/themes", { preHandler: requireUser }, async () => ({ themes: THEMES }));

  /* ────────────────────────────────────────────────────────────
   * 用户设置：档位、唤醒词、定时开关机
   * ──────────────────────────────────────────────────────────── */
  app.get("/v1/settings", { preHandler: requireUser }, async (request) => {
    const { userId } = z.object({ userId: z.string().optional() }).parse(request.query);
    return { settings: await settings.get(scopeOf(request, userId)) };
  });

  /* 记账的连接自检：只读地列一遍表字段，确认授权、表 ID、字段名都对得上。
   * 不写数据——验证不该往用户的表里塞测试记录。*/
  app.get("/v1/expense/check", { preHandler: requireUser }, async (request, reply) => {
    const s = await settings.get(scopeOf(request));
    const { appToken, tableId, fields } = s.prefs.expense;
    if (!appToken || !tableId) return reply.code(400).send({ error: "先填多维表格的 app_token 和 table_id" });
    try {
      const executor = new FeishuUserExecutor(deps.repository, new SecretBox(deps.config.TOKEN_ENCRYPTION_KEY));
      const names = await executor.bitableFields(appToken, tableId);
      const missing = Object.values(fields).filter((name) => !names.includes(name));
      return { ok: missing.length === 0, fields: names, missing };
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : "连不上这张表" });
    }
  });

  /* 我的花费：按功能分（转写、抽任务、拆主题、纪要、导图、聊天、搜索），今天 / 近 7 天 / 近 30 天。
   * 放在 AI 开关旁边——关哪个开关能省多少钱，一眼能看出来。*/
  app.get("/v1/my-costs", { preHandler: requireUser }, async (request) => {
    const userId = scopeOf(request);
    const bj = new Date(Date.now() + 8 * 3600_000);
    const todayStart = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - 8 * 3600_000;
    const from = new Date(todayStart - 29 * 86_400_000).toISOString();
    const rows = (await deps.repository.usageRollup(from, new Date(Date.now() + 60_000).toISOString()))
      .filter((r) => r.userId === userId);
    const today = new Date(todayStart + 8 * 3600_000).toISOString().slice(0, 10);
    const week = new Date(todayStart - 6 * 86_400_000 + 8 * 3600_000).toISOString().slice(0, 10);
    const featureOf = (r: (typeof rows)[number]) => r.feature || (r.kind === "asr" ? "asr" : r.kind === "embedding" ? "search" : "other");
    const features = new Map<string, { feature: string; today: number; week: number; month: number; calls: number }>();
    const days = new Map<string, number>();
    for (const r of rows) {
      const f = featureOf(r);
      const x = features.get(f) ?? { feature: f, today: 0, week: 0, month: 0, calls: 0 };
      x.month += r.costYuan; x.calls += r.calls;
      if (r.day >= week) x.week += r.costYuan;
      if (r.day === today) x.today += r.costYuan;
      features.set(f, x);
      days.set(r.day, (days.get(r.day) ?? 0) + r.costYuan);
    }
    return { features: [...features.values()].sort((a, b) => b.month - a.month),
      days: [...days].map(([day, costYuan]) => ({ day, costYuan })).sort((a, b) => a.day.localeCompare(b.day)) };
  });

  app.put("/v1/settings", { preHandler: requireUser }, async (request, reply) => {
    const body = z.object({ userId: z.string().optional(), tier: QualityTier.optional(),
      wakeWord: z.string().trim().min(2).max(8).regex(/^[\u4e00-\u9fa5]+$/, "唤醒词只能用汉字").optional(),
      retentionDays: z.number().int().min(0).max(3650).optional(),
      ledMode: LedMode.optional(),
      /* 偏好可以只传改了的那几项；ai 里也可以只传一个开关 */
      prefs: z.object({ playbackGain: UserPrefs.shape.playbackGain.removeDefault().optional(),
        screenOffSec: z.number().int().min(0).max(3600).optional(),
        screenWake: z.object({ onCard: z.boolean(), onDone: z.boolean(), onTap: z.boolean(), doubleTapOff: z.boolean() }).partial().optional(),
        deviceReceipts: z.enum(["today", "all"]).optional(),
        powerKey: z.enum(["hard", "soft"]).optional(),
        theme: UserPrefs.shape.theme.removeDefault().optional(),
        reminders: z.object({ enabled: z.boolean(), mode: z.enum(["until_ack", "auto_hide"]),
          autoHideSec: z.number().int().min(3).max(120), vibrate: z.boolean(),
          expireDays: z.union([z.literal(0), z.literal(1), z.literal(3), z.literal(7)]) }).partial().optional(),
        vocabulary: z.array(z.string().min(1).max(20)).max(100).optional(),
        chatPrompts: z.array(z.string().trim().min(1).max(60)).max(8).optional(),
        audio: z.object({ quality: z.enum(["smooth", "standard", "high"]),
          chunkSec: z.union([z.literal(5), z.literal(10), z.literal(15)]) }).partial().optional(),
        expense: z.object({ enabled: z.boolean(), appToken: z.string().max(100), tableId: z.string().max(100),
          fields: z.object({ note: z.string().max(40), dateText: z.string().max(40), date: z.string().max(40),
            amount: z.string().max(40), category: z.string().max(40) }).partial(),
          categories: z.array(z.string().max(20)).max(30), notifyFeishu: z.boolean() }).partial().optional(),
        topicIntervalHours: z.number().int().min(1).max(24).optional(),
        ai: z.object({ topics: z.boolean(), minutes: z.boolean(), mindmap: z.boolean(),
          scope: z.enum(["topic", "session"]), chat: z.boolean(),
          intentMode: z.enum(["auto", "push_to_talk"]), daily: z.boolean(), suggest: z.boolean(),
          speakers: z.boolean() }).partial().optional() }).optional(),
      schedule: PowerSchedule.optional() }).parse(request.body);
    const userId = scopeOf(request, body.userId);
    const current = await settings.get(userId);
    /* 指示灯只有管理员能改；成员提交的原值原样放过（整表保存时会带上它），改了才拦 */
    if (body.ledMode && body.ledMode !== current.ledMode && request.principal!.role !== "admin") {
      return reply.code(403).send({ error: "指示灯只能由管理员设置" });
    }
    if (body.schedule?.enabled && body.schedule.offAt === body.schedule.onAt) {
      return reply.code(400).send({ error: "关机和开机时间不能相同" });
    }
    const next = await settings.save({ userId, tier: body.tier ?? current.tier, wakeWord: body.wakeWord ?? current.wakeWord,
      retentionDays: body.retentionDays ?? current.retentionDays, schedule: body.schedule ?? current.schedule,
      ledMode: body.ledMode ?? current.ledMode,
      prefs: UserPrefs.parse({ ...current.prefs, ...body.prefs, ai: { ...current.prefs.ai, ...body.prefs?.ai },
        screenWake: { ...current.prefs.screenWake, ...body.prefs?.screenWake },
        reminders: { ...current.prefs.reminders, ...body.prefs?.reminders },
        audio: { ...current.prefs.audio, ...body.prefs?.audio },
        expense: { ...current.prefs.expense, ...body.prefs?.expense,
          fields: { ...current.prefs.expense.fields, ...body.prefs?.expense?.fields } } }) });
    /* 换了主题：塞一条"马上同步配置"给设备，它下一次轮询（几秒内）就会去拉，不用等一分钟一次的心跳 */
    if (next.prefs.theme !== current.prefs.theme) await deps.repository.enqueueDeviceCommand(userId, "sync_config");
    await auditFrom(request, "settings.update", "user", userId,
      { ...(body.tier ? { tier: body.tier } : {}), ...(body.wakeWord ? { wakeWord: body.wakeWord } : {}),
        ...(body.retentionDays !== undefined ? { retentionDays: body.retentionDays } : {}),
        ...(body.ledMode && body.ledMode !== current.ledMode ? { ledMode: body.ledMode } : {}),
        ...(body.prefs ? { prefs: body.prefs } : {}),
        ...(body.schedule ? { schedule: `${body.schedule.enabled ? "开" : "关"} ${body.schedule.offAt}→${body.schedule.onAt} ${body.schedule.mode}` } : {}) });
    return { settings: next };
  });
  app.get("/v1/tool-policies", { preHandler: requireUser }, async (request) => {
    const userId = scopeOf(request, z.object({ userId: z.string().optional() }).parse(request.query).userId);
    const configured = new Map((await deps.repository.listToolPolicies(userId)).map((policy) => [policy.tool, policy]));
    return { policies: await Promise.all(Object.entries(TOOL_RISKS).map(async ([tool, risk]) => ({
      ...(configured.get(tool) ?? await actions.policyFor(userId, tool, risk)), configured: configured.has(tool),
    }))) };
  });
  app.post("/v1/action-drafts/:id/confirm", { preHandler: requireUser }, async (request, reply) => {
    const { id } = DraftParams.parse(request.params);
    const owned = await deps.repository.getDraft(id);
    if (!owned || !mayAccess(request, owned.userId)) return reply.code(404).send({ error: "动作卡片不存在" });
    const result = await actions.confirm(id);
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    await auditFrom(request, "draft.confirm", "draft", id, { tool: owned.tool, via: "web" });
    const execution = await executions.execute(result.draft);
    return { ...result, draft: await deps.repository.getDraft(id), execution };
  });
  app.post("/v1/action-drafts/:id/cancel", { preHandler: requireUser }, async (request, reply) => {
    const { id } = DraftParams.parse(request.params);
    const owned = await deps.repository.getDraft(id);
    if (!owned || !mayAccess(request, owned.userId)) return reply.code(404).send({ error: "动作卡片不存在" });
    const result = await actions.cancel(id);
    if (result.ok) await auditFrom(request, "draft.cancel", "draft", id, { tool: owned.tool, via: "web" });
    return result.ok ? result : reply.code(result.code).send({ error: result.error });
  });
  app.post("/v1/action-drafts/:id/revise", { preHandler: requireUser }, async (request, reply) => {
    const { id } = DraftParams.parse(request.params);
    const owned = await deps.repository.getDraft(id);
    if (!owned || !mayAccess(request, owned.userId)) return reply.code(404).send({ error: "动作卡片不存在" });
    const patch = ReviseBody.parse(request.body);
    const result = await actions.revise(id, patch);
    if (result.ok) await auditFrom(request, "draft.revise", "draft", id, { tool: owned.tool, ...patch });
    return result.ok ? result : reply.code(result.code).send({ error: result.error });
  });

  app.put("/v1/tool-policies/:tool", { preHandler: requireUser }, async (request) => {
    const tool = z.object({ tool: z.string().min(1).max(160) }).parse(request.params).tool;
    const input = ToolPolicy.pick({ userId: true, confirmation: true, maxDraftAgeSec: true, notifyDevice: true, extract: true })
      .partial({ userId: true, notifyDevice: true, extract: true }).parse(request.body);
    const policy = ToolPolicy.parse({ ...input, userId: scopeOf(request, input.userId), tool,
      updatedAt: new Date().toISOString() });
    await auditFrom(request, "policy.update", "tool", tool, { confirmation: policy.confirmation });
    return { policy: await deps.repository.upsertToolPolicy(policy) };
  });

  app.post("/v1/executions/drain", { preHandler: requireAdmin }, async () => ({ results: await executions.drain() }));

  /* ────────────────────────────────────────────────────────────
   * 登录
   * ──────────────────────────────────────────────────────────── */
  app.post("/v1/auth/login", async (request, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1).max(200) }).parse(request.body);
    const result = await identity.login(body.email, body.password,
      String(request.headers["user-agent"] ?? ""), clientIp(request));
    if (!result.ok) return reply.code(401).send({ error: result.error });
    return reply
      .header("set-cookie", serializeSessionCookie(result.token, result.maxAgeSec, deps.config.cookieSecure))
      .send({ user: result.user });
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (token) await identity.logout(token);
    return reply.header("set-cookie", clearSessionCookie(deps.config.cookieSecure)).send({ ok: true });
  });

  /** 页面加载时问"我是谁"。401 就跳登录页。 */
  app.get("/v1/auth/me", { preHandler: requireUser }, async (request, reply) => {
    const principal = request.principal!;
    const user = await deps.repository.getUserById(principal.userId);
    if (!user) return reply.code(401).send({ error: "请先登录" });
    return { user: identity.publicUser(user), role: principal.role, via: principal.kind };
  });

  app.post("/v1/auth/password", { preHandler: requireUser }, async (request, reply) => {
    const body = z.object({ current: z.string().min(1), next: z.string().min(1) }).parse(request.body);
    const me = await deps.repository.getUserById(request.principal!.userId);
    if (!me) return reply.code(401).send({ error: "请先登录" });
    /* 改密码要验旧密码：会话被劫持的人不能顺手把账号锁死 */
    const check = await identity.login(me.email, body.current, "", clientIp(request));
    if (!check.ok) return reply.code(400).send({ error: "当前密码不对" });
    const result = await identity.setPassword(me.id, body.next);
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    await auditFrom(request, "auth.password_change", "user", me.id);
    // setPassword 已经踢掉了包括本次在内的所有会话，前端要重新登录
    return reply.header("set-cookie", clearSessionCookie(deps.config.cookieSecure)).send({ ok: true });
  });

  /* ────────────────────────────────────────────────────────────
   * 用户管理（管理员）
   * ──────────────────────────────────────────────────────────── */
  app.get("/v1/users", { preHandler: requireAdmin }, async () => ({ users: await deps.repository.listUsers() }));

  app.post("/v1/users", { preHandler: requireAdmin }, async (request, reply) => {
    const body = z.object({ email: z.string().email(), displayName: z.string().min(1).max(80),
      password: z.string().min(1).max(200), role: UserRole.default("member") }).parse(request.body);
    const result = await identity.createUser(body);
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    await auditFrom(request, "user.create", "user", result.user.id, { email: body.email, role: body.role });
    return reply.code(201).send({ user: result.user });
  });

  app.put("/v1/users/:id/role", { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const { role } = z.object({ role: UserRole }).parse(request.body);
    /* 不许把自己降级：否则一个人手滑就再也没有管理员了 */
    if (id === request.principal!.userId && role !== "admin") {
      return reply.code(400).send({ error: "不能取消自己的管理员权限" });
    }
    const result = await identity.setRole(id, role);
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    await auditFrom(request, "user.role_change", "user", id, { role });
    return { user: result.user };
  });

  app.put("/v1/users/:id/status", { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const { status } = z.object({ status: z.enum(["active", "disabled"]) }).parse(request.body);
    if (id === request.principal!.userId && status === "disabled") {
      return reply.code(400).send({ error: "不能停用自己" });
    }
    const result = await identity.setStatus(id, status);
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    await auditFrom(request, "user.status_change", "user", id, { status });
    return { user: result.user };
  });

  app.put("/v1/users/:id/password", { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const { password } = z.object({ password: z.string().min(1).max(200) }).parse(request.body);
    const result = await identity.setPassword(id, password);
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    await auditFrom(request, "user.password_reset", "user", id);
    return { user: result.user };
  });

  /* ────────────────────────────────────────────────────────────
   * 设备（管理员发放，成员只看自己的）
   * ──────────────────────────────────────────────────────────── */
  app.get("/v1/devices", { preHandler: requireUser }, async (request) => {
    const query = z.object({ userId: z.string().optional() }).parse(request.query);
    const principal = request.principal!;
    /* 管理员不传 userId 时看全部；成员永远只看自己的 */
    const scope = principal.role === "admin" ? query.userId : principal.userId;
    return { devices: await deps.repository.listDevices(scope) };
  });

  app.post("/v1/devices", { preHandler: requireAdmin }, async (request, reply) => {
    const body = z.object({ id: z.string().min(1).max(128), name: z.string().min(1).max(80),
      userId: z.string().min(1).max(128).default("owner") }).parse(request.body);
    if (await deps.repository.getDevice(body.id)) return reply.code(409).send({ error: "这个设备编号已经存在" });
    if (!(await deps.repository.getUserById(body.userId))) return reply.code(404).send({ error: "用户不存在" });
    const { device, key } = await identity.issueDevice(body.userId, body.id, body.name);
    await auditFrom(request, "device.issue", "device", device.id, { userId: body.userId });
    /* 明文密钥只在这一次响应里出现，库里只有哈希——关掉页面就找不回来了 */
    return reply.code(201).send({ device, key, notice: "这把密钥只显示这一次，请立刻写入设备" });
  });

  app.post("/v1/devices/:id/revoke", { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const device = await identity.revokeDevice(id);
    if (!device) return reply.code(404).send({ error: "设备不存在" });
    await auditFrom(request, "device.revoke", "device", id);
    return { device };
  });

  /* ────────────────────────────────────────────────────────────
   * 固件与远程升级
   * ──────────────────────────────────────────────────────────── */
  app.get("/v1/admin/firmware", { preHandler: requireAdmin }, async () => ({
    releases: await deps.repository.listFirmware(), devices: await deps.repository.listDevices() }));

  /* 上传固件：body 就是 .bin 本身。版本号从镜像里读，不让人填。 */
  app.post("/v1/admin/firmware", { preHandler: requireAdmin, bodyLimit: 6 * 1024 * 1024 }, async (request, reply) => {
    const { notes } = z.object({ notes: z.string().max(2000).default("") }).parse(request.query);
    const binary = request.body;
    if (!Buffer.isBuffer(binary) || !binary.length) return reply.code(400).send({ error: "请直接把 .bin 文件作为请求体上传" });
    let result;
    try {
      result = await ota.upload({ binary, notes, uploadedBy: request.principal!.userId ?? "admin" });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "固件文件读不懂" });
    }
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    await auditFrom(request, "firmware.upload", "firmware", result.release.id,
      { version: result.release.version, bytes: result.release.byteLength });
    return reply.code(201).send({ release: result.release });
  });

  /* 决定这一版推给谁。none＝先放着不推，all＝全部设备，devices＝只推给挑中的几台 */
  app.patch("/v1/admin/firmware/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ rollout: FirmwareRollout, deviceIds: z.array(z.string().max(128)).max(500).default([]),
      notes: z.string().max(2000).optional() }).parse(request.body);
    if (body.rollout === "devices" && !body.deviceIds.length) return reply.code(400).send({ error: "至少挑一台设备" });
    const release = await deps.repository.updateFirmware(id,
      { rollout: body.rollout, rolloutDeviceIds: body.rollout === "devices" ? body.deviceIds : [],
        ...(body.notes !== undefined ? { notes: body.notes } : {}) });
    if (!release) return reply.code(404).send({ error: "这一版固件不存在" });
    await auditFrom(request, "firmware.rollout", "firmware", id,
      { version: release.version, rollout: body.rollout, devices: body.deviceIds.length || "全部" });
    return { release };
  });

  app.delete("/v1/admin/firmware/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const release = await deps.repository.getFirmware(id);
    if (!release) return reply.code(404).send({ error: "这一版固件不存在" });
    if (release.rollout !== "none") return reply.code(409).send({ error: "这一版还在推送中，先停掉再删" });
    await ota.remove(id);
    await auditFrom(request, "firmware.delete", "firmware", id, { version: release.version });
    return { ok: true };
  });

  /* 设备下载固件。走设备密钥，不做公开链接——固件是能读出密钥的东西。 */
  app.get("/v1/device-firmware/:id", { preHandler: requireDevice }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const found = await ota.binary(id);
    if (!found) return reply.code(404).send({ error: "固件不存在" });
    /* 支持 Range：设备分段下载（每段 64KB），4G 断一下只重下那一段，不用从头再来。
     * 以前一次下完 4MB，三次升级都在 30%~80% 断掉、整个作废。*/
    const total = found.body.length;
    reply.header("content-type", "application/octet-stream").header("accept-ranges", "bytes")
      .header("x-firmware-sha256", found.release.sha256);
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(request.headers.range ?? ""));
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
      if (start >= total || start > end) return reply.code(416).header("content-range", `bytes */${total}`).send();
      return reply.code(206).header("content-range", `bytes ${start}-${end}/${total}`)
        .header("content-length", String(end - start + 1)).send(found.body.subarray(start, end + 1));
    }
    return reply.header("content-length", String(total)).send(found.body);
  });

  /* 设备上报升级进度。刷完重启后的心跳才是真的成功。 */
  app.post("/v1/device-ota", { preHandler: requireDevice }, async (request) => {
    const report = DeviceOtaReport.parse(request.body ?? {});
    const deviceId = request.principal!.deviceId!;
    if (deviceId !== "legacy-shared-key") await ota.report(deviceId, report);
    return { ok: true };
  });

  /* ────────────────────────────────────────────────────────────
   * 搜索与管理统计
   * ──────────────────────────────────────────────────────────── */
  /* 字面 + 语义混合搜索。
   * 字面命中排前面（人名、编号这类逐字更可靠），语义命中跟在后面，各自标出来源。
   *
   * 阈值 0.55 是拿 text-embedding-v4 实测出来的，不是拍的：这个模型的相似度基线很高，
   * 毫不相干的两句话也有 0.2~0.4。实测四个查询（2026-09-19，10 句语料）：
   *   「合同签了吗」→ 0.746 那个协议对方回了没 / 0.712 合同下周一签完 / 0.594 甲方说条款要改
   *                   ↓ 0.534 明天把发票寄过去（不相干）
   *   「开会安排」  → 0.610 周三下午三点跟客户开会 ↓ 0.462 帮我把这个记一下
   *   「吃饭」      → 0.561 中午吃什么点个外卖   ↓ 0.416 帮我把这个记一下
   *   「报销」      → 0.594 明天把发票寄过去     ↓ 0.466 那个协议对方回了没
   * 对的和错的之间的坎都落在 0.53~0.56，取 0.55。换嵌入模型必须重新测这条线。*/
  const SEMANTIC_FLOOR = 0.55;
  /** 字面 + 语义混合搜索（网页搜索和 AI 聊天共用） */
  const hybridSearch = async (q: string, limit: number, userId: string, mode: "hybrid" | "text" | "semantic" = "hybrid",
                              log?: FastifyRequest["log"]) => {
    const semanticReady = Boolean(deps.embeddings && deps.embeddings.name !== "disabled");
    const literal = mode === "semantic" ? [] : await deps.repository.searchTranscripts(q, limit, userId);
    const seen = new Set(literal.map((h) => `${h.sessionId}:${h.sequence}`));
    const hits: (SearchHit & { score: number; match: "text" | "semantic" })[] =
      literal.map((h) => ({ ...h, score: 1, match: "text" as const }));
    if (semanticReady && mode !== "text" && hits.length < limit) {
      try {
        const { vectors } = await deps.embeddings!.embed([q]);
        if (vectors[0]) {
          for (const hit of await deps.repository.semanticSearch(vectors[0], limit, userId)) {
            if (hit.score < SEMANTIC_FLOOR || seen.has(`${hit.sessionId}:${hit.sequence}`)) continue;
            hits.push({ ...hit, match: "semantic" });
            if (hits.length >= limit) break;
          }
        }
      } catch (error) {
        log?.warn({ error: String(error) }, "语义搜索失败，退回逐字匹配");
      }
    }
    return { hits, semanticReady };
  };

  app.get("/v1/search", { preHandler: requireUser }, async (request) => {
    const query = z.object({ q: z.string().trim().min(1).max(100),
      limit: z.coerce.number().int().min(1).max(100).default(40), userId: z.string().optional(),
      mode: z.enum(["hybrid", "text", "semantic"]).default("hybrid"),
      days: z.coerce.number().int().min(1).max(3650).optional() }).parse(request.query);
    const userId = scopeOf(request, query.userId);
    /* 按时间筛：多取一些再过滤，免得"近 7 天"被更早的高分结果挤掉 */
    const since = query.days ? Date.now() - query.days * 86_400_000 : 0;
    const found = await hybridSearch(query.q, query.days ? Math.min(100, query.limit * 3) : query.limit, userId, query.mode, request.log);
    const semanticReady = found.semanticReady;
    const hits = found.hits.filter((h) => Date.parse(h.sessionStartedAt) + h.startMs >= since).slice(0, query.limit);
    // 每条命中标出属于哪个主题；另外直接搜主题标题和概要
    const topics = await deps.repository.topicsForSessions([...new Set(hits.map((h) => h.sessionId))]);
    const withTopic = hits.map((h) => {
      const t = topics.find((x) => x.sessionId === h.sessionId && h.startMs >= x.startMs && h.startMs < x.endMs);
      return { ...h, topic: t ? { id: t.id, title: t.title } : null };
    });
    const topicHits = (await deps.repository.searchTopics(query.q, since ? 30 : 10, userId))
      .filter((t) => Date.parse(t.sessionStartedAt) + t.startMs >= since).slice(0, 10);
    return { hits: withTopic, topics: topicHits, semanticReady };
  });

  /* ────────────────────────────────────────────────────────────
   * AI：主题、纪要、思维导图、聊天
   * ──────────────────────────────────────────────────────────── */
  const TopicBody = z.object({ startMs: z.number().int().min(0), endMs: z.number().int().min(1),
    title: z.string().trim().min(1).max(80), summary: z.string().max(500).default(""),
    /** 客户/项目名：按人回看用 */
    label: z.string().max(40).optional() });
  const ownedTopic = async (request: FastifyRequest, id: string) => {
    const t = await deps.repository.getTopic(id);
    return t && mayAccess(request, t.userId) ? t : null;
  };
  const llmReady = () => Boolean(deps.llm?.enabled);

  app.get("/v1/sessions/:id/topics", { preHandler: requireUser }, async (request, reply) => {
    const { id } = SessionParams.parse(request.params);
    const session = await ownedSession(request, id);
    if (!session) return reply.code(404).send({ error: "录音不存在" });
    const topics = await deps.repository.listTopics(id);
    const outputs = await deps.repository.listOutputs([id, ...topics.map((t) => t.id)]);
    return { topics, outputs, templates: Object.entries(MINUTES_TEMPLATES).map(([key, t]) => ({ key, label: t.label })), aiReady: llmReady() };
  });

  app.post("/v1/sessions/:id/topics", { preHandler: requireUser }, async (request, reply) => {
    const { id } = SessionParams.parse(request.params);
    const session = await ownedSession(request, id);
    if (!session) return reply.code(404).send({ error: "录音不存在" });
    const body = TopicBody.parse(request.body);
    if (body.endMs <= body.startMs) return reply.code(400).send({ error: "结束要在开始之后" });
    const now = new Date().toISOString();
    const topic = await deps.repository.createTopic({ id: randomUUID(), sessionId: id, userId: session.userId, ...body,
      label: body.label ?? "", source: "user", createdAt: now, updatedAt: now });
    await auditFrom(request, "topic.create", "topic", topic.id, { title: topic.title });
    return reply.code(201).send({ topic });
  });

  /* 人改过的主题标成 user：以后重新拆分不会覆盖它 */
  /* 按客户/项目回看：销售和顾问是按人回看的，不是按天 */
  app.get("/v1/labels", { preHandler: requireUser }, async (request) => ({
    labels: await deps.repository.listTopicLabels(scopeOf(request)),
  }));
  app.get("/v1/labels/:label/topics", { preHandler: requireUser }, async (request) => {
    const { label } = z.object({ label: z.string().min(1).max(40) }).parse(request.params);
    return { topics: await deps.repository.topicsByLabel(scopeOf(request), label, 100) };
  });

  app.patch("/v1/topics/:id", { preHandler: requireUser }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const topic = await ownedTopic(request, id);
    if (!topic) return reply.code(404).send({ error: "主题不存在" });
    const body = TopicBody.partial().parse(request.body);
    const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as Partial<typeof topic>;
    const next = { ...topic, ...patch };
    if (next.endMs <= next.startMs) return reply.code(400).send({ error: "结束要在开始之后" });
    const updated = await deps.repository.updateTopic(id, { ...patch, source: "user", updatedAt: new Date().toISOString() });
    return { topic: updated };
  });

  app.delete("/v1/topics/:id", { preHandler: requireUser }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const topic = await ownedTopic(request, id);
    if (!topic) return reply.code(404).send({ error: "主题不存在" });
    await deps.repository.deleteTopic(id);
    await auditFrom(request, "topic.delete", "topic", id, { title: topic.title });
    return { ok: true };
  });

  /* 手动重新拆分整次录音：人工主题保留，AI 的全部重来。不受"自动拆主题"开关限制 */
  app.post("/v1/sessions/:id/topics/analyze", { preHandler: requireUser }, async (request, reply) => {
    const { id } = SessionParams.parse(request.params);
    const session = await ownedSession(request, id);
    if (!session) return reply.code(404).send({ error: "录音不存在" });
    if (!llmReady()) return reply.code(503).send({ error: "没有配置大模型" });
    const tier = (await settings.get(session.userId)).tier;
    await topicService.analyze(id, 0, Number.MAX_SAFE_INTEGER, tier);
    return { topics: await deps.repository.listTopics(id) };
  });

  app.post("/v1/outputs", { preHandler: requireUser }, async (request, reply) => {
    const body = z.object({ kind: z.enum(["minutes", "mindmap"]), targetType: z.enum(["topic", "session"]),
      targetId: z.string().uuid(), template: z.enum(Object.keys(MINUTES_TEMPLATES) as [MinutesTemplate, ...MinutesTemplate[]]).optional() })
      .parse(request.body);
    const owner = body.targetType === "topic" ? (await ownedTopic(request, body.targetId))?.userId
      : (await ownedSession(request, body.targetId))?.userId;
    if (!owner) return reply.code(404).send({ error: "找不到要生成的内容" });
    if (!llmReady()) return reply.code(503).send({ error: "没有配置大模型" });
    try {
      const s = await settings.get(owner);
      const output = await outputService.generate({ ...body, tier: s.tier, speakers: s.prefs.ai.speakers });
      return reply.code(201).send({ output });
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : "生成失败" });
    }
  });

  /* 每日小结：看某一天的，或者现在就生成一份（手动生成不受"自动写"开关限制） */
  const DayQuery = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
  app.get("/v1/daily", { preHandler: requireUser }, async (request) => {
    const { day } = DayQuery.parse(request.query);
    const userId = scopeOf(request);
    const d = day ?? beijingDay();
    const s = await settings.get(userId);
    return { day: d, output: await dailyService.get(userId, d), auto: s.prefs.ai.daily, aiReady: llmReady() };
  });
  app.post("/v1/daily", { preHandler: requireUser }, async (request, reply) => {
    const { day } = DayQuery.parse(request.body ?? {});
    const userId = scopeOf(request);
    if (!llmReady()) return reply.code(503).send({ error: "没有配置大模型" });
    try {
      const output = await dailyService.generate(userId, day ?? beijingDay(), (await settings.get(userId)).tier);
      return reply.code(201).send({ output });
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : "生成失败" });
    }
  });

  /* 纪要导出 Word。PDF 不在服务端生成——中文要嵌字体，为这点事背一个几兆的依赖不值，
   * 网页上提供"打印成 PDF"，浏览器自带的导出效果更好也更可控。*/
  app.get("/v1/outputs/:id/export.docx", { preHandler: requireUser }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const output = await deps.repository.getOutput(id);
    if (!output || !mayAccess(request, output.userId)) return reply.code(404).send({ error: "内容不存在" });
    if (output.kind !== "minutes" && output.kind !== "daily") {
      return reply.code(400).send({ error: "只有纪要和小结能导成 Word" });
    }
    const name = output.kind === "daily" ? `${output.template} 小结` : "会议纪要";
    const meta = `${new Date(output.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} 由 VoxMind 生成`;
    const buffer = markdownToDocx(output.content, name, meta);
    await auditFrom(request, "outputs.export_docx", "output", id, { kind: output.kind });
    return reply.type("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
      .header("content-disposition", `attachment; filename="voxmind-${output.kind}-${output.createdAt.slice(0, 10)}.docx"`)
      .header("cache-control", "private, no-store")
      .send(buffer);
  });

  /* 纪要里的待办 → 飞书任务卡片。要不要先问，照「执行规则」来 */
  app.post("/v1/outputs/:id/tasks", { preHandler: requireUser }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const userId = request.principal!.userId;
    if (!llmReady()) return reply.code(503).send({ error: "没有配置大模型" });
    try {
      const drafts = await dailyService.todosToTasks(id, userId, (await settings.get(userId)).tier);
      await auditFrom(request, "outputs.todos_to_tasks", "output", id, { count: drafts.length });
      return reply.code(201).send({ drafts: drafts.map((d) => ({ id: d.id, title: d.title, status: d.status })) });
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : "没能生成任务" });
    }
  });

  /* ────────────────────────────────────────────────────────────
   * 建议：看出来了但没替你做的事
   * ──────────────────────────────────────────────────────────── */
  app.get("/v1/suggestions", { preHandler: requireUser }, async (request) => {
    const q = z.object({ status: z.enum(["open", "accepted", "dismissed"]).optional(),
      sessionId: z.string().uuid().optional(), days: z.coerce.number().int().min(1).max(3650).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional() }).parse(request.query);
    const suggestions = await deps.repository.listSuggestions(scopeOf(request), {
      ...(q.status ? { status: q.status } : {}),
      ...(q.sessionId ? { sessionId: q.sessionId } : {}),
      ...(q.days ? { sinceIso: new Date(Date.now() - q.days * 86_400_000).toISOString() } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
    });
    return { suggestions };
  });

  /* 采纳：照它建一张真正的卡片，走和说话、聊天一样的确认规则。
   * 用户是自己点的，所以算 explicit——按「执行规则」多半直接执行。*/
  app.post("/v1/suggestions/:id/accept", { preHandler: requireUser }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const found = await deps.repository.getSuggestion(id);
    if (!found || !mayAccess(request, found.userId)) return reply.code(404).send({ error: "这条建议不存在" });
    if (found.status !== "open") return reply.code(409).send({ error: found.status === "accepted" ? "已经建过了" : "已经忽略了" });
    const risk = (TOOL_RISKS as Record<string, ActionDraft["risk"]>)[found.tool] ?? "personal_write";
    let args = found.args;
    if (found.tool === "expense.record") {
      const prefs = (await settings.get(found.userId)).prefs.expense;
      if (!prefs.appToken || !prefs.tableId) return reply.code(422).send({ error: "先在「我的 → 记账」里配好多维表格" });
      args = { ...args, appToken: prefs.appToken, tableId: prefs.tableId, fields: prefs.fields, notify: prefs.notifyFeishu,
        atMs: Number(args.atMs ?? Date.now()) };
    }
    const draft = await actions.createDraft({ sessionId: found.sessionId, userId: found.userId, tool: found.tool,
      title: found.title, detail: found.detail, args, evidence: found.evidence,
      evidenceStartMs: found.evidenceStartMs, evidenceEndMs: found.evidenceEndMs,
      confidence: found.confidence, mode: "explicit", risk });
    if (draft.status === "confirmed") await executions.execute(draft).catch(() => undefined);
    const updated = await deps.repository.updateSuggestion(id, { status: "accepted", draftId: draft.id });
    await auditFrom(request, "suggestion.accept", "suggestion", id, { tool: found.tool });
    return reply.code(201).send({ suggestion: updated, draft });
  });

  /* 批量忽略：勾选的几条（ids），或者某一天的全部（day=YYYY-MM-DD，按北京时间算那一天） */
  app.post("/v1/suggestions/dismiss", { preHandler: requireUser }, async (request, reply) => {
    const body = z.object({ ids: z.array(z.string().uuid()).max(500).optional(),
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
      .refine((b) => b.ids?.length || b.day, "要给 ids 或 day").parse(request.body);
    const targets: string[] = [];
    if (body.ids?.length) {
      for (const id of body.ids) {
        const found = await deps.repository.getSuggestion(id);
        if (found && mayAccess(request, found.userId) && found.status === "open") targets.push(id);
      }
    }
    if (body.day) {
      const from = Date.parse(`${body.day}T00:00:00+08:00`);
      const list = await deps.repository.listSuggestions(scopeOf(request), { status: "open", sinceIso: new Date(from).toISOString(), limit: 1000 });
      for (const sug of list) if (Date.parse(sug.createdAt) < from + 86_400_000) targets.push(sug.id);
    }
    const unique = [...new Set(targets)];
    if (!unique.length) return reply.code(404).send({ error: "没有要忽略的建议" });
    for (const id of unique) await deps.repository.updateSuggestion(id, { status: "dismissed" });
    await auditFrom(request, "suggestion.dismiss", "suggestion", unique[0]!, { count: unique.length, ...(body.day ? { day: body.day } : {}) });
    return { dismissed: unique.length };
  });

  app.post("/v1/suggestions/:id/dismiss", { preHandler: requireUser }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const found = await deps.repository.getSuggestion(id);
    if (!found || !mayAccess(request, found.userId)) return reply.code(404).send({ error: "这条建议不存在" });
    return { suggestion: await deps.repository.updateSuggestion(id, { status: "dismissed" }) };
  });

  /* ────────────────────────────────────────────────────────────
   * 自动化：到点自己做一件事
   * ──────────────────────────────────────────────────────────── */
  const AutomationBody = z.object({
    title: z.string().trim().min(1).max(80),
    schedule: AutomationSchedule,
    action: AutomationAction,
    enabled: z.boolean().optional(),
  });
  const ownedAutomation = async (request: FastifyRequest, id: string) => {
    const a = await deps.repository.getAutomation(id);
    return a && mayAccess(request, a.userId) ? a : null;
  };
  const withLabel = (a: Automation) => ({ ...a, scheduleLabel: scheduleLabel(a.schedule) });

  app.get("/v1/automations", { preHandler: requireUser }, async (request) => ({
    automations: (await deps.repository.listAutomations(scopeOf(request))).map(withLabel), aiReady: llmReady(),
  }));

  app.post("/v1/automations", { preHandler: requireUser }, async (request, reply) => {
    const body = AutomationBody.parse(request.body);
    try {
      const created = await automations.create({ ...body, userId: scopeOf(request), source: "web" });
      await auditFrom(request, "automation.create", "automation", created.id, { title: created.title });
      return reply.code(201).send({ automation: withLabel(created) });
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : "建不了" });
    }
  });

  app.patch("/v1/automations/:id", { preHandler: requireUser }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!await ownedAutomation(request, id)) return reply.code(404).send({ error: "这条自动化不存在" });
    const body = AutomationBody.partial().parse(request.body);
    const updated = await automations.update(id, body);
    if (!updated) return reply.code(404).send({ error: "这条自动化不存在" });
    await auditFrom(request, "automation.update", "automation", id, { enabled: updated.enabled });
    return { automation: withLabel(updated) };
  });

  app.delete("/v1/automations/:id", { preHandler: requireUser }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!await ownedAutomation(request, id)) return reply.code(404).send({ error: "这条自动化不存在" });
    await deps.repository.deleteAutomation(id);
    await auditFrom(request, "automation.delete", "automation", id, {});
    return { ok: true };
  });

  /* 立刻跑一次：改完之后想当场看结果，不用等到点 */
  app.post("/v1/automations/:id/run", { preHandler: requireUser }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const automation = await ownedAutomation(request, id);
    if (!automation) return reply.code(404).send({ error: "这条自动化不存在" });
    try {
      const result = await automations.run(automation);
      await deps.repository.updateAutomation(id, { lastRunAt: new Date().toISOString(), lastStatus: "手动运行：已执行" });
      await auditFrom(request, "automation.run", "automation", id, { title: automation.title });
      return { ok: true, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "执行失败";
      await deps.repository.updateAutomation(id, { lastRunAt: new Date().toISOString(), lastStatus: `手动运行失败：${message}`.slice(0, 200) });
      return reply.code(422).send({ error: message });
    }
  });

  app.post("/v1/chat", { preHandler: requireUser }, async (request, reply) => {
    const body = z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant"]),
      content: z.string().max(4000) })).min(1).max(40) }).parse(request.body);
    const userId = request.principal!.userId;
    const s = await settings.get(userId);
    if (!s.prefs.ai.chat) return reply.code(403).send({ error: "AI 聊天已在「我的 → AI 助手」里关闭" });
    if (!llmReady()) return reply.code(503).send({ error: "没有配置大模型" });
    const answer = await chatService.reply(userId, body.messages, s.tier);
    for (const a of answer.actions) await auditFrom(request, "chat.action", "draft", a.draftId, { tool: a.tool, status: a.status });
    return answer;
  });

  app.get("/v1/admin/overview", { preHandler: requireAdmin }, async () => {
    const feishu = await feishuOnboarding.status("owner");
    return { stats: await deps.repository.adminStats(),
      services: { executionMode: deps.config.EXECUTION_MODE,
        asr: { provider: deps.config.ASR_PROVIDER, model: deps.config.ASR_MODEL, ready: deps.config.ASR_PROVIDER !== "disabled" },
        llm: { provider: deps.config.LLM_PROVIDER, model: deps.config.LLM_MODEL || deps.config.ANTHROPIC_MODEL,
               ready: deps.config.LLM_PROVIDER !== "disabled" },
        feishu: { ready: feishu.authorized, appCreated: feishu.appCreated },
        webhook: { ready: Boolean(deps.config.WEBHOOK_ALLOWED_ORIGINS) },
        homeAssistant: { ready: Boolean(deps.config.HOME_ASSISTANT_URL && deps.config.HOME_ASSISTANT_TOKEN) } } };
  });

  app.get("/v1/admin/executions", { preHandler: requireAdmin }, async (request) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(60) }).parse(request.query);
    return { executions: await deps.repository.listRecentExecutions(limit) };
  });

  /* ────────────────────────────────────────────────────────────
   * 成本（管理员）
   * ──────────────────────────────────────────────────────────── */
  app.get("/v1/admin/costs", { preHandler: requireAdmin }, async (request) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(92).default(30) }).parse(request.query);
    // 按北京时间对齐到天：今天 00:00 往前推 days-1 天
    const bj = new Date(Date.now() + 8 * 3600_000);
    const todayStart = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - 8 * 3600_000;
    const from = new Date(todayStart - (days - 1) * 86_400_000).toISOString();
    const rows = await deps.repository.usageRollup(from, new Date(Date.now() + 60_000).toISOString());
    const book = await pricing.book();
    const users = await deps.repository.listUsers();
    const monthStart = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), 1) - 8 * 3600_000;
    const daysInMonth = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth() + 1, 0)).getUTCDate();
    const monthRows = await deps.repository.usageRollup(new Date(monthStart).toISOString(), new Date(Date.now() + 60_000).toISOString());
    const monthUsage = monthRows.reduce((n, r) => n + r.costYuan, 0);
    const elapsedDays = Math.max(1, (Date.now() - monthStart) / 86_400_000);
    return {
      rows, users: users.map((u) => ({ id: u.id, displayName: u.displayName })), prices: book,
      month: {
        usageYuan: monthUsage,
        serverYuan: book.serverMonthly * Math.min(1, elapsedDays / daysInMonth),
        // 按本月已过天数的日均外推整月，再加整月服务器费
        projectedYuan: (monthUsage / elapsedDays) * daysInMonth + book.serverMonthly,
        elapsedDays, daysInMonth,
      },
    };
  });

  app.get("/v1/admin/prices", { preHandler: requireAdmin }, async () => ({ prices: await pricing.book(), defaults: DEFAULT_PRICES }));

  app.put("/v1/admin/prices", { preHandler: requireAdmin }, async (request) => {
    const Price = z.object({ label: z.string().max(40), perSecond: z.number().min(0).max(1).optional(),
      inputPerM: z.number().min(0).max(1000).optional(), outputPerM: z.number().min(0).max(1000).optional(),
      source: z.string().max(120), verified: z.boolean() });
    const body = z.object({ serverMonthly: z.number().min(0).max(1_000_000), models: z.record(z.string(), Price) }).parse(request.body);
    await pricing.save(body as PriceBook);
    await auditFrom(request, "prices.update", "config", "prices", { serverMonthly: body.serverMonthly });
    return { prices: await pricing.book() };
  });

  /* ────────────────────────────────────────────────────────────
   * 审计日志（管理员）
   * ──────────────────────────────────────────────────────────── */
  app.get("/v1/audit", { preHandler: requireAdmin }, async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100),
      actorId: z.string().optional(), action: z.string().optional() }).parse(request.query);
    const filter = { ...(query.actorId ? { actorId: query.actorId } : {}),
                     ...(query.action ? { action: query.action } : {}) };
    return { entries: await deps.repository.listAudit(query.limit, filter) };
  });

  /* 库里一个账号都没有时建第一个管理员。已经有用户就是空操作。 */
  const bootstrap = await identity.bootstrap();
  if (bootstrap?.generatedPassword) {
    app.log.warn(`已创建初始管理员 ${bootstrap.email}，随机密码：${bootstrap.generatedPassword} —— 这行日志是唯一一次显示，请立刻登录并改掉`);
  } else if (bootstrap) {
    app.log.warn(`已创建初始管理员 ${bootstrap.email}（密码取自 BOOTSTRAP_ADMIN_PASSWORD）`);
  }

  return app;
}

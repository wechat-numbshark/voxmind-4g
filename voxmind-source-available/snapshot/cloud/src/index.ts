import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { FileObjectStore } from "./storage/file-store.js";
import { OtaService } from "./services/ota.js";
import { DailyService } from "./ai/daily.js";
import { SuggestService } from "./ai/suggest.js";
import { AutomationService } from "./services/automations.js";
import { ReminderService } from "./services/reminders.js";
import { AutomationExecutor } from "./connectors/automation.js";
import type { ToolExecutor } from "./connectors/types.js";
import { PostgresRepository } from "./store/postgres.js";
import { MockToolExecutor } from "./connectors/mock.js";
import { AliyunAsrProvider, AsrRouter, DashScopeAsrProvider, DashScopeRealtimeAsrProvider, MockAsrProvider, SenseVoiceAsrProvider } from "./asr/index.js";
import { startTranscriptionWorker, TranscriptionService } from "./services/transcription.js";
import { AnthropicIntentProvider, DisabledIntentProvider, IntentRouter, OpenAiCompatibleIntentProvider } from "./intent/provider.js";
import { PricingService } from "./services/pricing.js";
import { DisabledLlm, OpenAiCompatibleLlm } from "./ai/llm.js";
import { TopicService } from "./ai/topics.js";
import { OutputService } from "./ai/outputs.js";
import { DashScopeEmbeddingProvider, DisabledEmbeddingProvider } from "./search/embeddings.js";
import { SettingsService } from "./services/settings.js";
import { withDerivedCleanup } from "./audio/denoise.js";
import { SettingsToolExecutor, TOOL_NAMES, withSettingsTool } from "./services/settings-tool.js";
import { ActionService } from "./services/actions.js";
import { ExecutionService } from "./services/execution.js";
import { FeishuUserExecutor } from "./connectors/feishu-user.js";
import { RoutingToolExecutor } from "./connectors/router.js";
import { SecretBox } from "./security/secrets.js";
import { AllowlistedWebhookExecutor, HomeAssistantExecutor } from "./connectors/http-actions.js";
import { EvaExecutor } from "./connectors/eva.js";

const config = loadConfig();
const repository = new PostgresRepository(config.DATABASE_URL);
await repository.migrate();

/* 意图模型分两档：高质量档用 LLM_MODEL，经济档用 ECONOMY_LLM_MODEL（默认 qwen-flash，输入便宜 5 倍） */
const makeIntent = (model: string) => config.LLM_PROVIDER === "anthropic"
  ? new AnthropicIntentProvider(config.ANTHROPIC_API_KEY, model || config.ANTHROPIC_MODEL, config.EVA_DEVICE_HINTS)
  : config.LLM_PROVIDER === "openai-compatible"
    ? new OpenAiCompatibleIntentProvider({ baseUrl: config.LLM_BASE_URL, apiKey: config.LLM_API_KEY, model, deviceHints: config.EVA_DEVICE_HINTS })
    : new DisabledIntentProvider();
const intent = makeIntent(config.LLM_MODEL);
const intentRouter = new IntentRouter({
  high: intent,
  economy: config.LLM_PROVIDER === "openai-compatible" ? makeIntent(config.ECONOMY_LLM_MODEL) : intent,
});

/* 说出来的定时规则由自动化服务自己接住。服务要等执行链路建好才能构造（它自己也要执行动作），
 * 所以这里先放一个空壳，下面建好之后填进去——mock 模式下也走真的，定时规则本来就只写我们自己的库。*/
let automationBackend: ToolExecutor | null = null;
const automationExecutor: ToolExecutor = {
  execute: (draft) => {
    if (!automationBackend) throw new Error("自动化还没就绪，稍后再试");
    return automationBackend.execute(draft);
  },
};
const mock = new MockToolExecutor();
const evaLive = config.EVA_EXECUTION_MODE === "live" ||
  (config.EVA_EXECUTION_MODE === "inherit" && config.EXECUTION_MODE === "live");
if (evaLive && (!config.EVA_BASE_URL || !config.EVA_API_KEY)) {
  throw new Error("EVA live 模式需要配置 EVA_BASE_URL 和 EVA_API_KEY");
}
/* 独立拿一份引用：后台续期巡检要用同一个实例，它内部对刷新做了单航班去重 */
const feishuUser = config.EXECUTION_MODE === "live"
  ? new FeishuUserExecutor(repository, new SecretBox(config.TOKEN_ENCRYPTION_KEY))
  : null;
const executor = config.EXECUTION_MODE === "live" && feishuUser
  ? new RoutingToolExecutor({
      feishu: feishuUser,
      automation: automationExecutor,
      ...(config.WEBHOOK_ALLOWED_ORIGINS ? { webhook: new AllowlistedWebhookExecutor(config.WEBHOOK_ALLOWED_ORIGINS.split(",").map((x) => x.trim())) } : {}),
      ...(config.HOME_ASSISTANT_URL && config.HOME_ASSISTANT_TOKEN ? { homeAssistant: new HomeAssistantExecutor(config.HOME_ASSISTANT_URL, config.HOME_ASSISTANT_TOKEN) } : {}),
      ...(evaLive ? { eva: new EvaExecutor(config.EVA_BASE_URL, config.EVA_API_KEY, config.EVA_SITE_ID) } : { eva: mock }),
    })
  : new RoutingToolExecutor({ feishu: mock, webhook: mock, homeAssistant: mock,
      eva: evaLive ? new EvaExecutor(config.EVA_BASE_URL, config.EVA_API_KEY, config.EVA_SITE_ID) : mock,
      automation: automationExecutor });
/* 删音频时顺带删 AI 降噪缓存（保留期清理也走这里） */
const objects = withDerivedCleanup(new FileObjectStore(config.AUDIO_STORAGE_DIR));
const embeddings = config.EMBEDDING_PROVIDER === "dashscope" && config.DASHSCOPE_API_KEY
  ? new DashScopeEmbeddingProvider({ apiKey: config.DASHSCOPE_API_KEY, baseUrl: config.DASHSCOPE_BASE_URL,
      model: config.EMBEDDING_MODEL, dimensions: config.EMBEDDING_DIMENSIONS })
  : new DisabledEmbeddingProvider();
/* 拆主题、纪要、导图、聊天：和意图同一个 OpenAI 兼容接口、同一套档位 */
const llm = config.LLM_PROVIDER === "openai-compatible"
  ? new OpenAiCompatibleLlm({ baseUrl: config.LLM_BASE_URL, apiKey: config.LLM_API_KEY,
      highModel: config.LLM_MODEL, economyModel: config.ECONOMY_LLM_MODEL })
  : new DisabledLlm();
const app = await createApp({ config, repository, objects, executor, intent, embeddings, llm });

const highAsr = config.ASR_PROVIDER === "dashscope"
  ? new DashScopeAsrProvider({ apiKey: config.DASHSCOPE_API_KEY, model: config.ASR_MODEL, baseUrl: config.DASHSCOPE_BASE_URL })
  : config.ASR_PROVIDER === "aliyun"
  ? new AliyunAsrProvider({ appKey: config.ASR_APP_KEY, accessKeyId: config.ASR_ACCESS_KEY_ID,
      accessKeySecret: config.ASR_ACCESS_KEY_SECRET, gateway: config.ASR_GATEWAY })
  : new MockAsrProvider();
const economyAsr = config.ECONOMY_ASR === "sensevoice" && config.SENSEVOICE_URL
  ? new SenseVoiceAsrProvider({ url: config.SENSEVOICE_URL })
  : (config.ECONOMY_ASR === "funasr" || config.ECONOMY_ASR === "paraformer") && config.DASHSCOPE_API_KEY
    ? new DashScopeRealtimeAsrProvider({ apiKey: config.DASHSCOPE_API_KEY,
        model: config.ECONOMY_ASR === "funasr" ? "fun-asr-realtime" : "paraformer-realtime-v2" })
    : highAsr;
if (config.ECONOMY_ASR === "sensevoice" && !config.SENSEVOICE_URL) {
  app.log.warn("ECONOMY_ASR=sensevoice 但没配 SENSEVOICE_URL，经济档暂时用云端识别");
}

const reminderService = new ReminderService({ repository, settings: new SettingsService(repository, config.DEFAULT_TIER), logger: app.log });
const actions = new ActionService(repository, (draftId) => reminderService.cancelForDraft(draftId), app.log);
const executions = new ExecutionService(repository,
  withSettingsTool(executor, new SettingsToolExecutor(new SettingsService(repository, config.DEFAULT_TIER), repository, TOOL_NAMES)),
  (draft) => reminderService.scheduleForDraft(draft));
const transcription = new TranscriptionService({
  repository, objects, actions, executions, logger: app.log,
  asr: new AsrRouter({ high: highAsr, economy: economyAsr }),
  intent: intentRouter,
  settings: new SettingsService(repository, config.DEFAULT_TIER),
  embeddings,
  pricing: new PricingService(repository),
  // 「小沃小沃，关机」：给设备排一条软关机指令，设备下一次拉卡片（1.5 秒内）就会收到
  onPowerCommand: async (userId, command, segment) => {
    if (command === "off") await repository.enqueueDeviceCommand(userId, "soft_off");
    await repository.appendAudit({ at: new Date().toISOString(), actorType: "user", actorId: userId,
      action: command === "off" ? "power.voice_off" : "power.voice_on", targetType: "session", targetId: segment.sessionId,
      detail: { text: segment.text }, ip: "" });
    app.log.info({ userId, command, text: segment.text }, "识别到语音开关机指令");
  },
});
const stopWorker = config.PROCESSING_ENABLED && config.ASR_PROVIDER !== "disabled"
  ? startTranscriptionWorker(transcription, config.PROCESSING_INTERVAL_MS)
  : () => {};
/* 拆主题 + 自动纪要/导图：每分钟看一次哪些录音该拆了（结束 20 分钟后，或攒够用户设的小时数） */
const aiSettings = new SettingsService(repository, config.DEFAULT_TIER);
const aiPricing = new PricingService(repository);
const outputs = new OutputService({ repository, llm, pricing: aiPricing });
const topics = new TopicService({ repository, llm, settings: aiSettings, pricing: aiPricing, logger: app.log,
  onTopics: async (userId, sessionId, created, ended) => {
    const s = await aiSettings.get(userId);
    const made = await outputs.autoGenerate(s.prefs.ai, s.tier, sessionId, ended).catch((error) => {
      app.log.warn({ sessionId, error: String(error) }, "自动生成纪要/导图失败"); return 0; });
    if (made) app.log.info({ sessionId, made }, "自动生成纪要/导图");
    /* 漏网检查：这一段里有没有说过、但没让它办的事。用经济档模型，一个主题只问一次 */
    const found = await suggest.scanTopics(created, s.prefs, "economy");
    if (found) app.log.info({ sessionId, found }, "扫出可能漏了的事");
  } });
const suggest = new SuggestService({ repository, llm, pricing: aiPricing, logger: app.log });
const topicTimer = setInterval(() => void topics.tick(), 60_000);
/* 每日小结：打开了的用户，每晚 21:30 以后写一份。每 10 分钟看一次 */
const daily = new DailyService({ repository, llm, pricing: aiPricing, settings: aiSettings, actions });
const dailyTimer = setInterval(() => void daily.tick().then((made) => { if (made) app.log.info({ made }, "每日小结已生成"); })
  .catch((error) => app.log.warn({ error: String(error) }, "每日小结出错")), 10 * 60_000);
dailyTimer.unref();
topicTimer.unref();

const executionTimer = setInterval(() => void executions.drain(20), 5000);
executionTimer.unref();
void executions.drain(20);
/* 升级看门狗：升完 10 分钟没回来就停推，免得一个坏包让所有设备离线 */
const otaWatch = new OtaService(repository, objects, config.PUBLIC_BASE_URL);
const otaTimer = setInterval(() => void otaWatch.watchdog().then(async (stopped) => {
  for (const x of stopped) {
    app.log.error(x, "新固件升级后设备没回来，已自动停止推送");
    await repository.appendAudit({ at: new Date().toISOString(), actorType: "system", actorId: "ota-watchdog",
      action: "firmware.auto_stop", targetType: "firmware", targetId: x.releaseId,
      detail: { version: x.version, device: x.deviceId }, ip: "" });
  }
}).catch((error) => app.log.warn({ error: String(error) }, "升级看门狗出错")), 60_000);
otaTimer.unref();

/* 到点提醒：每分钟把到点的标成"已推"，设备下一次轮询就会拿到 */
const reminderTimer = setInterval(() => void reminderService.tick()
  .then((n) => { if (n) app.log.info({ n }, "到点提醒已推给设备"); })
  .catch((error) => app.log.warn({ error: String(error) }, "提醒调度出错")), 60_000);
reminderTimer.unref();

/* 自动化：每分钟看一眼有没有到点的 */
const expenseReader = config.EXECUTION_MODE === "live"
  ? (appToken: string, tableId: string, fields: { date: string; amount: string; category: string; note: string }, from: number, to: number) =>
      new FeishuUserExecutor(repository, new SecretBox(config.TOKEN_ENCRYPTION_KEY)).expenseRecords(appToken, tableId, fields, from, to)
  : undefined;
const automations = new AutomationService({ repository, actions, executions, settings: aiSettings, daily,
  ...(expenseReader ? { expenses: expenseReader } : {}), logger: app.log });
automationBackend = new AutomationExecutor(automations);
const automationTimer = setInterval(() => void automations.tick()
  .then((ran) => { if (ran) app.log.info({ ran }, "自动化已执行"); })
  .catch((error) => app.log.warn({ error: String(error) }, "自动化调度出错")), 60_000);
automationTimer.unref();

/* 飞书授权续期：刷新令牌 7 天一到期就只能重新扫码授权，所以不能等"要用的时候再刷"。
 * 每 6 小时巡检一次，剩不到 3 天就提前换；启动时先查一次。详见 keepAlive() 的注释。*/
const feishuRenewTimer = feishuUser ? setInterval(() => void keepFeishuAlive(), 6 * 3600_000) : null;
feishuRenewTimer?.unref();
void keepFeishuAlive();
async function keepFeishuAlive() {
  try {
    const result = await feishuUser?.keepAlive();
    if (!result) return;
    const until = new Date(result.refreshExpiresAt * 1000).toISOString();
    if (result.state === "renewed") app.log.info({ until }, "飞书授权已自动续期");
    /* 已经断了：续不回来，只能提醒去重新授权。每 6 小时一条，别人看日志时能看见 */
    else if (result.state === "expired") app.log.error({ until }, "飞书授权已过期，需要去控制台重新授权");
  } catch (error) { app.log.warn({ error: String(error) }, "飞书授权续期失败"); }
}

/* 超时作废扫描。没有它，C 类卡片会一直挂在设备和网页上等人确认 */
const expiryTimer = setInterval(() => void actions.expireStale(), 30_000);
expiryTimer.unref();
void actions.expireStale();

/* 保留期清理：到期的录音（音频+转写）删掉，动作记录保留。每 6 小时跑一次，
 * 每次最多删 500 块，避免一次删爆磁盘 IO。*/
/* 收藏夹的自动归档：每 10 分钟按关键词把新提到的录音收进去（手动拿出来过的不放回） */
const folderRuleTimer = setInterval(() => {
  void repository.applyFolderRules().then((n) => { if (n) app.log.info({ added: n }, "收藏夹自动归档"); })
    .catch((error) => app.log.warn({ error: String(error) }, "收藏夹自动归档失败"));
}, 10 * 60_000);
folderRuleTimer.unref();
const retentionTimer = setInterval(() => void cleanupRetention(), 6 * 3600_000);
retentionTimer.unref();
async function cleanupRetention() {
  try {
    const users = await repository.usersWithRetention();
    for (const { userId, retentionDays } of users) {
      const before = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
      const expired = await repository.expiredChunks(before, [userId], 500);
      if (!expired.length) continue;
      const bySession = new Map<string, number[]>();
      for (const c of expired) bySession.set(c.sessionId, [...(bySession.get(c.sessionId) ?? []), c.sequence]);
      let removed = 0;
      for (const [sessionId, sequences] of bySession) {
        for (const key of await repository.deleteChunks(sessionId, sequences)) {
          await objects.delete(key).catch(() => {});
          removed++;
        }
      }
      await repository.appendAudit({ at: new Date().toISOString(), actorType: "system", actorId: "retention",
        action: "audio.retention_delete", targetType: "user", targetId: userId,
        detail: { retentionDays, chunks: removed }, ip: "" });
      app.log.warn({ userId, retentionDays, chunks: removed }, "保留期清理：已删除过期录音");
    }
  } catch (error) {
    app.log.error({ error: String(error) }, "保留期清理失败");
  }
}
void cleanupRetention();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "正在优雅停机");
  stopWorker();
  clearInterval(executionTimer);
  clearInterval(topicTimer);
  clearInterval(expiryTimer);
  clearInterval(retentionTimer);
  await app.close();
  await repository.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: config.PORT, host: config.HOST });

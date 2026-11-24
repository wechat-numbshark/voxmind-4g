/**
 * 本地预览：内存库 + 示例数据，不连任何生产服务。
 *   npx tsx scripts/dev-preview.ts   → http://127.0.0.1:8090
 * 登录：owner@voxmind.local / preview-owner-pw（管理员），li@example.com / preview-member-pw（成员）
 *
 * 下面所有人名、句子、设备都是编的示例，只为看界面，不代表任何真实数据。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MockToolExecutor } from "../src/connectors/mock.js";
import { FileObjectStore } from "../src/storage/file-store.js";
import { MemoryRepository } from "../src/store/memory.js";
import { ActionService } from "../src/services/actions.js";
import { envelopeOf } from "../src/services/transcription.js";

const dir = await mkdtemp(join(tmpdir(), "voxmind-preview-"));
const repository = new MemoryRepository();
const objects = new FileObjectStore(dir);
const app = await createApp({
  config: loadConfig({ NODE_ENV: "development", AUDIO_STORAGE_DIR: dir, BOOTSTRAP_ADMIN_PASSWORD: "preview-owner-pw",
    ASR_PROVIDER: "dashscope", DASHSCOPE_API_KEY: "x", LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "x", LLM_MODEL: "qwen3.8-flash" }),
  repository, objects, executor: new MockToolExecutor(),
});

/* 5 秒 16kHz 的 PCM：一段轻微起伏的正弦，回放时能听到声音 */
function tone(freq: number) {
  const n = 16000 * 5, buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / 16000) * 3000 * (0.5 + 0.5 * Math.sin(i / 4000))), i * 2);
  return buf;
}

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const actions = new ActionService(repository);

const lines = [
  "早上先把周报的数据补齐，下午再对一遍。",
  "明天下午三点提醒我给张伟打电话，确认合同细节。",
  "这个方案我觉得风险主要在交付周期上。",
  "",
  "帮我跟王敏说一声，周五的评审挪到下午四点。",
  "记一下，客户说预算上限是八十万。",
  "把客厅的灯关了。",
  "会议纪要里要写清楚谁负责测试环境。",
  "下周三之前把报价单发给采购。",
  "",
  "午饭后去一趟银行。",
  "这个接口的超时时间改成十五秒试试。",
];

async function seedSession(userId: string, deviceId: string, startedMs: number, texts: string[], bootId: string | null = null) {
  const id = randomUUID();
  await repository.createSession({ id, deviceId, userId, startedAt: iso(startedMs), bootId });
  for (let seq = 0; seq < texts.length; seq++) {
    const body = tone(180 + seq * 20);
    const key = `preview/${id}/${seq}.pcm`;
    await objects.put(key, body, "audio/pcm");
    await repository.putChunk({ sessionId: id, sequence: seq, sha256: createHash("sha256").update(body).digest("hex"),
      objectKey: key, contentType: "audio/pcm", byteLength: body.length, startMs: seq * 5000, durationMs: 5000,
      uploadedAt: iso(startedMs + seq * 5000 + 1500) });
    await repository.saveEnvelope(id, seq, envelopeOf(body));
    await repository.finishTranscript({ sessionId: id, sequence: seq, text: texts[seq]!, startMs: seq * 5000, endMs: seq * 5000 + 5000,
      provider: "preview", status: "succeeded", error: null, createdAt: iso(startedMs + seq * 5000 + 3000), updatedAt: iso(startedMs + seq * 5000 + 3000) });
  }
  return id;
}

const today = await seedSession("owner", "demo-voxmind-not-a-real-device", now - 11 * 60_000 * 5, lines);
await seedSession("owner", "demo-voxmind-not-a-real-device", now - 26 * 3600_000, ["昨天的会先到这里。", "明早九点和设计过一遍首页。"]);
await repository.failTranscript(today, 3, "preview", "示例：识别服务超时");
/* 「按开机」：同一次开机中间暂停过一次（两段同一个开机号）；另一次开机正在录（最后一块 1 分钟内到的） */
await seedSession("owner", "demo-voxmind-not-a-real-device", now - 5 * 3600_000, ["上午先把需求过一遍。", "第二版原型下周给。"], "boot-am");
await seedSession("owner", "demo-voxmind-not-a-real-device", now - 4 * 3600_000, ["暂停回来了，接着说预算。", "预算先按六十万报。"], "boot-am");
await seedSession("owner", "demo-voxmind-not-a-real-device", now - 50_000, ["现在正在录的这一段。", "新的话会出现在最下面。"], "boot-now");

async function draft(seq: number, tool: string, risk: "record" | "personal_write" | "external_write" | "physical_control", title: string, detail: string, minutesAgo: number, mode: "explicit" | "suggested" = "explicit", confidence = 0.93) {
  const d = await actions.createDraft({ sessionId: today, userId: "owner", tool, title, detail, args: { seq },
    evidence: lines[seq]!, evidenceStartMs: seq * 5000, evidenceEndMs: seq * 5000 + 5000, confidence, mode, risk });
  // createDraft 按策略可能直接确认；预览要的是待签放，统一改回 pending 并把时间往前拨
  await repository.updateDraft(d.id, { status: "pending", createdAt: iso(now - minutesAgo * 60_000) });
  return d;
}
await draft(4, "feishu.message.send", "external_write", "告诉王敏：周五评审改到下午四点", "发给 王敏 · 飞书单聊", 4);
await draft(1, "feishu.calendar.create", "personal_write", "给张伟打电话，确认合同细节", "明天 15:00 · 提前 10 分钟提醒", 9);
await draft(6, "homeassistant.service.call", "physical_control", "关闭客厅灯", "light.living_room → off", 0.3);
await draft(8, "feishu.task.create", "personal_write", "报价单发给采购", "截止 下周三", 22, "suggested", 0.78);
const done1 = await draft(5, "note.create", "record", "客户预算上限八十万", "记到今天的笔记", 40);
await repository.updateDraft(done1.id, { status: "executed" });
const done2 = await draft(10, "feishu.task.create", "personal_write", "午饭后去银行", "今天 13:30", 55, "suggested", 0.66);
await repository.updateDraft(done2.id, { status: "cancelled" });

/* 建议：今天三条、昨天两条，看批量忽略、按天忽略 */
await repository.createSuggestions([
  ["把报价单发给采购", 20], ["记一下：客户预算八十万", 50], ["约设计过首页", 90], ["周五前交周报", 26 * 60], ["给财务打电话", 27 * 60],
].map(([title, minutesAgo]) => ({ id: randomUUID(), userId: "owner", sessionId: today, topicId: null, tool: "feishu.task.create",
  title: String(title), detail: "", args: {}, evidence: String(title), evidenceStartMs: null, evidenceEndMs: null, confidence: 0.7,
  status: "open" as const, draftId: null, createdAt: iso(now - Number(minutesAgo) * 60_000), updatedAt: iso(now - Number(minutesAgo) * 60_000) })));

/* 执行回执：一张成功、一张失败，让「执行记录」页有东西可看 */
for (const [d, status, error] of [[done1, "succeeded", null], [done2, "failed", "示例：飞书返回 99991663 token 过期"]] as const) {
  await repository.createExecution({ id: randomUUID(), draftId: d.id, idempotencyKey: `preview:${d.id}`, status,
    provider: "mock", externalId: status === "succeeded" ? "mock-task-7f3a" : null, result: {}, error,
    createdAt: iso(now - 30 * 60_000), updatedAt: iso(now - 30 * 60_000) });
}

/* 示例用量：过去 20 天，每天说话 1–2.5 小时，高质量档 */
for (let d = 19; d >= 0; d--) {
  const day = now - d * 86_400_000;
  const speechMs = Math.round((1 + Math.abs(Math.sin(d * 1.7)) * 1.5) * 3_600_000);
  await repository.recordUsage({ at: iso(day), userId: "owner", sessionId: null, kind: "asr", provider: "dashscope",
    model: "qwen3-asr-flash", tier: "high", audioMs: speechMs, inputTokens: 0, outputTokens: 0, costYuan: (speechMs / 1000) * 0.00024 });
  const calls = Math.round(speechMs / 40_000);
  await repository.recordUsage({ at: iso(day), userId: "owner", sessionId: null, kind: "llm", provider: "openai-compatible",
    model: "qwen3.8-flash", tier: "high", audioMs: 0, inputTokens: calls * 1100, outputTokens: calls * 60,
    costYuan: (calls * 1100 * 0.8 + calls * 60 * 2.7) / 1e6 });
}

const identity = { email: "li@example.com" };
await app.inject({ method: "POST", url: "/v1/users", headers: { authorization: "Bearer dev-admin-key-change-me" },
  payload: { email: identity.email, displayName: "李想（示例）", password: "preview-member-pw", role: "member" } });
await app.inject({ method: "POST", url: "/v1/devices", headers: { authorization: "Bearer dev-admin-key-change-me" },
  payload: { id: "demo-voxmind-not-a-real-device-2", name: "二号样机（示例）", userId: "owner" } });
await repository.updateDevice("demo-voxmind-not-a-real-device-2", { lastSeenAt: iso(now - 90_000), lastBatteryPct: 76, lastNetwork: "4G · 中国电信", firmware: "0.9.3-evt" });

await app.listen({ port: 8090, host: "127.0.0.1" });
console.log("预览已启动 http://127.0.0.1:8090");

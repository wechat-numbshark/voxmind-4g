import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MockToolExecutor } from "../src/connectors/mock.js";
import { envelopeOf } from "../src/services/transcription.js";
import { FileObjectStore } from "../src/storage/file-store.js";
import { MemoryRepository } from "../src/store/memory.js";

/* 导出和删除是用户的隐私底线（docs/20 §10）：删除不可逆，所以这里盯的是
 * 「只删该删的、别人删不动、已执行的动作记录不会被抹掉」。*/

const DEVICE_KEY = "test-device-key-123456";
const ADMIN_KEY = "test-admin-key-123456";

describe("导出与删除", () => {
  let dir: string;
  let repository: MemoryRepository;
  let objects: FileObjectStore;
  let app: Awaited<ReturnType<typeof createApp>>;
  let sessionId: string;
  const admin = { authorization: `Bearer ${ADMIN_KEY}` };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "voxmind-privacy-"));
    repository = new MemoryRepository();
    objects = new FileObjectStore(dir);
    app = await createApp({
      config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: DEVICE_KEY, ADMIN_API_KEY: ADMIN_KEY, AUDIO_STORAGE_DIR: dir,
        BOOTSTRAP_ADMIN_PASSWORD: "fixture-owner-pw" }),
      repository, objects, executor: new MockToolExecutor(),
    });
    sessionId = randomUUID();
    await repository.createSession({ id: sessionId, deviceId: "demo-voxmind-not-a-real-device", userId: "owner", startedAt: new Date().toISOString() });
    // 4 块，每块 5 秒的 PCM：第 n 块整块填 n，方便验证导出的是哪一段
    for (let seq = 0; seq < 4; seq++) {
      const pcm = Buffer.alloc(160_000);
      pcm.fill(seq + 1);
      const objectKey = `${sessionId}/${seq}.pcm`;
      await objects.put(objectKey, pcm, "audio/pcm");
      await repository.putChunk({ sessionId, sequence: seq, sha256: createHash("sha256").update(pcm).digest("hex"),
        objectKey, contentType: "audio/pcm", byteLength: pcm.length, startMs: seq * 5000, durationMs: 5000,
        uploadedAt: new Date().toISOString() });
      await repository.saveEnvelope(sessionId, seq, envelopeOf(pcm));
    }
  });

  afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  it("波形接口给出每块的包络，5 秒块 25 个点", async () => {
    const r = await app.inject({ method: "GET", url: `/v1/sessions/${sessionId}/waveform`, headers: admin });
    expect(r.statusCode).toBe(200);
    const chunks = r.json().chunks as { sequence: number; envelope: string }[];
    expect(chunks).toHaveLength(4);
    expect(Buffer.from(chunks[0]!.envelope, "base64")).toHaveLength(25);
  });

  it("导出一段的 WAV：长度正确、内容正是选中的那一段", async () => {
    // 这里验的是"导出的就是选中那一段"，关掉回放增益好直接比字节
    await app.inject({ method: "PUT", url: "/v1/settings", headers: admin, payload: { userId: "owner", prefs: { playbackGain: "original" } } });
    // 选 5~10 秒：正好是第 1 块
    const r = await app.inject({ method: "GET", url: `/v1/sessions/${sessionId}/export.wav?from=5000&to=10000`, headers: admin });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("audio/wav");
    const body = r.rawPayload;
    expect(body.subarray(0, 4).toString()).toBe("RIFF");
    expect(body.length).toBe(44 + 160_000);
    expect(body[44]).toBe(2);        // 第 1 块填的是 2
    expect(body[body.length - 1]).toBe(2);
  });

  it("一次最多导出 30 分钟", async () => {
    const r = await app.inject({ method: "GET", url: `/v1/sessions/${sessionId}/export.wav?from=0&to=${31 * 60_000}`, headers: admin });
    expect(r.statusCode).toBe(400);
  });

  it("删掉中间一段：音频文件真的没了，其余段不受影响", async () => {
    const r = await app.inject({ method: "DELETE", url: `/v1/sessions/${sessionId}/audio?from=5000&to=15000`, headers: admin });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ deleted: 2 });

    expect(await objects.get(`${sessionId}/1.pcm`)).toBeNull();
    expect(await objects.get(`${sessionId}/2.pcm`)).toBeNull();
    expect(await objects.get(`${sessionId}/0.pcm`)).not.toBeNull();
    expect(await objects.get(`${sessionId}/3.pcm`)).not.toBeNull();

    const left = await repository.listEnvelopes(sessionId);
    expect(left.map((c) => c.sequence)).toEqual([0, 3]);
    // 删除留痕
    const audit = await repository.listAudit(10, { action: "audio.delete" });
    expect(audit[0]).toMatchObject({ targetId: sessionId });
  });

  it("删除不会抹掉已经执行过的动作记录", async () => {
    const draft = await app.inject({ method: "POST", url: "/v1/action-drafts", headers: admin,
      payload: { sessionId, userId: "owner", tool: "note.create", title: "客户预算八十万", args: {},
        evidence: "客户说预算上限是八十万", evidenceStartMs: 5000, evidenceEndMs: 10_000,
        confidence: 0.9, mode: "explicit", risk: "record" } });
    expect(draft.statusCode).toBe(201);
    await app.inject({ method: "DELETE", url: `/v1/sessions/${sessionId}/audio?from=0&to=${20 * 60_000}`, headers: admin });
    const drafts = await repository.listDrafts("owner");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.evidence).toBe("客户说预算上限是八十万");
  });

  it("别人的录音导不走也删不掉", async () => {
    await app.inject({ method: "POST", url: "/v1/users", headers: admin,
      payload: { email: "other@voxmind.local", displayName: "别人", password: "fixture-member-pw", role: "member" } });
    const login = await app.inject({ method: "POST", url: "/v1/auth/login",
      payload: { email: "other@voxmind.local", password: "fixture-member-pw" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;

    expect((await app.inject({ method: "GET", url: `/v1/sessions/${sessionId}/waveform`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/v1/sessions/${sessionId}/export.wav`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/v1/sessions/${sessionId}/audio`, headers: { cookie } })).statusCode).toBe(404);
    // 确认真的没删掉
    expect(await objects.get(`${sessionId}/0.pcm`)).not.toBeNull();
  });
});

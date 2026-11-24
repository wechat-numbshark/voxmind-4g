import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MockToolExecutor } from "../src/connectors/mock.js";
import type { ActionDraft } from "../src/domain.js";
import { MemoryRepository } from "../src/store/memory.js";

/* 设备屏的回执流：执行完的事推到屏上，用户左右划掉就不再出现；
 * 设备靠 feedVersion 判断要不要重新拉，版本不变就不费 4G 流量。*/

const DEVICE = { "x-device-key": "test-device-key-123456" };

describe("设备回执流", () => {
  let repository: MemoryRepository;
  let app: Awaited<ReturnType<typeof createApp>>;
  const sessionId = randomUUID();

  async function draft(title: string, status: ActionDraft["status"], tool = "feishu.task.create", evidence = "", at?: string) {
    const now = at ?? new Date().toISOString();
    return repository.createDraft({ id: randomUUID(), sessionId, userId: "owner", tool, title, detail: "", args: {},
      evidence, evidenceStartMs: null, evidenceEndMs: null, confidence: 0.9, mode: "explicit", risk: "personal_write",
      status, revision: 1, idempotencyKey: randomUUID(), createdAt: now, updatedAt: now });
  }
  const feed = async () => (await app.inject({ method: "GET", url: "/v1/device-feed", headers: DEVICE })).json();
  const version = async () => (await app.inject({ method: "GET", url: "/v1/device-actions", headers: DEVICE })).json().feedVersion;

  beforeEach(async () => {
    repository = new MemoryRepository();
    app = await createApp({
      config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: "test-device-key-123456", ADMIN_API_KEY: "test-admin-key-123456",
        BOOTSTRAP_ADMIN_PASSWORD: "fixture-owner-pw" }),
      repository, executor: new MockToolExecutor(),
    });
    await repository.createSession({ id: sessionId, deviceId: "evt", userId: "owner", startedAt: new Date().toISOString() });
  });
  afterEach(async () => { await app.close(); });

  it("执行完的进回执，待确认和取消的不进；今日时刻表不含取消的", async () => {
    await draft("周五前交周报", "executed");
    await draft("给王总发消息", "pending", "feishu.message.send");
    await draft("算了不要了", "cancelled");
    const f = await feed();
    expect(f.receipts.map((r: { n: string }) => r.n)).toEqual(["周五前交周报"]);
    expect(f.timeline.map((r: { n: string }) => r.n).sort()).toEqual(["周五前交周报", "给王总发消息"].sort());
    expect(f.today.done).toBe(1);
  });

  it("划掉后不再出现在回执里，版本号跟着变", async () => {
    const d = await draft("周五前交周报", "executed");
    const before = await version();
    const r = await app.inject({ method: "POST", url: `/v1/device-receipts/${d.id}/dismiss`, headers: DEVICE });
    expect(r.statusCode).toBe(200);
    expect((await feed()).receipts).toHaveLength(0);
    expect(await version()).not.toBe(before);
    // 再划一次是 404，不会重复记
    expect((await app.inject({ method: "POST", url: `/v1/device-receipts/${d.id}/dismiss`, headers: DEVICE })).statusCode).toBe(404);
  });

  it("按动作类型决定推不推到屏上：关掉的不推，失败的一律推", async () => {
    await draft("买菜清单", "executed", "note.create");
    await draft("周五前交周报", "executed");
    // 默认都推
    expect((await feed()).receipts.map((r: { n: string }) => r.n).sort()).toEqual(["买菜清单", "周五前交周报"].sort());

    // 关掉记笔记和飞书任务：屏上就只剩失败的那条
    await repository.upsertToolPolicy({ userId: "owner", tool: "note.create", confirmation: "never",
      maxDraftAgeSec: 86_400, notifyDevice: false, updatedAt: new Date().toISOString() });
    await repository.upsertToolPolicy({ userId: "owner", tool: "feishu.task.create", confirmation: "explicit_only",
      maxDraftAgeSec: 86_400, notifyDevice: false, updatedAt: new Date().toISOString() });
    await draft("发消息没发出去", "failed", "feishu.message.send");
    await repository.upsertToolPolicy({ userId: "owner", tool: "feishu.message.send", confirmation: "always",
      maxDraftAgeSec: 900, notifyDevice: false, updatedAt: new Date().toISOString() });
    expect((await feed()).receipts.map((r: { n: string }) => r.n)).toEqual(["发消息没发出去"]);

    // 再把记笔记打开：它也回到屏上
    await repository.upsertToolPolicy({ userId: "owner", tool: "note.create", confirmation: "never",
      maxDraftAgeSec: 86_400, notifyDevice: true, updatedAt: new Date().toISOString() });
    expect((await feed()).receipts.map((r: { n: string }) => r.n).sort()).toEqual(["买菜清单", "发消息没发出去"].sort());
  });

  /* 北京时间今天零点前一分钟：昨天办完的事。用它而不是"30 小时前"——
   * 早上看到昨晚的回执正是用户报的问题，而昨晚 23:59 离现在往往不到 24 小时 */
  const lateYesterday = () => {
    const shifted = Date.now() + 8 * 3_600_000;
    return new Date(shifted - (shifted % 86_400_000) - 8 * 3_600_000 - 60_000).toISOString();
  };
  const setReceipts = (scope: "today" | "all") => app.inject({ method: "PUT", url: "/v1/settings",
    headers: { authorization: "Bearer test-admin-key-123456" }, payload: { prefs: { deviceReceipts: scope } } });

  it("回执默认只看今天：昨晚办完的不上屏；后台改成累积后出现，版本号跟着变", async () => {
    await draft("昨晚买大米", "executed", "expense.record", "", lateYesterday());
    await draft("今天交周报", "executed");
    expect((await feed()).receipts.map((r: { n: string }) => r.n)).toEqual(["今天交周报"]);

    const before = await version();
    expect((await setReceipts("all")).statusCode).toBe(200);
    // 草稿表没动，但范围变了：版本号必须变，否则设备要等 5 分钟兜底才重新拉
    expect(await version()).not.toBe(before);
    expect((await feed()).receipts.map((r: { n: string }) => r.n).sort()).toEqual(["今天交周报", "昨晚买大米"].sort());

    // 累积模式下划掉的照样不再出现
    const old = (await repository.listDrafts("owner")).find((d) => d.title === "昨晚买大米")!;
    await app.inject({ method: "POST", url: `/v1/device-receipts/${old.id}/dismiss`, headers: DEVICE });
    expect((await feed()).receipts.map((r: { n: string }) => r.n)).toEqual(["今天交周报"]);
  });

  it("长按录音键的关机方式随设备配置下发，默认真关机", async () => {
    const config = async () => (await app.inject({ method: "GET", url: "/v1/device-config", headers: DEVICE })).json();
    expect((await config()).powerKey).toBe("hard");
    await app.inject({ method: "PUT", url: "/v1/settings", headers: { authorization: "Bearer test-admin-key-123456" },
      payload: { prefs: { powerKey: "soft" } } });
    expect((await config()).powerKey).toBe("soft");
  });

  it("屏上有待确认卡片时，到点提醒照样下发（以前漏了，设备会把提醒收起、过一阵又冒出来）", async () => {
    await repository.createReminder({ id: randomUUID(), userId: "owner", draftId: null, title: "给王总回电话", body: "",
      remindAt: new Date(Date.now() - 60_000).toISOString(), status: "sent", sentAt: new Date().toISOString(),
      ackedAt: null, createdAt: new Date().toISOString() });
    const poll = async () => (await app.inject({ method: "GET", url: "/v1/device-actions", headers: DEVICE })).json();
    expect((await poll()).reminder?.title).toBe("给王总回电话");          // 没卡片
    await draft("明天早上10点去吃饭", "pending");
    const withCard = await poll();
    expect(withCard.action?.title).toBe("明天早上10点去吃饭");
    expect(withCard.reminder?.title).toBe("给王总回电话");                // 有卡片也得在
  });

  it("旧固件收到 IoT 动作时显示成智能家居，不再落入默认的待办标签", async () => {
    const d = await draft("打开空调", "pending", "iot.ir.send", "打开空调");
    const actions = (await app.inject({ method: "GET", url: "/v1/device-actions", headers: DEVICE })).json();
    expect(actions.action.tool).toBe("homeassistant.service.call");
    await repository.updateDraft(d.id, { status: "executed" });
    expect((await feed()).receipts[0].t).toBe("homeassistant.service.call");
    expect((await feed()).timeline[0].t).toBe("homeassistant.service.call");
  });

  it("协议2保留原生红外类型，并完整传输长中文回执；旧设备始终不超过缓冲", async () => {
    for (let i = 0; i < 10; i++) await draft("中".repeat(40), "executed", "iot.ir.send", "原".repeat(60));
    const legacy = await app.inject({ method: "GET", url: "/v1/device-feed", headers: DEVICE });
    expect(Buffer.byteLength(legacy.body)).toBeLessThanOrEqual(3071);
    expect(legacy.json().receipts).toHaveLength(4);
    expect(legacy.json().timeline.length).toBeGreaterThan(0);
    const modern = await app.inject({ method: "GET", url: "/v1/device-feed", headers: { ...DEVICE, "x-voxmind-protocol": "2" } });
    expect(Buffer.byteLength(modern.body)).toBeLessThanOrEqual(12287);
    expect(modern.json().receipts).toHaveLength(4);
    expect(modern.json().timeline).toHaveLength(10);
    expect(modern.json().receipts[0]).toMatchObject({ t: "iot.ir.send", n: "中".repeat(40), e: "原".repeat(60) });
    await draft("打开空调", "pending", "iot.ir.send");
    const pending = await app.inject({ method: "GET", url: "/v1/device-actions", headers: { ...DEVICE, "x-voxmind-protocol": "2" } });
    expect(pending.json().action.tool).toBe("iot.ir.send");
  });

  it("耗电测量记录：设备整份上传，原样存下；格式不对拒收", async () => {
    const payload = { phases: [{ id: "A", label: "录音中、黑屏", fromS: 0, toS: 480 }],
      samples: [[15, 0, 3912, 8650, -1250], [30, 0, 3910, 8648, -1260]] };
    const ok = await app.inject({ method: "POST", url: "/v1/device-power-log", headers: DEVICE, payload });
    expect(ok.statusCode).toBe(200);
    expect(repository.powerLogs).toHaveLength(1);
    expect(repository.powerLogs[0]!.payload).toEqual(payload);
    const bad = await app.inject({ method: "POST", url: "/v1/device-power-log", headers: DEVICE, payload: { samples: [[1, 2]] } });
    expect(bad.statusCode).toBe(400);
  });

  it("没有变化时版本号不变（设备据此不重复拉）", async () => {
    await draft("周五前交周报", "executed");
    expect(await version()).toBe(await version());
  });

  it("标题发 40 个字：列表上显示两行，点开的详情页还能再看几行", async () => {
    const long = "这是一个非常非常长的任务标题一定会超过四十个字所以最后一定会被截断并且带上省略号收尾";
    await draft(long, "executed");
    const r = (await feed()).receipts[0] as { n: string; e: string };
    expect(r.n.length).toBeLessThanOrEqual(40);
    expect(r.n.endsWith("…")).toBe(true);
    expect(r.n.length).toBeGreaterThan(16);          // 以前只发 16 个字，屏上一行都没占满
  });

  it("回执带上原话，设备点开能看见依据；太长的截到 60 字", async () => {
    await draft("周五前交周报", "executed", "feishu.task.create", "那个周报你周五之前给我发过来");
    expect((await feed()).receipts[0].e).toBe("那个周报你周五之前给我发过来");
    await draft("另一件事", "executed", "feishu.task.create", "原".repeat(80));
    const long = (await feed()).receipts.find((r: { n: string }) => r.n === "另一件事") as { e: string };
    expect(long.e.length).toBe(60);
    expect(long.e.endsWith("…")).toBe(true);
  });
});

describe("发给设备的文字", () => {
  it("字库外的字符去掉，「·」换成字库里有的「・」", async () => {
    const repository = new MemoryRepository();
    const app = await createApp({
      config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: "test-device-key-123456", ADMIN_API_KEY: "test-admin-key-123456",
        BOOTSTRAP_ADMIN_PASSWORD: "fixture-owner-pw" }),
      repository, executor: new MockToolExecutor(),
    });
    const now = new Date().toISOString();
    await repository.createDraft({ id: randomUUID(), sessionId: randomUUID(), userId: "owner", tool: "note.create",
      title: "买菜🥬·周五", detail: "", args: {}, evidence: "", evidenceStartMs: null, evidenceEndMs: null, confidence: 0.9,
      mode: "explicit", risk: "record", status: "executed", revision: 1, idempotencyKey: randomUUID(), createdAt: now, updatedAt: now });
    const f = (await app.inject({ method: "GET", url: "/v1/device-feed", headers: DEVICE })).json();
    expect(f.receipts[0].n).toBe("买菜・周五");
    await app.close();
  });

});

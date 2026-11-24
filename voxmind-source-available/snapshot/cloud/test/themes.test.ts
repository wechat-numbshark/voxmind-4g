import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MockToolExecutor } from "../src/connectors/mock.js";
import { MemoryRepository } from "../src/store/memory.js";
import { THEMES, THEME_ROLES, deviceTheme } from "../src/themes.js";

/* 设备屏幕主题。盯三件事：
 * 1. 颜色顺序和固件 ui_palette_t 一致——错一位，全屏颜色都会串
 * 2. 每套都看得清——2 寸屏，对比度不够的配色再好看也没用
 * 3. 推给设备的心跳响应塞得进设备 3KB 的接收缓冲 */

const DEVICE = { "x-device-key": "test-device-key-123456" };
const ADMIN = { authorization: "Bearer test-admin-key-123456" };

function luminance(hex: string) {
  const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe("主题定义", () => {
  it("每套都有全部 30 种颜色，都是 6 位十六进制", () => {
    expect(THEME_ROLES).toHaveLength(30);
    for (const t of THEMES) for (const r of THEME_ROLES) expect(t.colors[r], `${t.id}.${r}`).toMatch(/^[0-9A-F]{6}$/);
  });

  const header = join(dirname(fileURLToPath(import.meta.url)), "../../firmware/components/ui/include/ui.h");
  it.skipIf(!existsSync(header))("颜色顺序和固件 ui_palette_t 的字段顺序一致", () => {
    const src = readFileSync(header, "utf8");
    const body = /typedef struct \{\s*uint32_t([\s\S]*?);\s*\} ui_palette_t;/.exec(src)![1]!;
    const fields = body.split(",").map((f) => f.trim());
    const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    expect(fields.map(camel)).toEqual([...THEME_ROLES]);
    expect(src).toContain(`#define UI_THEME_COLORS ${THEME_ROLES.length}`);
  });

  /* [前景, 背景, 最低对比度, 说明]：正文 7、次要字 4.5、提示字和大字 3 */
  const PAIRS: [string, string, number, string][] = [
    ["ink", "paper", 7, "纸条正文"], ["ink2", "paper", 4.5, "次要字"], ["ink3", "paper", 3, "第三级字"],
    ["ink", "console", 7, "台面正文"], ["ink2", "console", 4.5, "台面次要字"], ["ink3", "console", 3, "台面提示"],
    ["onAct", "act", 3, "主按钮 24px 字"], ["headInk", "head", 4.5, "顶栏字"], ["headInk2", "head", 4.5, "顶栏日期"],
    ["headOk", "head", 3, "顶栏充电中"], ["headBad", "head", 3, "顶栏低电量"], ["clock", "head", 3, "顶栏大钟"],
    ["bigClock", "console", 3, "B 屏大钟"], ["extInk", "extTint", 4.5, "对外标签"], ["ownInk", "console", 4.5, "个人标签"],
    ["warn", "paper", 3, "作废倒计时"], ["nightInk", "night", 7, "夜间屏"], ["recd", "paper", 3, "记录类字"],
    ["phy", "paper", 3, "设备类字"], ["bad", "paper", 4.5, "失败字"],
  ];
  for (const t of THEMES) {
    it(`「${t.label}」每处文字都看得清`, () => {
      const c = t.colors as Record<string, string>;
      const weak = PAIRS.filter(([f, b, min]) => contrast(c[f]!, c[b]!) < min)
        .map(([f, b, min, what]) => `${what} ${contrast(c[f]!, c[b]!).toFixed(2)} < ${min}`);
      expect(weak).toEqual([]);
    });
  }
});

describe("推给设备", () => {
  async function app() {
    const repository = new MemoryRepository();
    const a = await createApp({
      config: loadConfig({ NODE_ENV: "test", DEVICE_API_KEY: "test-device-key-123456", ADMIN_API_KEY: "test-admin-key-123456",
        BOOTSTRAP_ADMIN_PASSWORD: "fixture-owner-pw" }),
      repository, executor: new MockToolExecutor(),
    });
    return { a, repository };
  }

  it("默认推经典那套；后台换了就推新的，并让设备马上来拉", async () => {
    const { a, repository } = await app();
    const config = async () => (await a.inject({ method: "GET", url: "/v1/device-config", headers: DEVICE })).json();
    expect((await config()).theme).toEqual(deviceTheme("classic"));

    const put = (theme: string) => a.inject({ method: "PUT", url: "/v1/settings", headers: ADMIN, payload: { prefs: { theme } } });
    expect((await put("papercut")).statusCode).toBe(200);
    expect((await config()).theme.id).toBe("papercut");
    expect(await repository.takeDeviceCommand("owner")).toBe("sync_config");

    // 没换（重复保存同一套）就不打扰设备
    await put("papercut");
    expect(await repository.takeDeviceCommand("owner")).toBeNull();
    expect((await put("rainbow")).statusCode).toBe(400);
    await a.close();
  });

  it("每套主题的心跳响应都塞得进设备 3KB 的接收缓冲（留 1KB 余量）", async () => {
    const { a } = await app();
    for (const t of THEMES) {
      await a.inject({ method: "PUT", url: "/v1/settings", headers: ADMIN, payload: { prefs: { theme: t.id } } });
      const r = await a.inject({ method: "POST", url: "/v1/device-heartbeat", headers: DEVICE, payload: { firmware: "1.0.0" } });
      expect(r.statusCode).toBe(200);
      expect(Buffer.byteLength(r.body), t.id).toBeLessThan(2048);
    }
    await a.close();
  });

  it("网页能拿到全部主题画预览", async () => {
    const { a } = await app();
    const r = (await a.inject({ method: "GET", url: "/v1/themes", headers: ADMIN })).json();
    expect(r.themes.map((t: { id: string }) => t.id)).toEqual(["classic", "dopamine", "papercut", "cool"]);
    await a.close();
  });
});

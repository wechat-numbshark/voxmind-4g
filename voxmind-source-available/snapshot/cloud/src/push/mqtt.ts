/**
 * 设备通道（MQTT）。
 *
 * ⚠ 时间窗约束：设备上传完成后只保持唤醒 30 秒（DEVICE_AWAKE_WINDOW_MS），
 *   之后 4G 进 PSM，下一次能收到推送可能要等一个 TAU 周期（默认 1 小时）。
 *   所以 ASR + 意图抽取必须在这 30 秒内跑完，否则"有网了马上处理"就不成立。
 *   跑不完的兜底：只推飞书，设备等下个周期。
 */
import mqtt, { type MqttClient } from "mqtt";
import { DEVICE_AWAKE_WINDOW_MS, type CardPush, type PendingCard, type CardStatus } from "../types.js";

export class DeviceChannel {
  private client: MqttClient;
  /** deviceId → 唤醒窗口结束时刻 */
  private awakeUntil = new Map<string, number>();

  constructor(url: string, opts: { username?: string; password?: string } = {}) {
    this.client = mqtt.connect(url, { ...opts, reconnectPeriod: 5000 });
    this.client.on("connect", () => console.info("[mqtt] 已连接"));
    this.client.on("error", (e) => console.error("[mqtt]", e.message));
  }

  /** 设备上传完成时调用，开启 30 秒窗口 */
  markAwake(deviceId: string) {
    this.awakeUntil.set(deviceId, Date.now() + DEVICE_AWAKE_WINDOW_MS);
  }

  isAwake(deviceId: string): boolean {
    return (this.awakeUntil.get(deviceId) ?? 0) > Date.now();
  }

  async pushCard(card: PendingCard): Promise<{ delivered: boolean; reason?: string }> {
    if (!this.isAwake(card.deviceId)) {
      return { delivered: false, reason: "设备已进 PSM，本次只走飞书通道" };
    }
    const payload: CardPush = {
      type: "card",
      card: {
        id: card.id, tier: card.tier, expiresAt: card.expiresAt,
        title: card.action.title, detail: card.action.detail,
      },
      feedback: { motorBuzzTimes: 2, led: "blue_breath" },  // 需求 §三：卡片到达短振两下
    };
    await this.client.publishAsync(`voxmind/${card.deviceId}/card`, JSON.stringify(payload), { qos: 1 });
    return { delivered: true };
  }

  async retract(card: PendingCard, reason: CardStatus) {
    await this.client.publishAsync(
      `voxmind/${card.deviceId}/card`,
      JSON.stringify({ type: "retract", cardId: card.id, reason }),
      { qos: 1 },
    );
  }

  onAck(handler: (deviceId: string, ack: unknown) => void) {
    this.client.subscribe("voxmind/+/ack", { qos: 1 });
    this.client.on("message", (topic, buf) => {
      const m = topic.match(/^voxmind\/([^/]+)\/ack$/);
      if (!m?.[1]) return;
      try { handler(m[1], JSON.parse(buf.toString())); }
      catch { console.warn("[mqtt] ack 解析失败", topic); }
    });
  }
}

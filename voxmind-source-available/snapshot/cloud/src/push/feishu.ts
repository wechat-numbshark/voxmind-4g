/**
 * 飞书通道 —— 解决"人已经走开了"。
 *
 * 需求 §2.2：卡片同时推设备和飞书，任一边点了另一边立即消失。
 * 飞书这条路是异步的、成本低，所以中等置信度(0.6~0.85)【只走飞书】，不打扰设备。
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { TIER_POLICY, type PendingCard, type CardStatus } from "../types.js";

export class FeishuChannel {
  private client: Lark.Client;

  constructor(appId: string, appSecret: string) {
    this.client = new Lark.Client({ appId, appSecret });
  }

  async pushCard(card: PendingCard, hint?: string): Promise<string | undefined> {
    const policy = TIER_POLICY[card.tier];
    const expireText = card.expiresAt
      ? `${new Date(card.expiresAt).toLocaleString("zh-CN")} 前有效`
      : "";

    const content = {
      config: { wide_screen_mode: true },
      header: {
        template: card.tier === "C_IMMEDIATE" ? "orange" : "blue",
        title: { tag: "plain_text", content: hint ?? card.action.title },
      },
      elements: [
        { tag: "div", text: { tag: "lark_md", content: `**${card.action.title}**\n${card.action.detail}` } },
        { tag: "note", elements: [{ tag: "plain_text", content: `原话：${card.action.evidence}` }] },
        ...(expireText ? [{ tag: "note", elements: [{ tag: "plain_text", content: expireText }] }] : []),
        {
          tag: "action",
          actions: policy.needsConfirm ? [
            { tag: "button", text: { tag: "plain_text", content: "确认执行" }, type: "primary",
              value: { cardId: card.id, decision: "confirm" } },
            { tag: "button", text: { tag: "plain_text", content: "丢弃" }, type: "default",
              value: { cardId: card.id, decision: "discard" } },
          ] : [],
        },
      ],
    };

    const res = await this.client.im.message.create({
      params: { receive_id_type: "user_id" },
      data: {
        receive_id: card.userId,
        msg_type: "interactive",
        content: JSON.stringify(content),
      },
    });
    return res.data?.message_id;
  }

  /** 撤回 = 把卡片改成不可点的记录态。不删消息，保留痕迹。 */
  async retract(card: PendingCard, reason: CardStatus) {
    if (!card.feishuMessageId) return;
    const label = {
      confirmed: "✅ 已在设备上确认", discarded: "已丢弃",
      expired: "⌛ 已过期作废", downgraded: "⌛ 超时，已转为仅记录",
      pending: "", 
    }[reason];
    await this.client.im.message.patch({
      path: { message_id: card.feishuMessageId },
      data: {
        content: JSON.stringify({
          config: { wide_screen_mode: true },
          elements: [
            { tag: "div", text: { tag: "lark_md", content: `~~${card.action.title}~~\n${label}` } },
          ],
        }),
      },
    });
  }
}

/**
 * 待确认队列 —— 双通道状态同步 + 过期回收。
 *
 * 两条容易写错的规则（需求 §2.1 / §2.3）：
 *  1) 【任一通道处理后，另一通道立即失效】。用户在飞书点了确认，
 *     设备上那张卡必须消失，否则会重复执行。
 *  2) 过期行为按分级不同：C 类直接作废（过期就没意义了），
 *     B 类降级为"只记录不执行"（事情还在，只是不打扰了）。
 */
import { TIER_POLICY, type PendingCard, type CardStatus, type PushChannel } from "../types.js";

export interface CardStore {
  put(card: PendingCard): Promise<void>;
  get(id: string): Promise<PendingCard | null>;
  listPending(userId: string): Promise<PendingCard[]>;
  update(id: string, patch: Partial<PendingCard>): Promise<void>;
  /** 取所有已过期但状态仍是 pending 的卡 */
  listExpired(now: number): Promise<PendingCard[]>;
}

export interface Notifier {
  /** 从某个通道撤回一张卡（设备端删卡 / 飞书端把卡片改成不可点） */
  retract(card: PendingCard, channel: PushChannel, reason: CardStatus): Promise<void>;
}

export class PendingQueue {
  constructor(private store: CardStore, private notify: Notifier) {}

  /**
   * 处理一次确认。来源可能是设备也可能是飞书。
   * 幂等：重复调用同一张已处理的卡不会重复执行。
   */
  async resolve(
    cardId: string,
    decision: "confirm" | "discard" | "skip",
    from: PushChannel,
  ): Promise<{ ok: boolean; card?: PendingCard; reason?: string }> {
    const card = await this.store.get(cardId);
    if (!card) return { ok: false, reason: "卡片不存在" };

    if (card.status !== "pending") {
      // 双通道并发点击会走到这里，属于正常情况，不是错误
      return { ok: false, card, reason: `已被处理：${card.status}` };
    }
    if (decision === "skip") {
      return { ok: true, card };   // 留在队列，不动状态
    }

    const status: CardStatus = decision === "confirm" ? "confirmed" : "discarded";
    await this.store.update(cardId, { status });

    // ★ 关键：撤回【另一个】通道上的卡片
    for (const ch of card.pushedTo) {
      if (ch !== from) await this.notify.retract(card, ch, status);
    }
    return { ok: true, card: { ...card, status } };
  }

  /** 定时任务调用（建议 30 秒一次）。C 类 15 分钟窗口需要这个精度。 */
  async sweepExpired(now = Date.now()): Promise<{ discarded: number; downgraded: number }> {
    const expired = await this.store.listExpired(now);
    let discarded = 0, downgraded = 0;

    for (const card of expired) {
      const policy = TIER_POLICY[card.tier];
      if (policy.onExpire === "discard") {
        await this.store.update(card.id, { status: "expired" });
        for (const ch of card.pushedTo) await this.notify.retract(card, ch, "expired");
        discarded++;
      } else if (policy.onExpire === "downgrade_to_A") {
        // 降级：不再打扰，但事情记下来（飞书那条保留为记录）
        await this.store.update(card.id, { status: "downgraded" });
        await this.notify.retract(card, "device", "downgraded");
        downgraded++;
      }
    }
    return { discarded, downgraded };
  }

  /** 设备待机主屏顶部要显示的"N 条待确认" */
  async pendingCount(userId: string): Promise<number> {
    return (await this.store.listPending(userId)).length;
  }
}

import { createHash, randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { ActionDraft, RiskLevel, ToolPolicy } from "../domain.js";
import type { Repository } from "../store/repository.js";

const DEFAULT_POLICY: Record<ActionDraft["risk"], Pick<ToolPolicy, "confirmation" | "maxDraftAgeSec" | "notifyDevice">> = {
  record: { confirmation: "never", maxDraftAgeSec: 86_400, notifyDevice: true },
  personal_write: { confirmation: "explicit_only", maxDraftAgeSec: 86_400, notifyDevice: true },
  external_write: { confirmation: "always", maxDraftAgeSec: 900, notifyDevice: true },
  physical_control: { confirmation: "explicit_only", maxDraftAgeSec: 60, notifyDevice: true },
  destructive: { confirmation: "always", maxDraftAgeSec: 300, notifyDevice: true },
};

export interface CreateDraftInput {
  sessionId: string;
  userId: string;
  tool: string;
  title: string;
  detail?: string | undefined;
  args: Record<string, unknown>;
  evidence?: string | undefined;
  evidenceStartMs?: number | null | undefined;
  evidenceEndMs?: number | null | undefined;
  confidence: number;
  mode: ActionDraft["mode"];
  risk: ActionDraft["risk"];
  /** 不管执行规则怎么设都先出卡片等人点头（比如用说话把某类动作改成「不用问我」） */
  forceConfirm?: boolean;
}

export class ActionService {
  constructor(private readonly repository: Repository,
    /** 退回/作废时把这张卡片的到点提醒一起撤掉 */
    private readonly onCancelled?: (draftId: string) => Promise<unknown>,
    private readonly logger?: FastifyBaseLogger) {}

  async policyFor(userId: string, tool: string, risk: RiskLevel): Promise<ToolPolicy> {
    const configured = await this.repository.getToolPolicy(userId, tool);
    if (configured) return configured;
    return { userId, tool, ...DEFAULT_POLICY[risk], extract: "follow", updatedAt: new Date(0).toISOString() };
  }

  /* 指纹要带上这句话在录音里的位置，不能只看"说了什么"。
   * 幂等键防的是同一句话被管道重复投递（转写/抽意图重试），而不是人把同一句话再说一遍。
   * 带上 evidenceStartMs：同一段重试还是同一个键（照样只出一张卡），隔几分钟再说一遍就是
   * 新的一张卡。2026-10-25 实测踩的就是这个：前一张卡因为飞书授权过期执行失败，用户
   * 一字不差地重说，指纹撞上那张失败的卡，createDraft 返回旧卡、状态不是 confirmed，
   * 于是什么都不发生——没有新卡片、没有重试、日志里一个字都没有。用户只看到屏上
   * 「处理中」挂满 90 秒，然后一句"还在处理，好了会弹出来"，再也没有下文。
   * 换个说法反而能成（指纹不同），所以现象看起来毫无规律。*/
  async createDraft(input: CreateDraftInput) {
    const now = new Date().toISOString();
    const fingerprint = createHash("sha256")
      .update(`${input.sessionId}\0${input.tool}\0${JSON.stringify(input.args)}\0${input.evidence ?? ""}` +
              `\0${input.evidenceStartMs ?? ""}`)
      .digest("hex");
    const policy = await this.policyFor(input.userId, input.tool, input.risk);
    const auto = !input.forceConfirm && (policy.confirmation === "never" ||
      (policy.confirmation === "explicit_only" && input.mode === "explicit"));
    const draft: ActionDraft = {
      id: randomUUID(), sessionId: input.sessionId, userId: input.userId,
      tool: input.tool, title: input.title, detail: input.detail ?? "", args: input.args,
      evidence: input.evidence ?? "", evidenceStartMs: input.evidenceStartMs ?? null,
      evidenceEndMs: input.evidenceEndMs ?? null, confidence: input.confidence,
      mode: input.mode, risk: input.risk, status: auto ? "confirmed" : "pending", revision: 1,
      idempotencyKey: `action:${fingerprint}`, createdAt: now, updatedAt: now,
    };
    const stored = await this.repository.createDraft(draft);
    /* 撞上幂等键是正常的（同一段话被重复投递就该只出一张卡），但必须留痕：
     * 这条路径一声不响，就等于"用户说了话、什么都没发生"查不出原因。*/
    if (stored.id !== draft.id)
      this.logger?.warn({ sessionId: input.sessionId, tool: input.tool, evidenceStartMs: input.evidenceStartMs ?? null,
        existingDraft: stored.id, existingStatus: stored.status }, "这句话已经出过卡片，不再重复生成");
    return stored;
  }

  /** 这张卡什么时候作废；null = 不作废。策略里一直有 maxDraftAgeSec，
   *  但在此之前没有任何代码读它：pending 卡片会永远挂着，需求里
   *  "C 类 15 分钟不确认就作废"（docs/20 §2.1）从来没真正生效过。 */
  async expiresAt(draft: ActionDraft): Promise<number | null> {
    if (draft.status !== "pending") return null;
    return this.deadlineFor(draft);
  }

  /** Also checked synchronously at confirmation/execution; the periodic sweep is only cleanup. */
  async deadlineFor(draft: ActionDraft): Promise<number> {
    const policy = await this.policyFor(draft.userId, draft.tool, draft.risk);
    return Date.parse(draft.createdAt) + policy.maxDraftAgeSec * 1000;
  }

  /** 还剩几秒。已过期或不过期都返回 null，调用方据此决定要不要显示倒计时 */
  async remainingSec(draft: ActionDraft): Promise<number | null> {
    const at = await this.expiresAt(draft);
    if (at === null) return null;
    const left = Math.round((at - Date.now()) / 1000);
    return left > 0 ? left : 0;
  }

  /** 把超时未确认的卡片标成 expired。由主循环定期调用。 */
  async expireStale(limit = 200) {
    const now = Date.now();
    let expired = 0;
    for (const draft of await this.repository.listPendingDrafts(limit)) {
      const at = await this.expiresAt(draft);
      if (at !== null && at <= now) {
        if (!await this.repository.transitionDraft(draft.id, "pending", "expired")) continue;
        await this.onCancelled?.(draft.id).catch(() => undefined);
        expired++;
      }
    }
    return expired;
  }

  async confirm(id: string) {
    const draft = await this.repository.getDraft(id);
    if (!draft) return { ok: false as const, code: 404, error: "动作卡片不存在" };
    if (draft.status === "cancelled" || draft.status === "expired") return { ok: false as const, code: 409, error: "动作已经取消或过期" };
    if (["confirmed", "executing", "executed"].includes(draft.status)) return { ok: true as const, draft, duplicate: true };
    const previous = await this.repository.getExecutionByDraft(id);
    if (previous?.status === "unknown" || (draft.status === "failed" && ["physical_control", "destructive"].includes(draft.risk)))
      return { ok: false as const, code: 409, error: "执行结果待核实，请重新发出指令，不能重放旧卡片" };
    if (await this.deadlineFor(draft) <= Date.now()) {
      if (await this.repository.transitionDraft(id, draft.status, "expired"))
        await this.onCancelled?.(id).catch(() => undefined);
      return { ok: false as const, code: 409, error: "动作已经过期，请重新发出指令" };
    }
    const next = await this.repository.transitionDraft(id, draft.status, "confirmed");
    if (!next) {
      const current = await this.repository.getDraft(id);
      if (current && ["confirmed", "executing", "executed"].includes(current.status))
        return { ok: true as const, draft: current, duplicate: true };
      return { ok: false as const, code: 409, error: "动作状态已变化，请刷新后重试" };
    }
    /* 几个候选里选中了这一个：同一批的其余卡片作废 */
    const choiceOf = draft.args.choiceOf;
    if (typeof choiceOf === "string")
      for (const other of await this.repository.listDrafts(draft.userId, "pending"))
        if (other.id !== id && other.args.choiceOf === choiceOf) await this.cancel(other.id);
    return { ok: true as const, draft: next!, duplicate: false };
  }

  async cancel(id: string) {
    const draft = await this.repository.getDraft(id);
    if (!draft) return { ok: false as const, code: 404, error: "动作卡片不存在" };
    if (["executing", "executed"].includes(draft.status)) return { ok: false as const, code: 409, error: "动作已经开始执行，不能取消" };
    if (draft.status === "cancelled") return { ok: true as const, draft, duplicate: true };
    const next = await this.repository.transitionDraft(id, draft.status, "cancelled");
    if (!next) return { ok: false as const, code: 409, error: "动作状态已变化，请刷新后重试" };
    await this.onCancelled?.(id).catch(() => undefined);
    return { ok: true as const, draft: next!, duplicate: false };
  }

  async revise(id: string, patch: { title?: string | undefined; detail?: string | undefined; args?: Record<string, unknown> | undefined }) {
    const draft = await this.repository.getDraft(id);
    if (!draft) return { ok: false as const, code: 404, error: "动作卡片不存在" };
    if (draft.status !== "pending") return { ok: false as const, code: 409, error: "只能修改待确认卡片" };
    const next = await this.repository.updateDraft(id, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
      ...(patch.args !== undefined ? { args: { ...draft.args, ...patch.args } } : {}),
      revision: draft.revision + 1,
    });
    return { ok: true as const, draft: next! };
  }
}

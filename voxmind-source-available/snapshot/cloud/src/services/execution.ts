import { randomUUID } from "node:crypto";
import type { ActionDraft, Execution } from "../domain.js";
import { NeedsChoiceError, type ToolExecutor } from "../connectors/types.js";
import type { Repository } from "../store/repository.js";
import { ActionService } from "./actions.js";

// Connector calls have 15–20s timeouts. A much older in-flight row is an interrupted call,
// whose outcome must be reconciled, not automatically sent to a physical device again.
export const EXECUTION_STALE_MS = 10 * 60_000;

export class ExecutionService {
  constructor(private readonly repository: Repository, private readonly executor: ToolExecutor,
    /** 任务真的建成了才排到点提醒：没建成的任务不该有闹钟 */
    private readonly onExecuted?: (draft: ActionDraft) => Promise<unknown>) {}

  async execute(draft: ActionDraft) {
    const current = await this.repository.getDraft(draft.id);
    if (!current || current.status !== "confirmed") return this.repository.getExecutionByDraft(draft.id);
    const now = new Date().toISOString();
    const seed: Execution = { id: randomUUID(), draftId: current.id, idempotencyKey: current.idempotencyKey, status: "queued", provider: "pending", externalId: null, result: {}, error: null, createdAt: now, updatedAt: now };
    const deadline = await new ActionService(this.repository).deadlineFor(current);
    const claimed = await this.repository.claimExecution(seed, new Date(deadline).toISOString());
    if (!claimed.claimed || !claimed.execution || !claimed.draft) return claimed.execution;
    // Execute the stored revision, never a stale card supplied by a concurrent HTTP request.
    draft = claimed.draft;
    let receipt;
    try {
      receipt = await this.executor.execute(draft);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      /* 有几个可能的目标、不敢替人挑：每个候选一张待确认卡片（设备上一张张过、网页上一起列），
       * 确认其中一张，其余的自动作废（见 ActionService.confirm）。原卡片收起，不再重试 */
      if (error instanceof NeedsChoiceError) {
        const execution = await this.repository.updateExecution(claimed.execution.id, { status: "failed", error: message });
        await this.repository.updateDraft(draft.id, { status: "cancelled", detail: `${message}，已拆成 ${error.options.length} 张卡片` });
        for (const [i, option] of error.options.entries()) {
          await this.repository.createDraft({ ...draft, id: randomUUID(), status: "pending", revision: 1,
            title: `${option.label}：${String(draft.args.text ?? draft.title)}`.slice(0, 60),
            detail: `${message}（第 ${i + 1}/${error.options.length} 个）`,
            args: { ...draft.args, ...option.args, choiceOf: draft.id },
            idempotencyKey: `${draft.idempotencyKey}:choice:${i}`, createdAt: now, updatedAt: now });
        }
        return execution;
      }
      const unknown = ["physical_control", "destructive"].includes(draft.risk);
      await this.repository.updateExecution(claimed.execution.id, { status: unknown ? "unknown" : "failed", error: message });
      await this.repository.updateDraft(draft.id, { status: "failed",
        ...(unknown ? { detail: `执行结果待核实，请确认设备状态后重新发出指令。${message}`.slice(0, 500) } : {}) });
      throw error;
    }
    // Persistence failures after provider success must never be rewritten as retryable provider failures.
    const execution = await this.repository.updateExecution(claimed.execution.id, { status: "succeeded", provider: receipt.provider, externalId: receipt.externalId, result: receipt.result, error: null });
    await this.repository.updateDraft(draft.id, { status: "executed" });
    await this.onExecuted?.(draft).catch(() => undefined);
    return execution;
  }

  async drain(limit = 20) {
    await this.repository.recoverStaleExecutions(new Date(Date.now() - EXECUTION_STALE_MS).toISOString());
    const drafts = await this.repository.listExecutableDrafts(limit);
    const results = [];
    for (const draft of drafts) {
      try { results.push({ draftId: draft.id, execution: await this.execute(draft) }); }
      catch (error) { results.push({ draftId: draft.id, error: error instanceof Error ? error.message : String(error) }); }
    }
    return results;
  }
}

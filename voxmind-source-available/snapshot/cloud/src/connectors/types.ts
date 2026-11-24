import type { ActionDraft } from "../domain.js";

export interface ToolReceipt {
  provider: string;
  externalId: string | null;
  result: Record<string, unknown>;
}

/** 执行到一半发现有几个可能的目标（比如几个名字差不多的群）、不敢替人挑：
 *  把每个候选的参数交回去，由执行服务拆成几张待确认卡片让人选一张 */
export class NeedsChoiceError extends Error {
  constructor(message: string, readonly options: { label: string; args: Record<string, unknown> }[]) { super(message); }
}

export interface ToolExecutor {
  execute(draft: ActionDraft): Promise<ToolReceipt>;
}


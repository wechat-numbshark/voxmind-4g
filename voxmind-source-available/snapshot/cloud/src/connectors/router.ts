import type { ActionDraft } from "../domain.js";
import type { ToolExecutor } from "./types.js";

export class RoutingToolExecutor implements ToolExecutor {
  constructor(private readonly routes: { feishu: ToolExecutor; webhook?: ToolExecutor; homeAssistant?: ToolExecutor;
    eva?: ToolExecutor; automation?: ToolExecutor }) {}
  async execute(draft: ActionDraft) {
    if (draft.tool === "note.create") return { provider: "voxmind", externalId: draft.id, result: { stored: true, note: draft.args } };
    if (draft.tool.startsWith("automation.") && this.routes.automation) return this.routes.automation.execute(draft);
    // 记账写的是飞书多维表格，和别的飞书动作同一套用户授权
    if (draft.tool.startsWith("feishu.") || draft.tool === "expense.record") return this.routes.feishu.execute(draft);
    if (draft.tool === "webhook.call" && this.routes.webhook) return this.routes.webhook.execute(draft);
    if (draft.tool === "homeassistant.service.call" && this.routes.homeAssistant) return this.routes.homeAssistant.execute(draft);
    if ((draft.tool.startsWith("iot.") || draft.tool.startsWith("irrigation.")) && this.routes.eva) return this.routes.eva.execute(draft);
    throw new Error(`工具尚未配置执行连接器：${draft.tool}`);
  }
}

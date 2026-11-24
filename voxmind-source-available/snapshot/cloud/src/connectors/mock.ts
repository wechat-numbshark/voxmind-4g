import type { ToolExecutor } from "./types.js";

export class MockToolExecutor implements ToolExecutor {
  async execute(draft: Parameters<ToolExecutor["execute"]>[0]) {
    return {
      provider: "mock",
      externalId: `mock-${draft.id}`,
      result: { ok: true, tool: draft.tool, args: draft.args, simulated: true },
    };
  }
}


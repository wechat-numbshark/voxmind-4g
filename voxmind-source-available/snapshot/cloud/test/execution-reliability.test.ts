import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ActionService } from "../src/services/actions.js";
import { ExecutionService, EXECUTION_STALE_MS } from "../src/services/execution.js";
import { MemoryRepository } from "../src/store/memory.js";
import type { ActionDraft, Execution } from "../src/domain.js";

async function setup(physical = true) {
  const repository = new MemoryRepository();
  const now = new Date().toISOString();
  const session = await repository.createSession({ id: randomUUID(), deviceId: "test", userId: "owner", startedAt: now });
  const draft = await repository.createDraft({ id: randomUUID(), sessionId: session.id, userId: "owner",
    tool: physical ? "iot.ir.send" : "note.create", title: "test", detail: "", args: {}, evidence: "test",
    evidenceStartMs: null, evidenceEndMs: null, confidence: 1, mode: "explicit",
    risk: physical ? "physical_control" : "record", status: "confirmed", revision: 1,
    idempotencyKey: randomUUID(), createdAt: now, updatedAt: now });
  return { repository, draft, actions: new ActionService(repository) };
}

describe("execution reliability", () => {
  it("concurrent HTTP and worker claims invoke the provider once", async () => {
    const { repository, draft } = await setup();
    let calls = 0;
    const service = new ExecutionService(repository, { execute: async () => {
      calls++; await new Promise((resolve) => setTimeout(resolve, 10));
      return { provider: "test", externalId: "receipt", result: {} };
    } });
    await Promise.all(Array.from({ length: 20 }, () => service.execute(draft)));
    expect(calls).toBe(1);
    expect((await repository.getDraft(draft.id))?.status).toBe("executed");
  });

  it("physical timeout stays unknown and neither drain nor reconfirm replays it", async () => {
    const { repository, draft, actions } = await setup();
    let calls = 0;
    const service = new ExecutionService(repository, { execute: async () => { calls++; throw new Error("timeout after send"); } });
    await expect(service.execute(draft)).rejects.toThrow("timeout");
    expect((await repository.getExecutionByDraft(draft.id))?.status).toBe("unknown");
    for (let i = 0; i < 3; i++) await service.drain();
    expect(calls).toBe(1);
    expect((await actions.confirm(draft.id)).ok).toBe(false);
  });

  it("permanent nonphysical errors stop retrying until an explicit confirm", async () => {
    const { repository, draft, actions } = await setup(false);
    let calls = 0;
    const service = new ExecutionService(repository, { execute: async () => { calls++; throw new Error("denied"); } });
    await expect(service.execute(draft)).rejects.toThrow("denied");
    await service.drain();
    expect(calls).toBe(1);
    expect((await actions.confirm(draft.id)).ok).toBe(true);
    await service.drain();
    expect(calls).toBe(2);
  });

  it("confirmation and execution enforce deadlines without waiting for the sweep", async () => {
    const { repository, draft, actions } = await setup();
    const old = new Date(Date.now() - 61_000).toISOString();
    await repository.updateDraft(draft.id, { createdAt: old, status: "pending" });
    expect((await actions.confirm(draft.id)).ok).toBe(false);
    expect((await repository.getDraft(draft.id))?.status).toBe("expired");
    await repository.updateDraft(draft.id, { status: "confirmed" });
    const service = new ExecutionService(repository, { execute: async () => { throw new Error("must not run"); } });
    expect(await service.execute(draft)).toBeNull();
    expect((await repository.getDraft(draft.id))?.status).toBe("expired");
  });

  it("interrupted running calls recover as unknown while persisted successes remain successes", async () => {
    const { repository, draft, actions } = await setup();
    const old = new Date(Date.now() - EXECUTION_STALE_MS - 1000).toISOString();
    const execution: Execution = { id: randomUUID(), draftId: draft.id, idempotencyKey: draft.idempotencyKey,
      status: "running", provider: "test", externalId: null, result: {}, error: null, createdAt: old, updatedAt: old };
    await repository.createExecution(execution);
    await repository.updateDraft(draft.id, { status: "executing" });
    const service = new ExecutionService(repository, { execute: async () => { throw new Error("must not replay"); } });
    await service.drain();
    expect((await repository.getExecutionByDraft(draft.id))?.status).toBe("unknown");
    expect((await actions.confirm(draft.id)).ok).toBe(false);
    repository.executions.set(execution.id, { ...execution, status: "succeeded" });
    await repository.updateDraft(draft.id, { status: "executing" });
    await service.drain();
    expect((await repository.getDraft(draft.id))?.status).toBe("executed");
  });

  it("a stale caller cannot overwrite a cancellation or substitute execution arguments", async () => {
    const { repository, draft, actions } = await setup();
    await actions.cancel(draft.id);
    const service = new ExecutionService(repository, { execute: async (_d: ActionDraft) => { throw new Error("must not run"); } });
    expect(await service.execute(draft)).toBeNull();
    expect((await repository.getDraft(draft.id))?.status).toBe("cancelled");
  });
});

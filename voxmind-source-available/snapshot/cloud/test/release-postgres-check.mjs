// Run against an isolated release-check database, never the production database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresRepository } from "../dist/store/postgres.js";
import { ActionService } from "../dist/services/actions.js";
import { ExecutionService } from "../dist/services/execution.js";

const target = new URL(process.env.TEST_DATABASE_URL || "");
if (!/^\/voxmind_release_[a-z0-9_]+_test$/.test(target.pathname)) throw new Error("Only an isolated release-check database is allowed");
const repository = new PostgresRepository(target.href);
try {
  await repository.migrate();
  const audioSession = await repository.createSession({ id: randomUUID(), userId: "owner", deviceId: "pipeline-test", startedAt: new Date().toISOString() });
  for (const sequence of [0, 40, 41, 42]) {
    await repository.putChunk({ sessionId: audioSession.id, sequence, startMs: sequence * 1000, durationMs: 1000,
      sha256: "a".repeat(64), objectKey: `test/${sequence}`, contentType: "audio/pcm", byteLength: 32000, uploadedAt: new Date().toISOString() });
    if (sequence !== 40) await repository.saveVad(audioSession.id, sequence,
      { speech: sequence !== 41, speechMs: sequence === 41 ? 0 : 1000, firstMs: 0, lastMs: 1000 });
  }
  await repository.addSpeechMark(audioSession.id, 40100, 42900);
  assert.deepEqual(await repository.sessionsWithSpeech(1), [{ sessionId: audioSession.id, firstSequence: 40 }]);
  assert.equal(await repository.claimRun(audioSession.id, [40,41,42]), false);
  assert.deepEqual((await repository.markedChunkStates(audioSession.id, 40100, 42900)).map(c => c.stage), ["pending", "silent", "speech"]);
  await repository.saveVad(audioSession.id, 40, { speech: true, speechMs: 1000, firstMs: 0, lastMs: 1000 });
  const claims = await Promise.all(Array.from({ length: 12 }, () => repository.claimRun(audioSession.id, [40,41,42])));
  assert.equal(claims.filter(Boolean).length, 1);
  await repository.finishRun({ sessionId: audioSession.id, sequence: 40, startMs: 40000, endMs: 43000,
    text: "simulated command", provider: "mock", status: "succeeded", error: null, kind: "speech", endSequence: 42,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, [41,42]);
  assert.deepEqual(await repository.sessionsWithSpeech(1), [{ sessionId: audioSession.id, firstSequence: 0 }]);
  console.log("Postgres pipeline check: marked priority, incomplete rollback, silent pause and 12-way atomic claim passed");
  const actions = new ActionService(repository);
  const session = await repository.createSession({ id: randomUUID(), userId: "owner", deviceId: "release-test", startedAt: new Date().toISOString() });
  const draft = await actions.createDraft({ sessionId: session.id, userId: "owner", tool: "iot.ir.send", title: "simulation",
    args: {}, confidence: 1, mode: "explicit", risk: "physical_control" });
  let calls = 0;
  const service = new ExecutionService(repository, { execute: async () => {
    calls++; await new Promise((resolve) => setTimeout(resolve, 15));
    return { provider: "simulated", externalId: "none", result: {} };
  } });
  await Promise.all(Array.from({ length: 24 }, () => service.execute(draft)));
  assert.equal(calls, 1);
  assert.equal((await repository.getDraft(draft.id)).status, "executed");
  const failed = await actions.createDraft({ sessionId: session.id, userId: "owner", tool: "iot.ir.send", title: "timeout",
    args: { case: "timeout" }, confidence: 1, mode: "explicit", risk: "physical_control" });
  const failing = new ExecutionService(repository, { execute: async () => { throw new Error("simulated lost acknowledgement"); } });
  await assert.rejects(() => failing.execute(failed));
  assert.equal((await repository.getExecutionByDraft(failed.id)).status, "unknown");
  assert.equal((await actions.confirm(failed.id)).ok, false);
  assert.equal((await failing.drain()).length, 0);
  const old = new Date(Date.now() - 61_000).toISOString();
  const expired = await repository.createDraft({ ...draft, id: randomUUID(), idempotencyKey: randomUUID(), status: "pending", createdAt: old, updatedAt: old });
  assert.equal((await actions.confirm(expired.id)).ok, false);
  assert.equal((await repository.getDraft(expired.id)).status, "expired");
  const interrupted = await repository.createDraft({ ...draft, id: randomUUID(), idempotencyKey: randomUUID(), status: "executing" });
  const stale = new Date(Date.now() - 11 * 60_000).toISOString();
  await repository.createExecution({ id: randomUUID(), draftId: interrupted.id, idempotencyKey: interrupted.idempotencyKey,
    status: "running", provider: "test", externalId: null, result: {}, error: null, createdAt: stale, updatedAt: stale });
  await service.drain();
  assert.equal((await repository.getExecutionByDraft(interrupted.id)).status, "unknown");
  assert.equal((await repository.getDraft(interrupted.id)).status, "failed");
  console.log("Postgres release check: migration, 24-way claim, unknown outcome, expiry and interrupted execution passed");
} finally {
  await repository.close();
}

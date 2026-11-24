import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PostgresRepository } from "../src/store/postgres.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgresRepository", () => {
  it("migrates and persists the session/chunk/draft/execution graph", async () => {
    const repository = new PostgresRepository(databaseUrl!);
    try {
      await repository.migrate();
      const now = new Date().toISOString();
      const session = await repository.createSession({ id: randomUUID(), deviceId: "integration-device", userId: "owner", startedAt: now });
      const chunk = { sessionId: session.id, sequence: 0, sha256: "a".repeat(64), objectKey: `${session.id}/0.opus`, contentType: "audio/opus", byteLength: 10, startMs: 0, durationMs: 5000, uploadedAt: now };
      expect((await repository.putChunk(chunk)).created).toBe(true);
      expect((await repository.putChunk(chunk)).created).toBe(false);

      const draftId = randomUUID();
      const draft = await repository.createDraft({ id: draftId, sessionId: session.id, userId: "owner", tool: "feishu.task.create", title: "集成测试", detail: "", args: { summary: "集成测试" }, evidence: "", evidenceStartMs: null, evidenceEndMs: null, confidence: 1, mode: "explicit", risk: "personal_write", status: "confirmed", revision: 1, idempotencyKey: `test:${draftId}`, createdAt: now, updatedAt: now });
      const executionId = randomUUID();
      expect((await repository.createExecution({ id: executionId, draftId: draft.id, idempotencyKey: draft.idempotencyKey, status: "queued", provider: "test", externalId: null, result: {}, error: null, createdAt: now, updatedAt: now })).created).toBe(true);
      expect((await repository.createExecution({ id: randomUUID(), draftId: draft.id, idempotencyKey: draft.idempotencyKey, status: "queued", provider: "test", externalId: null, result: {}, error: null, createdAt: now, updatedAt: now })).created).toBe(false);
      const timeline = await repository.listTimeline(session.id);
      expect(timeline).toMatchObject({ session: { id: session.id }, chunks: [{ sequence: 0 }], drafts: [{ id: draftId }], executions: [{ id: executionId }] });
    } finally {
      await repository.close();
    }
  }, 30_000);
});

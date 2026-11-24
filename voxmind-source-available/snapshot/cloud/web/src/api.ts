import type { ActionDraft, AiOutput, AudioChunk, MindNode, Session, Timeline, ToolPolicy, Topic } from "../../src/domain.ts";
import type { AuditEntry, Device, User, UserRole } from "../../src/identity/types.ts";
import type { FirmwareRelease, FirmwareRollout } from "../../src/ota/types.ts";

export type { ActionDraft, AiOutput, AudioChunk, AuditEntry, Device, MindNode, Topic, FirmwareRelease, FirmwareRollout, Session, Timeline, ToolPolicy, User, UserRole };

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** 会话在 httpOnly cookie 里，脚本碰不到——这里只管带上同源 cookie。 */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 401 && path !== "/v1/auth/login") {
    window.dispatchEvent(new Event("voxmind:signed-out"));
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, (data as { error?: string }).error ?? `请求失败（${response.status}）`);
  return data as T;
}

export const api = {
  get:  <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put:  <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del:  <T>(path: string) => request<T>("DELETE", path),
  /** 上传固件：请求体就是 .bin 本身，不走 JSON 也不走 multipart */
  upload: <T>(path: string, file: File) => requestBinary<T>(path, file),
};

async function requestBinary<T>(path: string, file: File): Promise<T> {
  const response = await fetch(path, { method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/octet-stream" }, body: file });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, (data as { error?: string }).error ?? `上传失败（${response.status}）`);
  return data as T;
}

export interface Me { user: User; role: UserRole; via: string }
export interface DeviceCard { pendingCount: number }
export interface Policy extends ToolPolicy { configured: boolean }

export interface SearchHit {
  sessionId: string; sequence: number; text: string; startMs: number; endMs: number;
  sessionStartedAt: string; deviceId: string; userId: string;
}

export interface Overview {
  stats: {
    users: number; devicesActive: number; devicesOnline: number; chunks24h: number; audioMs24h: number;
    audioBytesTotal: number; transcriptsQueued: number; transcriptsFailed: number; draftsPending: number;
    executions24h: number; executionsFailed: number; lastUploadAt: string | null;
  };
  services: {
    executionMode: "mock" | "live";
    asr: { provider: string; model: string; ready: boolean };
    llm: { provider: string; model: string; ready: boolean };
    feishu: { ready: boolean; appCreated: boolean };
    webhook: { ready: boolean };
    homeAssistant: { ready: boolean };
  };
}

export interface ExecutionRow {
  id: string; draftId: string; status: string; provider: string; externalId: string | null;
  error: string | null; createdAt: string; updatedAt: string; tool: string; title: string; userId: string;
}

/** 回放要带 cookie，<audio src> 本身就会带同源 cookie，直接给地址即可。 */
export const audioUrl = (sessionId: string, sequence: number) =>
  `/v1/sessions/${sessionId}/chunks/${sequence}/audio`;

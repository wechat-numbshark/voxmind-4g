import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { AuditEntry, Device, DeviceHeartbeat, Principal, User, UserRecord, UserRole } from "../identity/types.js";
import { hashPassword, passwordProblem, verifyPassword } from "../security/password.js";
import type { Repository } from "../store/repository.js";

/** 登录会话活 14 天。再长就等于没有过期，再短会让人每天重登。 */
const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;
/** 首个管理员的 id 必须是 "owner"：历史录音和动作的 user_id 全是这个字符串，
 *  换成别的，之前几个月的数据就认不回这个账号了。*/
export const BOOTSTRAP_USER_ID = "owner";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface BootstrapResult {
  created: boolean;
  email: string;
  /** 只有在这次自动生成了口令时才有值，且只出现在服务器日志里这一次 */
  generatedPassword?: string;
}

export class IdentityService {
  private readonly diagnosticSeen = new Map<string, { bootId: string; fault: string; at: number }>();
  constructor(private readonly repository: Repository, private readonly config: AppConfig) {}

  /* ── 开箱 ───────────────────────────────────────────────────── */

  /** 库里一个用户都没有时建第一个管理员。已经有用户就什么都不做。 */
  async bootstrap(): Promise<BootstrapResult | null> {
    if (await this.repository.countUsers() > 0) return null;
    const email = this.config.BOOTSTRAP_ADMIN_EMAIL;
    const generated = this.config.BOOTSTRAP_ADMIN_PASSWORD || randomBytes(12).toString("base64url");
    const now = new Date().toISOString();
    await this.repository.createUser({
      id: BOOTSTRAP_USER_ID, email, displayName: "Owner",
      passwordHash: await hashPassword(generated),
      role: "admin", status: "active", createdAt: now, updatedAt: now,
    });
    return { created: true, email,
      ...(this.config.BOOTSTRAP_ADMIN_PASSWORD ? {} : { generatedPassword: generated }) };
  }

  /* ── 登录 ───────────────────────────────────────────────────── */

  /** 成功返回 cookie 用的明文 token；库里只存它的 sha256。 */
  async login(email: string, password: string, userAgent: string, ip: string) {
    const user = await this.repository.getUserByEmail(email);
    /* 就算查无此人也照样跑一次校验：否则响应快慢会暴露哪些邮箱存在 */
    const ok = await verifyPassword(password, user?.passwordHash ?? "scrypt$AA$AA");
    if (!user || !ok) return { ok: false as const, error: "邮箱或密码不对" };
    if (user.status !== "active") return { ok: false as const, error: "账号已停用" };

    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    await this.repository.createAuthSession({
      id: sha256(token), userId: user.id,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      userAgent: userAgent.slice(0, 300), ip: ip.slice(0, 60),
    });
    await this.audit({ actorType: "user", actorId: user.id, action: "auth.login",
      targetType: "user", targetId: user.id, detail: {}, ip });
    return { ok: true as const, token, user: this.publicUser(user), maxAgeSec: SESSION_TTL_MS / 1000 };
  }

  async logout(token: string) {
    await this.repository.deleteAuthSession(sha256(token));
  }

  /** cookie → 身份。顺带刷新 lastSeenAt，管理端「最近活跃」靠它。 */
  async resolveSession(token: string): Promise<Principal | null> {
    const session = await this.repository.getAuthSession(sha256(token));
    if (!session) return null;
    const user = await this.repository.getUserById(session.userId);
    if (!user || user.status !== "active") return null;
    void this.repository.touchAuthSession(session.id, new Date().toISOString());
    return { kind: "user", userId: user.id, role: user.role, sessionId: session.id };
  }

  /* ── 设备 ───────────────────────────────────────────────────── */

  /** 设备密钥 → 身份。找不到就退回旧的全局 DEVICE_API_KEY，这样正在跑的
   *  实板固件不用立刻重新发密钥也能继续上传。 */
  async resolveDevice(key: string): Promise<Principal | null> {
    if (!key) return null;
    const device = await this.repository.getDeviceByKeyHash(sha256(key));
    if (device) {
      if (device.status !== "active") return null;
      return { kind: "device", userId: device.userId, role: "member", deviceId: device.id };
    }
    if (this.config.DEVICE_API_KEY && safeEqual(key, this.config.DEVICE_API_KEY)) {
      return { kind: "device", userId: BOOTSTRAP_USER_ID, role: "member", deviceId: "legacy-shared-key" };
    }
    return null;
  }

  /** 发一把新设备密钥。明文只在这里返回一次，之后库里只有哈希，找不回来。 */
  async issueDevice(userId: string, id: string, name: string) {
    const key = `vmd_${randomBytes(24).toString("base64url")}`;
    const device: Device = {
      id, userId, name, keyPrefix: key.slice(0, 12), status: "active",
      firmware: null, lastSeenAt: null, lastBatteryPct: null, lastNetwork: null, lastCharging: null,
      otaReleaseId: null, otaState: "idle", otaProgressPct: 0, otaError: null, otaUpdatedAt: null,
      createdAt: new Date().toISOString(), revokedAt: null,
    };
    await this.repository.createDevice(device, sha256(key));
    return { device, key };
  }

  async revokeDevice(id: string) {
    return this.repository.updateDevice(id, { status: "revoked", revokedAt: new Date().toISOString() });
  }

  async heartbeat(deviceId: string, beat: DeviceHeartbeat) {
    if (deviceId === "legacy-shared-key") return;   // 旧共享密钥没有设备记录可更新
    await this.repository.updateDevice(deviceId, {
      lastSeenAt: new Date().toISOString(),
      ...(beat.firmware !== undefined ? { firmware: beat.firmware } : {}),
      ...(beat.batteryPct !== undefined ? { lastBatteryPct: beat.batteryPct } : {}),
      ...(beat.network !== undefined ? { lastNetwork: beat.network } : {}),
      ...(beat.charging !== undefined ? { lastCharging: beat.charging } : {}),
    });
    if (beat.diagnostics) {
      const diag = beat.diagnostics, now = Date.now();
      // Evidence only: do NOT remotely reboot based on an old/missing heartbeat.
      const fault = diag.current.healthAgeMs.map((age, i) => age < 0 ? "unknown" :
        age > (i === 0 ? 30_000 : 120_000) ? "stale" : "ok").join(",");
      const seen = this.diagnosticSeen.get(deviceId);
      if (!seen || seen.bootId !== diag.bootId || seen.fault !== fault || now - seen.at >= 300_000) {
        await this.repository.appendAudit({ at: new Date(now).toISOString(), actorType: "device", actorId: deviceId,
          action: !seen || seen.bootId !== diag.bootId ? "device.boot_diagnostics" : "device.health_diagnostics",
          targetType: "device", targetId: deviceId, ip: "",
          detail: { diagnostics: diag, pendingUploads: beat.pendingUploads ?? null, firmware: beat.firmware ?? null } });
        if (this.diagnosticSeen.size >= 1000) this.diagnosticSeen.delete(this.diagnosticSeen.keys().next().value!);
        this.diagnosticSeen.set(deviceId, { bootId: diag.bootId, fault, at: now });
      }
    }
  }

  /* ── 用户管理 ───────────────────────────────────────────────── */

  async createUser(input: { id?: string; email: string; displayName: string; password: string; role: UserRole }) {
    const problem = passwordProblem(input.password);
    if (problem) return { ok: false as const, code: 400, error: problem };
    if (await this.repository.getUserByEmail(input.email)) {
      return { ok: false as const, code: 409, error: "这个邮箱已经有账号了" };
    }
    const now = new Date().toISOString();
    const user = await this.repository.createUser({
      id: input.id ?? randomUUID(), email: input.email, displayName: input.displayName,
      passwordHash: await hashPassword(input.password), role: input.role,
      status: "active", createdAt: now, updatedAt: now,
    });
    return { ok: true as const, user };
  }

  /** 改密码会把这个人所有已登录的会话踢掉——密码泄露后这是唯一有用的动作。 */
  async setPassword(userId: string, password: string) {
    const problem = passwordProblem(password);
    if (problem) return { ok: false as const, code: 400, error: problem };
    const updated = await this.repository.updateUser(userId, { passwordHash: await hashPassword(password) });
    if (!updated) return { ok: false as const, code: 404, error: "用户不存在" };
    await this.repository.deleteAuthSessionsForUser(userId);
    return { ok: true as const, user: updated };
  }

  async setStatus(userId: string, status: User["status"]) {
    const updated = await this.repository.updateUser(userId, { status });
    if (!updated) return { ok: false as const, code: 404, error: "用户不存在" };
    if (status === "disabled") await this.repository.deleteAuthSessionsForUser(userId);
    return { ok: true as const, user: updated };
  }

  async setRole(userId: string, role: UserRole) {
    const updated = await this.repository.updateUser(userId, { role });
    return updated ? { ok: true as const, user: updated } : { ok: false as const, code: 404, error: "用户不存在" };
  }

  /* ── 审计 ───────────────────────────────────────────────────── */

  async audit(entry: Omit<AuditEntry, "id" | "at"> & { at?: string }) {
    await this.repository.appendAudit({ ...entry, at: entry.at ?? new Date().toISOString() });
  }

  publicUser(user: UserRecord): User {
    const { passwordHash: _ignored, ...rest } = user;
    return rest;
  }
}

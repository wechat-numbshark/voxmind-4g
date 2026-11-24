/**
 * 账号、设备与审计的类型契约。
 *
 * 为什么要有这一层：在它出现之前，userId 是 URL 上的查询参数，默认 "owner"，
 * 谁拿到管理密钥就能读写任何人的录音；全部设备共用一把 DEVICE_API_KEY，
 * 丢一台等于全部报废。下面这些类型的存在就是为了让那两件事不可能再发生。
 */
import { z } from "zod";

/** admin 能管别人；member 只能管自己。没有第三种，多了没人说得清边界 */
export const UserRole = z.enum(["admin", "member"]);
export type UserRole = z.infer<typeof UserRole>;

export const UserStatus = z.enum(["active", "disabled"]);
export type UserStatus = z.infer<typeof UserStatus>;

export const User = z.object({
  /** 同时就是历史数据里的 user_id。首个管理员固定为 "owner"，否则老录音会认不回来 */
  id: z.string().min(1).max(128),
  email: z.string().email().max(200),
  displayName: z.string().min(1).max(80),
  role: UserRole,
  status: UserStatus,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type User = z.infer<typeof User>;

/** 带口令哈希的完整记录，只在服务端内部流转，绝不出现在任何响应里 */
export interface UserRecord extends User {
  passwordHash: string;
}

export const AuthSession = z.object({
  /** 存的是 token 的 sha256；明文只存在于用户浏览器的 cookie 里 */
  id: z.string().length(64),
  userId: z.string().min(1).max(128),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  userAgent: z.string().max(300),
  ip: z.string().max(60),
});
export type AuthSession = z.infer<typeof AuthSession>;

export const DeviceStatus = z.enum(["active", "revoked"]);
export type DeviceStatus = z.infer<typeof DeviceStatus>;

export const Device = z.object({
  id: z.string().min(1).max(128),
  userId: z.string().min(1).max(128),
  name: z.string().min(1).max(80),
  /** 密钥前 8 位，只为了让界面能认出「这是哪一把」，不足以还原密钥 */
  keyPrefix: z.string().max(16),
  status: DeviceStatus,
  firmware: z.string().max(60).nullable(),
  lastSeenAt: z.string().datetime().nullable(),
  lastBatteryPct: z.number().int().min(0).max(100).nullable(),
  lastNetwork: z.string().max(40).nullable(),
  /** 设备推断的充电状态（板上没接充电检测线，靠电压跳变 + 电量计推断） */
  lastCharging: z.boolean().nullable(),
  /** 远程升级进度。设备自己上报，管理端「设备中心」靠它看升级推到哪一步了 */
  otaReleaseId: z.string().nullable(),
  otaState: z.enum(["idle", "offered", "downloading", "verifying", "rebooting", "done", "failed"]),
  otaProgressPct: z.number().int().min(0).max(100),
  otaError: z.string().max(300).nullable(),
  otaUpdatedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
});
export type Device = z.infer<typeof Device>;

/** 设备上报的健康快照。设备端已经在 diag 里算好了这些数，只是以前没往上送 */
const DiagnosticSnapshot = z.object({
  plannedStop: z.number().int().min(0).max(11),
  uptimeMs: z.number().int().min(0).max(0xffffffff),
  healthAgeMs: z.tuple([z.number().int().min(-1).max(0xffffffff),
    z.number().int().min(-1).max(0xffffffff), z.number().int().min(-1).max(0xffffffff)]),
  event: z.number().int().min(0).max(6),
  detail: z.number().int().min(-0x80000000).max(0x7fffffff),
});
export const DeviceDiagnostics = z.object({
  version: z.literal(1), bootId: z.string().regex(/^[a-f0-9]{8}$/),
  resetReason: z.number().int().min(0).max(32), retention: z.literal("rtc_warm_reset_only"),
  previous: DiagnosticSnapshot.extend({ valid: z.boolean(), bootId: z.string().regex(/^[a-f0-9]{8}$/) }),
  current: DiagnosticSnapshot,
});
/** 设备上报的电池详情（固件 1.0.27 起）。offDrain 只在关机后第一次开机的那段时间里有：
 *  电量计关机期间一直通电，开机时一比就知道关机那段时间掉了多少电（docs/31、docs/32）。 */
const DeviceOffDrain = z.object({
  diedWhileOff: z.boolean().optional(),
  hours: z.number().min(0).max(24 * 120).optional(),
  socFrom: z.number().min(-5).max(150).optional(),
  socTo: z.number().min(-5).max(150).optional(),
  mvFrom: z.number().int().min(0).max(6000).optional(),
  mvTo: z.number().int().min(0).max(6000).optional(),
  estMa: z.number().min(-1).max(5000).optional(),
  modemCut: z.boolean().optional(),
  gaugeReset: z.boolean().optional(),
});
export const DevicePower = z.object({
  mv: z.number().int().min(0).max(6000),
  crate: z.number().min(-1000).max(1000),
  usb: z.boolean().nullable(),
  gaugeReset: z.boolean(),
  modemSwitch: z.boolean(),
  offDrain: DeviceOffDrain.optional(),
});
export const DeviceHeartbeat = z.object({
  firmware: z.string().max(60).optional(),
  batteryPct: z.number().int().min(0).max(100).optional(),
  network: z.string().max(40).optional(),
  pendingUploads: z.number().int().nonnegative().optional(),
  charging: z.boolean().optional(),
  diagnostics: DeviceDiagnostics.optional(),
  power: DevicePower.optional(),
});
export type DeviceHeartbeat = z.infer<typeof DeviceHeartbeat>;

/** 审计条目。谁在什么时候动了什么，出事时唯一能回溯的东西 */
export const AuditEntry = z.object({
  id: z.string(),
  at: z.string().datetime(),
  actorType: z.enum(["user", "device", "system"]),
  actorId: z.string().max(128),
  action: z.string().max(80),
  targetType: z.string().max(40),
  targetId: z.string().max(128),
  detail: z.record(z.string(), z.unknown()),
  ip: z.string().max(60),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/** 请求通过鉴权后挂在 request 上的身份。路由一律从这里取 userId，不再信 query */
export interface Principal {
  kind: "user" | "device" | "legacy-admin";
  userId: string;
  role: UserRole;
  deviceId?: string;
  sessionId?: string;
}

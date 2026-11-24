import { z } from "zod";

/* 远程升级的两张表。
 *
 * 设备在用户身上，出了 bug 不可能都寄回来，所以升级必须能远程推、能按设备推、
 * 能看见推到哪一步了。固件本身存对象存储，这里只记元数据。*/

export const FirmwareRollout = z.enum(["none", "all", "devices"]);
export type FirmwareRollout = z.infer<typeof FirmwareRollout>;

export const FirmwareRelease = z.object({
  id: z.string().uuid(),
  /** 从镜像 esp_app_desc_t 里读出来的，不是人填的 */
  version: z.string().min(1).max(60),
  project: z.string().max(60),
  idfVersion: z.string().max(60),
  builtAt: z.string().max(60),
  notes: z.string().max(2000),
  byteLength: z.number().int().positive(),
  sha256: z.string().length(64),
  objectKey: z.string().min(1),
  uploadedAt: z.string().datetime(),
  uploadedBy: z.string().max(128),
  /** none＝只是传上来了；all＝所有设备；devices＝只推给 rolloutDeviceIds */
  rollout: FirmwareRollout,
  rolloutDeviceIds: z.array(z.string().max(128)).max(500),
});
export type FirmwareRelease = z.infer<typeof FirmwareRelease>;

/** 设备升级到哪一步了。idle＝没有要升的；device 端每 10% 报一次 */
export const OtaState = z.enum(["idle", "offered", "downloading", "verifying", "rebooting", "done", "failed"]);
export type OtaState = z.infer<typeof OtaState>;

export const DeviceOtaReport = z.object({
  releaseId: z.string().uuid().optional(),
  state: OtaState,
  progressPct: z.number().int().min(0).max(100).default(0),
  error: z.string().max(300).optional(),
});
export type DeviceOtaReport = z.infer<typeof DeviceOtaReport>;

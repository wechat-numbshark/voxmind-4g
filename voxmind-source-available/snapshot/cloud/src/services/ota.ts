import { createHash, randomUUID } from "node:crypto";
import type { Device } from "../identity/types.js";
import { readFirmwareImage } from "../ota/image.js";
import { DeviceOtaReport, FirmwareRelease, type FirmwareRollout } from "../ota/types.js";
import type { ObjectStore } from "../storage/object-store.js";
import type { Repository } from "../store/repository.js";

/* 远程升级。
 *
 * 设备戴在用户身上，出了问题不可能都寄回来，所以升级要能远程推、能只推给一台先试、
 * 失败要能看见。固件走双 OTA 分区，刷坏了 bootloader 会回滚到上一版。
 *
 * 几条硬规矩：
 * - 版本号从镜像里读，不让人手填（界面写 v7、实际刷 v5 是灾难）；
 * - 工程名对不上就拒收，别把别的项目的固件刷进去；
 * - 同一版失败过就先晾 30 分钟再推，不然设备会拿 4G 流量反复下载同一个坏包。*/

const RETRY_AFTER_MS = 30 * 60_000;
/** 设备报"准备重启"后这么久还没用新版本心跳，就当新固件起不来 */
export const REBOOT_GRACE_MS = 10 * 60_000;

/** 比较 x.y.z 版本号；有一边不是这种格式（比如 git 短哈希）就当"不同但分不出新旧"，返回 1 */
export function compareVersions(a: string, b: string) {
  const parse = (v: string) => v.match(/^v?(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const x = parse(a), y = parse(b);
  if (!x || !y) return 1;
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! - y[i]!;
  return 0;
}

export interface OtaOffer {
  releaseId: string;
  version: string;
  byteLength: number;
  sha256: string;
  url: string;
}

export class OtaService {
  constructor(
    private readonly repository: Repository,
    private readonly objects: ObjectStore,
    private readonly publicBaseUrl: string,
    private readonly expectedProject = "voxmind",
  ) {}

  async upload(input: { binary: Buffer; notes: string; uploadedBy: string }) {
    const info = readFirmwareImage(input.binary);
    if (this.expectedProject && info.project !== this.expectedProject) {
      return { ok: false as const, code: 400, error: `这是「${info.project}」的固件，不是 ${this.expectedProject} 的，没敢收` };
    }
    const sha256 = createHash("sha256").update(input.binary).digest("hex");
    const existing = (await this.repository.listFirmware()).find((r) => r.sha256 === sha256);
    if (existing) return { ok: false as const, code: 409, error: `这个固件已经传过了（${existing.version}）` };

    const id = randomUUID();
    const objectKey = `firmware/${id}.bin`;
    await this.objects.put(objectKey, input.binary, "application/octet-stream");
    const release = FirmwareRelease.parse({
      id, version: info.version, project: info.project, idfVersion: info.idfVersion, builtAt: info.builtAt,
      notes: input.notes, byteLength: input.binary.length, sha256, objectKey,
      uploadedAt: new Date().toISOString(), uploadedBy: input.uploadedBy, rollout: "none", rolloutDeviceIds: [],
    });
    return { ok: true as const, release: await this.repository.createFirmware(release) };
  }

  async setRollout(id: string, rollout: FirmwareRollout, deviceIds: string[]) {
    return this.repository.updateFirmware(id, { rollout, rolloutDeviceIds: rollout === "devices" ? deviceIds : [] });
  }

  async remove(id: string) {
    const release = await this.repository.getFirmware(id);
    if (!release) return false;
    await this.objects.delete(release.objectKey);
    await this.repository.deleteFirmware(id);
    return true;
  }

  /** 这台设备现在该升哪一版？没有就返回 null（绝大多数心跳都走这条）。 */
  async offerFor(device: Device): Promise<OtaOffer | null> {
    const releases = await this.repository.listFirmware();
    const target = releases.find((r) => r.rollout === "all" || (r.rollout === "devices" && r.rolloutDeviceIds.includes(device.id)));
    if (!target) return null;
    if (device.firmware && device.firmware === target.version) return null;
    /* 不降级：设备跑的版本比这一版新（比如 USB 刷了更新的），就不推。
     * 实测踩过：旧版推送没停，设备刷到 0.9.0 后被自动"升级"回 0.8.1。
     * 真要回退旧版，传一个版本号更大的构建。*/
    if (device.firmware && compareVersions(target.version, device.firmware) < 0) return null;
    if (device.otaState === "failed" && device.otaReleaseId === target.id && device.otaUpdatedAt
        && Date.now() - Date.parse(device.otaUpdatedAt) < RETRY_AFTER_MS) return null;
    /* 推给全部时先只放一台当"先头"：它用新版本心跳成功之前，别的设备不下载。
     * 实测 0.9.3 升完联不上网——要是一次推给所有设备，就是所有人一起离线。*/
    if (target.rollout === "all") {
      const devices = await this.repository.listDevices();
      const onTarget = devices.filter((d) => d.otaReleaseId === target.id);
      const proven = onTarget.some((d) => d.otaState === "done");
      const pilot = onTarget.find((d) => ["offered", "downloading", "verifying", "rebooting"].includes(d.otaState));
      if (!proven && pilot && pilot.id !== device.id) return null;
      /* 先占住先头的位置：两台同时心跳时，只有第一台拿到 */
      if (!proven && !pilot) {
        await this.repository.updateDevice(device.id, { otaReleaseId: target.id, otaState: "offered", otaProgressPct: 0,
          otaError: null, otaUpdatedAt: new Date().toISOString() });
      }
    }
    return { releaseId: target.id, version: target.version, byteLength: target.byteLength, sha256: target.sha256,
      url: `${this.publicBaseUrl.replace(/\/$/, "")}/v1/device-firmware/${target.id}` };
  }

  /** 设备自己报进度。设备报 done 时不改 firmware 字段——重启后的心跳才算数。 */
  async report(deviceId: string, report: DeviceOtaReport) {
    await this.repository.updateDevice(deviceId, {
      otaReleaseId: report.releaseId ?? null,
      otaState: report.state,
      otaProgressPct: report.progressPct,
      otaError: report.error ?? null,
      otaUpdatedAt: new Date().toISOString(),
    });
  }

  /* 设备报 rebooting 只说明它准备重启；重启后心跳里的版本号对上了才算真升上去。
   * 对不上（比如 bootloader 回滚了）就标失败，管理端才看得出来。*/
  async confirmFromHeartbeat(deviceId: string, firmware: string | undefined) {
    const device = await this.repository.getDevice(deviceId);
    if (!device || !firmware || !device.otaReleaseId) return device;
    /* 下载到一半设备重启了/断网了：进度会一直停在"下载中"。心跳时发现半小时没动静就标成中断，
     * 不然管理端永远显示在下载，下一次推送也会被"失败晾 30 分钟"的规则误伤 */
    if (["offered", "downloading", "verifying"].includes(device.otaState) && device.otaUpdatedAt
        && Date.now() - Date.parse(device.otaUpdatedAt) > 30 * 60_000) {
      return this.repository.updateDevice(deviceId, { otaState: "idle", otaError: "上次升级中断（设备重启或断网），会重新推送",
        otaUpdatedAt: new Date(0).toISOString() });
    }
    const release = await this.repository.getFirmware(device.otaReleaseId);
    /* 升级失败之后，设备又换上了更新的版本（比如 USB 刷的）：那次失败已经不重要了，别一直挂着报警 */
    if (device.otaState === "failed" && release && compareVersions(firmware, release.version) > 0) {
      return this.repository.updateDevice(deviceId, { otaState: "idle", otaError: null, otaUpdatedAt: new Date().toISOString() });
    }
    /* 看门狗已经判了失败，结果它只是联网慢、其实升上去了：改回成功 */
    if (device.otaState === "failed" && release?.version === firmware) {
      return this.repository.updateDevice(deviceId, { otaState: "done", otaProgressPct: 100, otaError: null,
        otaUpdatedAt: new Date().toISOString() });
    }
    if (device.otaState !== "rebooting") return device;
    const upgraded = release?.version === firmware;
    return this.repository.updateDevice(deviceId, {
      otaState: upgraded ? "done" : "failed", otaProgressPct: upgraded ? 100 : device.otaProgressPct,
      otaError: upgraded ? null : `重启后仍是 ${firmware}，新固件没起来，已自动退回`,
      otaUpdatedAt: new Date().toISOString(),
    });
  }

  /** 看门狗：设备报了"准备重启"，10 分钟还没用新版本回来——停掉这一版的推送，免得更多设备装上。
   *  返回被停掉的版本，调用方记审计、提醒用户。*/
  async watchdog(now = Date.now()) {
    const stopped: { deviceId: string; version: string; releaseId: string }[] = [];
    for (const device of await this.repository.listDevices()) {
      if (device.otaState !== "rebooting" || !device.otaReleaseId || !device.otaUpdatedAt) continue;
      if (now - Date.parse(device.otaUpdatedAt) < REBOOT_GRACE_MS) continue;
      const release = await this.repository.getFirmware(device.otaReleaseId);
      if (release && release.rollout !== "none") {
        await this.repository.updateFirmware(release.id, { rollout: "none", rolloutDeviceIds: [] });
        stopped.push({ deviceId: device.id, version: release.version, releaseId: release.id });
      }
      await this.repository.updateDevice(device.id, { otaState: "failed",
        otaError: `升级到 ${release?.version ?? "新版"} 后 10 分钟没重新上线，已自动停止推送这一版`,
        otaUpdatedAt: new Date(now).toISOString() });
    }
    return stopped;
  }

  async binary(id: string) {
    const release = await this.repository.getFirmware(id);
    if (!release) return null;
    const object = await this.objects.get(release.objectKey);
    return object ? { release, body: object.body } : null;
  }
}

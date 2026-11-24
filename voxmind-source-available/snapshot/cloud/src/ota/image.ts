/* 读固件镜像自己的描述信息。
 *
 * 为什么不让管理员手填版本号：设备装在用户身上，刷错一版就得把人约回来。
 * ESP-IDF 在每个 app 镜像固定偏移处写了 esp_app_desc_t，版本、工程名、IDF 版本
 * 都在里面——直接读它，就不会出现「界面上写 v7、实际刷进去 v5」这种事。
 *
 * 镜像布局：esp_image_header_t(24B) + esp_image_segment_header_t(8B) + esp_app_desc_t。
 * 所以 app_desc 从 0x20 开始，magic 必须是 0xABCD5432。*/

const IMAGE_MAGIC = 0xe9;
const DESC_OFFSET = 0x20;
const DESC_MAGIC = 0xabcd5432;

export interface FirmwareImageInfo {
  version: string;
  project: string;
  idfVersion: string;
  builtAt: string;
  secureVersion: number;
}

function cstring(buffer: Buffer, offset: number, size: number) {
  const raw = buffer.subarray(offset, offset + size);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8").trim();
}

/** 解析失败一律抛错：宁可拒收，也不要把来路不明的东西推给设备。 */
export function readFirmwareImage(binary: Buffer): FirmwareImageInfo {
  if (binary.length < DESC_OFFSET + 0xb0) throw new Error("固件文件太小，不像是 ESP32 镜像");
  if (binary[0] !== IMAGE_MAGIC) throw new Error("不是 ESP32 应用镜像（开头不是 0xE9）");
  if (binary.readUInt32LE(DESC_OFFSET) !== DESC_MAGIC) throw new Error("镜像里没有版本描述块，可能不是 app 分区的固件");

  const version = cstring(binary, DESC_OFFSET + 0x10, 32);
  const project = cstring(binary, DESC_OFFSET + 0x30, 32);
  const time = cstring(binary, DESC_OFFSET + 0x50, 16);
  const date = cstring(binary, DESC_OFFSET + 0x60, 16);
  const idfVersion = cstring(binary, DESC_OFFSET + 0x70, 32);
  if (!version) throw new Error("镜像里没写版本号");
  return { version, project, idfVersion, builtAt: `${date} ${time}`.trim(), secureVersion: binary.readUInt32LE(DESC_OFFSET + 4) };
}

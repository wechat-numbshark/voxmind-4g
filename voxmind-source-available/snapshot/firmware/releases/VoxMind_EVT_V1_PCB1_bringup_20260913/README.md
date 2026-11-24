# VoxMind EVT V1 PCB1 首板自检固件

构建环境：官方 `espressif/idf:v5.5.1`，目标 `esp32s3`。

此版本用于新板首次上电，不会执行真实云端任务。串口将依次检查 PSRAM、电量计、电池电压、SD NAND、双 PDM 麦克风、ML307C-GC、振动马达与屏幕背光。

## 烧录

连接 ESP32-S3 原生 USB 口后，在本目录执行：

```bash
python -m esptool --chip esp32s3 -b 460800 \
  --before default_reset --after hard_reset write_flash \
  --flash_mode dio --flash_size 16MB --flash_freq 80m \
  0x0 bootloader.bin \
  0x8000 partition-table.bin \
  0xf000 ota_data_initial.bin \
  0x20000 voxmind.bin
```

如果系统中尚无 esptool：

```bash
python3 -m pip install esptool
```

烧录后以 115200 波特率查看串口日志。详细判断方法以仓库 `交付/VoxMind_v9_到货采购装配与开发完全指南_20260830.md` 为准。

## SHA-256

```text
c0eb6018458b7a1abfdb798aa8fa61d1ca3bcb93de0655fd664109170d3df699  bootloader.bin
7d2c7ac4888bfd75cd5f56e8d61f69595121183afc81556c876732fd3782c62f  ota_data_initial.bin
21dbddb4f5f332bf192435ba913e893d42bcfec72bf52c0c9878294740e7dae7  partition-table.bin
bd354a8ef75976a695cf860e33777cfb8ce7e7ef83a050721cfa3cea34ff7d8f  voxmind.bin
```

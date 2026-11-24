# VoxMind EVT V1 PCB1 云端联调固件

构建环境：官方 `espressif/idf:v5.5.1`，目标 `esp32s3`。这是首轮联调用版本：

- 开机即持续采集双 PDM 麦克风并下混为 16 kHz/16-bit 单声道 PCM；
- 每 5 秒先写 `*.part`，`fsync` 后原子改名为 `*.pcm`；
- 每次启动由设备离线生成 UUID，会话不依赖先联网；
- Wi-Fi 可用时经 HTTPS 上传到 `https://EXAMPLE-DEMO-HOST.invalid`；
- 只有收到云端 `durable: true` 的 200/201 响应后才删除本地块；断线后会自动扫描补传。
- 在线时轮询统一动作队列；串口打印队首标题，屏幕顶部短条表示待确认数量；触摸底部左半区取消、右半区确认。

这是验证录音、存储、TLS、幂等上传、云端回放和触摸确认的实验固件。卡片暂未内置中文字库，所以正文从串口/Web 查看；实屏方向确认后再固化中文字形与排版。PCM 占用约 115 MB/小时；正式长续航版会换为 Opus，并接入 ML307C-GC 的 PPP 数据链路。

## 1. 烧录

```bash
python -m esptool --chip esp32s3 -b 460800 \
  --before default_reset --after hard_reset write_flash \
  --flash_mode dio --flash_size 16MB --flash_freq 80m \
  0x0 bootloader.bin \
  0x8000 partition-table.bin \
  0xf000 ota_data_initial.bin \
  0x20000 voxmind.bin
```

## 2. 配置 Wi-Fi 与设备密钥

1. 打开 VoxMind Web 控制台的“连接设置”；
2. 填 Wi-Fi 名称和密码，点击“复制实板配置行”；
3. 用 115200 波特率打开设备 USB 串口，把这一整行粘贴进去；
4. 设备写入 NVS 后自动重启，日志应出现“Wi-Fi 已连接”“本地安全落盘”“云端已持久化”。

配置行字段以 Tab 分隔，固件不会把 Wi-Fi 密码或设备密钥打印回串口。第一次未配置时仍持续录音到板载 SD NAND。

## SHA-256

```text
074f637850dd385ab0ad74ab7da8f5bc2464fcf7fd989a66a1fe1cfc3d2a977a  bootloader.bin
7d2c7ac4888bfd75cd5f56e8d61f69595121183afc81556c876732fd3782c62f  ota_data_initial.bin
21dbddb4f5f332bf192435ba913e893d42bcfec72bf52c0c9878294740e7dae7  partition-table.bin
2b8edee569ad3d87a21d8a9bcb2b6b4f5e639b3f1550331f9125d0535f267130  voxmind.bin
```

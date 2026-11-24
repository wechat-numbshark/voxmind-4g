# VoxMind v9 英国 SIM 测试固件 1.0.27-uk.1

2026-11-03。本地已编译、未刷写、未发布 OTA、未做英国实网验收。

加入 EE、O2、Vodafone、Three，以及 giffgaff、SMARTY、Lebara 的接入配置；支持月付/预付费/数据套餐选择、自定义 APN、PAP/CHAP、NVS 保存及 LTE 本网/漫游注册判断。国内三大运营商映射保留。

- `voxmind.bin`：ESP32-S3 应用镜像，4,055,872 字节；适用于本项目现有 v9 分区和依赖环境的候选应用更新，不是整片 Flash 镜像。
- `manifest.json` / `SHA256SUMS`：构建状态、源码指纹与固件 SHA-256。
- `host-tests.txt`：主机侧 ASan/UBSan 结果；配置保存测试使用 NVS 替身，不等于硬件断电测试。
- `image-info.txt`：ESP 镜像结构和校验结果。
- `英国SIM适配说明.md`：运营商配置表、串口命令、来源、已验证与待验证事项。

固件完整编译通过，应用分区约剩 23%。没有内置设备密钥，没有启用删除旧录音的选项。现有设备不会因为本目录出现新文件而自动升级。

安装后可通过 USB 串口输入 `cellular list`，选择如 `cellular profile ee` 或 `cellular profile giffgaff`。保存不会中断当前录音，下次正常关机再开机后使用新配置；`cellular auto` 恢复归属网络自动识别。

英国主流 APN 软件适配不能增加模组硬件频段。现有 ML307C-GC 的完整地区版本、频段及英国卡实际注网/上传仍须验证。

# VoxMind 1.0.24

发布日期：2026-10-10。ESP32-S3 / PCB1 云端版。

- 固件源码提交：`2443ddf7b248a09eebe73e76d111c76400736763`
- 云端配套提交：`c8ec202f9f64d511899d4e21e98bd61ac5d7910f`
- 智能家居既有改动基线：`49c34f87`
- 详细变更与未覆盖边界：[深度检查报告](../../../docs/29_VoxMind_1.0.24深度检查与优化_20261010.md)
- 发布 ID、SHA-256、大小、推送范围和实际验收状态见同目录 `manifest.json`。

二进制保存在本机 `firmware/releases/build/1.0.24/voxmind.bin`（构建产物不进 Git）与生产 OTA 固件库。重建前参考 `firmware/tools/build-release.sh`，保留现有正式 `sdkconfig`，密钥来自设备 NVS。重新构建会包含新编译时间，文件 SHA-256 不要求与发布包相同。

本地 LVGL 验证图片在 `firmware/releases/build/1.0.24/`，是原 UI 代码的桌面渲染，不是真机截图。

## 部署与恢复

本次仅推送 `demo-voxmind-not-a-real-device`。上传固件不等于升级完成；以设备上报版本 1.0.24 且 OTA done 为准。

云端已备份到服务器 `/opt/voxmind/backups/release-1.0.24/`：

- `cloud-source-before.tar.gz`：升级前源码。
- `database-before.dump`：升级前 PostgreSQL 备份，含敏感用户数据，仅管理员在服务器本地使用。
- Docker 旧镜像标签 `voxmind-api:pre-1.0.24`。

如需停止固件扩散，将该发布 rollout 改为 none；不会倒退已升级设备。OTA 启用引导回滚，新固件自检失败时回旧分区。手动降级需要单独验证，不应修改版本号伪装成新版本。

云端回退可以恢复旧源码并重新构建，或将旧镜像重新标记为 `voxmind-api:local` 后只重启 api。一般无需恢复数据库；还原数据库会覆盖之后的数据，不能作为默认回退动作。

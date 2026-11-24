# VoxMind firmware 1.0.27-power.1 — 电源修复，单机 OTA

源码提交 `4ecf2da2`（分支 `fix/power-off-drain`），改动见 `docs/32`。

部署记录：云端先部署 `4ecf2da2`。固件做过单机试推，服务器上的 release 记录号不在本源码集里。本树里的设备名是 `demo-voxmind-not-a-real-device`。
2026-11-07 11:52（北京时间）设备用新版本心跳成功，otaState=done，随后把推送改回 `none`。

升级前那次开机（1.0.26，11:41）复位原因为 1（上电），说明 11-03 关机后电池又被放空了一次。新版本第一次上报
`gaugeReset: true`、`offDrain.diedWhileOff: true`，和这一点吻合；当时插着充电器（4144 mV，CRATE +44%/h）。
`modemSwitch: false`：还没做改线 A。

这次没有抓到 USB 串口开机日志，新版本是靠心跳和开机诊断确认的。

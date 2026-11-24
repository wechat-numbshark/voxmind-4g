# VoxMind v9：英国主流 SIM 软件适配

日期：2026-11-03。候选固件：`1.0.27-uk.1`。

## 当前结论

已在 v9 固件中加入英国主流运营商 APN 配置、PAP/CHAP 认证、NVS 配置保存和 LTE 本网/漫游注册识别。国内移动、联通、电信的自动识别保留。

这项交付是软件适配和可编译的测试固件。没有英国实卡注网/连续上传测试，没有刷写或 OTA 到现有设备，不能据此宣称现有 ML307C-GC 已完整支持英国所有网络。

v9 制造记录中的模组为 `ML307C-GC / C48982540`。本地附件是系列宣传册，未包含该 GC 具体料号的完整频段表；公开商城参数也不足以解决完整地区后缀和频段问题。仍需以实物铭牌、准确版本的原厂规格书及实网结果确认。缺少的射频频段不能通过 APN 或 ESP32 固件补齐。

## 已加入的配置

| 串口配置名 | 卡/套餐 | APN | PPP 认证 |
|---|---|---|---|
| `ee` | EE 常规移动数据 | `everywhere` | PAP |
| `o2` | O2 月付常规配置 | `mobile.o2.co.uk` | PAP |
| `o2-payg` | O2 预付费；采用 AOSP 当前配置参数 | `payandgo.o2.co.uk` | PAP/CHAP |
| `o2-data` | O2 专用移动宽带套餐候选 | `m-bb.o2.co.uk` | PAP |
| `vodafone` | Vodafone 月付常规配置 | `wap.vodafone.co.uk` | 无强制认证 |
| `vodafone-payg` | Vodafone 预付费常规配置 | `pp.vodafone.co.uk` | 无强制认证 |
| `vodafone-data` | Vodafone 数据套餐候选 | `internet` | PAP/CHAP |
| `three` | Three 手机卡常规配置 | `three.co.uk` | 无 |
| `three-data` | Three 数据/宽带卡 | `3internet` | 无 |
| `giffgaff` | giffgaff | `giffgaff.com` | PAP |
| `smarty` | SMARTY | `mob.asm.net` | 无 |
| `lebara` | Lebara UK | `uk.lebara.mobi` | PAP/CHAP |

内置认证参数是公开的运营商接入参数，不是用户账号密码。企业专网卡、旅行卡、不同批次/套餐的 APN 可能不同，按发卡方说明覆盖。

O2 参数在公开资料中有多个组合：月付配置使用 O2 历史官方宽带手册的 `o2web/password`；预付费配置使用 AOSP 当前 `o2/p`。GNOME 数据集还保留旧预付费组合。没有把这些组合当成所有 O2 卡均已验证的保证，实际套餐不匹配时使用自定义配置。

## 自动识别的边界

读取 SIM 的归属 IMSI，不按所在地的漫游网络选择 APN。只取 MCC/MNC，不打印或保存完整 IMSI。

中国 460xx 沿用原映射；英国 EE（23430/33/34/86）、O2（23402/10/11）、Vodafone（23415）、Three（23420）使用常规网络默认配置。英国 MCC/MNC 映射核对了 GNOME 原始数据集。

同一个归属网络号可能被多个品牌或套餐共用：giffgaff 与 O2、SMARTY 与 Three 就不能只靠 MCC/MNC 区分。自动模式仅给网络默认值并提示，实际品牌/预付费套餐优先显式选择配置。

已成功读到、但不认识的境外 SIM 不再静默使用 `cmnet`；保留本地录音并提示配置。无法读取 IMSI 时仍保留原来的编译 APN 兜底，不能声称已识别卡归属。

## 如何配置

需要先安装本次候选固件。USB 串口使用设备已有的维护通道，命令以换行结束。配置写入一个带版本的 NVS blob，不主动重启，不中断当前录音；完成当前录音并正常关机，再手动开机生效。

```text
cellular list
cellular show
cellular profile ee
```

若用 giffgaff，改为 `cellular profile giffgaff`；其他配置名见上表。恢复国内卡/归属网络自动选择：

```text
cellular auto
```

自定义无认证 APN：

```text
cellular set {"apn":"your.apn","auth":"none"}
```

自定义 PAP/CHAP；填写发卡方提供的实际值：

```text
cellular set {"apn":"your.apn","auth":"papchap","username":"your-user","password":"your-password"}
```

支持 `none`、`pap`、`chap`、`papchap`。APN 最多 100 字符，用户名/密码各最多 63 字符。拒绝过长、控制字符、引号/反斜杠等异常参数；串口日志不回显认证字段。没有设备密钥时也能先配置 SIM，原 `setup<TAB>设备密钥` 流程保留。

## 验证及待验收项

- 主机侧 ASan/UBSan 测试：国内运营商回归、英国网络默认值、手动覆盖共享网络号、未知境外卡、IMSI 格式、参数长度和异常字符、LTE 本网/漫游/拒绝状态。
- 设置适配层测试：真实 JSON 解析器和配置代码配合 NVS 测试替身，验证保存/读取、提交失败、损坏记录、无效输入不覆盖旧配置、日志不回显认证信息。这不是实物 NVS 掉电验收。
- ESP-IDF 完整编译，并启用 `CONFIG_LWIP_PPP_PAP_SUPPORT` 与 `CONFIG_LWIP_PPP_CHAP_SUPPORT`；使用 `AT+CEREG?` 确认 LTE 注册，指令不支持时退回 `AT+CGREG?`，接受本地注册和漫游注册。
- 保留国内 NTP 源，将第三个源替换为全球 `pool.ntp.org`，避免旅行时只依赖国内区域池。TLS 校验没有关闭。
- 尚待：实物模组完整地区后缀/频段、英国卡激活与 SIM PIN 状态、套餐设备使用限制、英国本地信号、DNS/TLS/服务器上传、长时间断网补传和录音稳定性。实体卡需为 Nano-SIM；本次没有实现 eSIM 下载。

本次构建和主机测试结果、固件 SHA-256 见 `firmware/releases/1.0.27-uk.1/`。

## 核对来源

以下为本轮核对的第一方设置说明或原始配置数据；公开资料存在套餐差异，不等于本机实网验收。

- [EE 官方设备设置](https://deviceguides.ee.co.uk/samsung/galaxy-z-fold7-android-16/connectivity/setting-up-your-phone-for-internet/)
- [Vodafone 官方月付/预付费设置](https://www3.vodafone.co.uk/business/help/mobile-services/set-up-phone-internet-access-picture-messaging-mms)
- [Three 官方支持人员关于手机卡与数据卡 APN 的说明](https://community.three.co.uk/t5/Account-and-services/Login-to-my-3-account-error-message/m-p/27143)
- [giffgaff 官方互联网 APN](https://help.giffgaff.com/en/articles/245215-internet-apn-settings-guide)
- [SMARTY 官方互联网设置](https://help.smarty.co.uk/en/articles/1155220-using-the-internet-after-you-ve-joined-smarty)
- [Lebara 官方设置](https://www.lebara.co.uk/en/help.html)
- [O2 原版移动宽带用户手册镜像](https://iteachyou.co.uk/wp-content/uploads/2023/06/Pay-Monthly-E169-v3.4.0.pdf)：原版厂商文档，较旧，仅用于说明通用月付配置的来源。
- [GNOME mobile-broadband-provider-info 原始数据](https://gitlab.gnome.org/GNOME/mobile-broadband-provider-info/-/blob/main/serviceproviders.xml)：英国归属网络号和数据套餐候选。
- [AOSP 原始 APN 配置](https://android.googlesource.com/device/sample/+/refs/heads/main/etc/apns-full-conf.xml)：O2 预付费参数；包含 GID 等更细的套餐区分，固件目前没有复制手机系统的全部识别机制。
- ESP-IDF 本地 `esp_netif_ppp.h` 与 `esp_netif_lwip_ppp.c`：PAP/CHAP 参数接口及凭据生命周期。

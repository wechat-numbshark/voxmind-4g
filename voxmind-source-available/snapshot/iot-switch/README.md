# VoxMind IoT switch starter

这是一套给 Home Assistant / EVA / VoxMind 链路使用的 ESPHome 起步模板。

2026-10-04 更新：用户要求无线且不限定 Wi-Fi。完整方案第 13 节新增 CH592 私有 2.4GHz 网关 + 四路节点候选、433MHz 低风险备选与预算。此目录现有 YAML 仍是 Wi-Fi / ESPHome 备选，不是 CH592、433MHz 或 ESP-NOW 固件；本轮未实现这些固件和网关桥接。

- `esphome/vox-switch-1.yaml`：单路低压样机，本地按钮，上电默认关。
- `esphome/vox-switch-4.yaml`：四路 24V 控制箱逻辑模板，本地按钮，上电默认关。
- `esphome/secrets.example.yaml`：密钥字段示例；复制成 `secrets.yaml` 后在本机填写，绝不提交真实内容。

完整架构、BOM、安全边界和 EVA 绑定流程见 `docs/27_VoxMind低成本物联网开关与农场扩展_20261004.md`。

这些模板只用于安全低压输出或驱动合规接触器的低压线圈。不要把开发板、面包板或普通 3D 打印盒直接接入 220V 市电。

模板中的本地按钮不等于实体反馈；尚无完整运行限时、流量/触点闭环和负载安全状态机。配置校验通过也不等于编译、上板或真实控制已通过。

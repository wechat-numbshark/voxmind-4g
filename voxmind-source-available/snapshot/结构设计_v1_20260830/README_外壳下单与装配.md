# VoxMind EVT_V1 v9 外壳：下单与装配说明

版本：结构 v1.2（2026-08-30，实板 STEP 与嘉立创可制造性反馈闭环版）
定位：**可销售标准的工程样机 / 小批量结构基线**。它不是“尚未试装就可直接量产”的承诺；第一套必须与收到的真实 PCB、屏幕、电池和天线做试装，再冻结 DVT 版本。

## 1. 已冻结的总体方案

- 成品外廓：`110 × 65 × 27.4 mm`，四角 R7；PCB 为 `100 × 55 × 1.6 mm`。
- 正面：右侧横屏，左侧 `OK / BACK / REC` 三实体键；触控为辅助，不替代录音盲操作键。屏幕中心经实板干涉优化为 `(68.0, 34.2) mm`。
- 屏幕：微雪 2inch Capacitive Touch LCD，硬质主体实测官方 STEP 包络约 `48.22 × 35.02 × 5.1 mm`；玻璃低于外壳保护沿约 1.2 mm。
- PCB：周边承托 + 四处 PA12 弹性卡扣，不要求当前 v9 PCB 增加安装孔。
- 上下壳：定位舌配合，背面 4 颗 M2 螺钉承受跌落载荷；不是仅靠纯卡扣闭合。
- 电池：`503450` 带保护板软包电池专用托盘，设计包络 `51.5 × 35.5 × 5.6 mm`，与 PCB/底壳均无 CAD 干涉。
- 保护：刚性 PA12 壳 + 可拆 TPU 95A 周向防摔套；不采用不可维修、模具昂贵的整体硅胶包胶。
- 接口：左侧 USB-C，右侧 Nano-SIM；调试口、电池座和屏幕线保留在壳内。
- 声学：两路 1.6 mm 麦克风孔，内侧 6 mm 防尘声学网贴合台阶。
- 指示灯：独立透明树脂导光柱。
- 天线：上壳右内侧预留约 `10 × 40 mm` 的塑料贴附区，LTE FPC 天线与 PCB/电池保持 Z 向距离；同轴线走内部通道。

屏幕官方资料：

- Wiki：<https://www.waveshare.com/wiki/2inch_Capacitive_Touch_LCD>
- 整机 STEP：<https://files.waveshare.com/wiki/2inch-Capacitive-Touch-LCD/2inch_Capacitive_Touch_LCD_STEP.zip>
- PCBA STEP：<https://files.waveshare.com/wiki/2inch-Capacitive-Touch-LCD/2inch_Capacitive_Touch_LCD_PCBA_STEP.zip>

官方模型的 `58.8 × 37.1 mm` 总包络包含屏幕软排线的弯折范围，不是全部都要夹持的硬板。当前结构只夹持约 `48.2 × 35.0 mm` 的硬质主体，后方留排线弯折腔。

## 2. 嘉立创 3D 下单文件

嘉立创要求一个文件不要塞入多个独立模型，本目录已经按零件拆分。**不要上传装配 STEP 或 mockup 去生产。**

| 数量/台 | 上传文件 | 推荐材料/工艺 | 处理 |
|---:|---|---|---|
| 1 | `STL/VoxMind_top_PA12.stl` | PA12S / PA12，MJF 或 SLS | 染黑，喷砂/光滑处理 |
| 1 | `STL/VoxMind_bottom_PA12.stl` | PA12S / PA12，MJF 或 SLS | 染黑，喷砂/光滑处理 |
| 1 | `STL/VoxMind_button_OK_PA12.stl` | PA12 | 黑/黄均可 |
| 1 | `STL/VoxMind_button_BACK_PA12.stl` | PA12 | 黑/黄均可 |
| 1 | `STL/VoxMind_button_REC_PA12.stl` | PA12 | 红色喷漆或手工点色 |
| 1 | `STEP/VoxMind_lightpipe_clear_resin.step` | 8001 透明树脂 SLA | 透明、喷油，PCB 端面轻磨平 |
| 1（可选） | `STL/VoxMind_bumper_TPU95A.stl` | TPU 95A，FDM | 黑色；首件确认松紧 |

以下只用于核对，不要下单：

- `VoxMind_PCB_mechanical_mockup.*`
- `VoxMind_battery_503450_mockup.*`
- `Waveshare_2inch_display_rigid_mockup.*`
- `VoxMind_enclosure_complete_assembly.step`
- `VoxMind_enclosure_exploded.step`
- `参考模型/VoxMind_EVT_V1_v9_real_assembled.step`

`VoxMind_display_gasket_TPU.*` 是几何模板。首批实际装配建议用 0.5 mm 3M 9495LE/VHB 框形胶和黑色 PET 遮光片，不建议把 0.6~1.2 mm 的打印软胶垫直接替代精密模切胶。

透光柱的 STL 经本地制造门禁确认 watertight、winding consistent 且为单一连通体，但嘉立创在线预审仍误报“反向三角面”。2026-08-30 的实际订单改用同一单实体 CAD 导出的 STEP，由嘉立创重新网格化后预审不再出现该拓扑异常。因此透光柱的**下单真源是 STEP**，STL 仅保留作本地核对与预览。

## 3. 为什么选 PA12

壳体有 PCB 卡扣、螺钉柱和跌落受力，标准光敏树脂虽然外观细，但长期卡扣与螺钉耐久性不足。嘉立创当前设计规范建议普通壁厚约 2 mm、卡扣/紧固件薄处超过 1.5 mm，尼龙 100 mm 内典型精度约 ±0.3 mm。当前设计采用：

- 主壁厚 `2.2 mm`；
- 卡扣受力壁厚 `1.5 mm`、宽 `10 mm`；
- 上下壳定位间隙单边 `0.35 mm`；
- 屏幕硬体腔单边 `0.4 mm`；
- 按键孔径与按键头径差 `0.4~0.6 mm`；
- 最小贯通功能孔 `1.6 mm`。

参考：

- 嘉立创 3D 打印设计规范：<https://www.jlc-3dp.cn/technicalColumnsDetails/27832>
- 嘉立创 3D 打印须知：<https://www.jlc.com/portal/q7i40026.html>
- 嘉立创 PA12 SLS 设计说明：<https://www.jlc-3dp.cn/technicalColumnsDetails/59512.html>

## 4. 还需另购的结构物料

| 物料 | 推荐规格 | 数量 |
|---|---|---:|
| 壳体螺钉 | M2 × 16，盘头/圆头，自攻或塑料专用牙 | 4 |
| 屏幕框胶 | 3M 9495LE/VHB，0.5 mm，按 gasket 轮廓模切 | 1 |
| 黑色遮光片 | 黑 PET 0.1~0.2 mm，按屏幕窗口模切 | 1 |
| 麦克风防尘网 | 6 mm 自粘声学网，低声阻 | 2 |
| 电池缓冲 | Poron 0.5 mm（托盘底）+ 1.0 mm（电池上） | 各 1 |
| 脚垫 | 直径 6 mm、厚 0.8~1.0 mm 自粘硅胶脚垫 | 4 |
| LTE 天线 | 全频段内置 FPC，U.FL，建议本体约 10 × 40 mm | 1 |
| 电池 | 503450、3.7 V、带保护板、持续放电 ≥2 A、正确线序 | 1 |

在中国销售的便携式电子产品用锂电池/电池组应采购有有效 CCC 标识与可追溯证书的成品，不能用无认证裸电芯冒充成品电池。相关现行依据为 GB 31241-2022；国家认监委公告链接：<https://www.cnca.gov.cn/zwxx/gg/2023/art/2023/art_9b1f71e55d06483d9cbdd35e791a4e60.html>。

## 5. 装配顺序

1. 清理打印粉末，M2 孔只用手动丝锥/螺钉试牙，禁止电批高速攻入。
2. 透明导光柱由壳内插入；PCB 端磨平，保留约 0.2~0.5 mm 与 LED 的间隙。
3. 在两个麦克风孔内侧贴声学网，不能用普通泡棉堵孔。
4. 将三颗按键帽从上壳内侧向外穿入。REC 有中心触觉凹点，BACK 有偏心触觉缺口。
5. 用框形 VHB 把屏幕粘在上壳内侧。只压屏幕黑边，禁止压显示区和软排线。
6. 将 15P 屏幕线先插好并锁扣，再把线自然做 U 形回弯接到 PCB J5；弯曲半径不小于 3 mm。
7. PCB 斜放入底壳周边承托，逐一压过四个卡扣。只压 PCB 边缘，禁止压 C32、模组或 SIM 座。
8. 在电池托盘底贴 0.5 mm Poron，放入电池，再贴 1.0 mm 上缓冲。电池不得被 C32、焊点、螺钉柱或壳体硬压。
9. 核对电池插头极性后再接 J1。两根线沿右上方三个导线环走线，不跨过 SIM 和螺钉柱。
10. LTE FPC 天线贴在上壳右内侧平面，不能折死；同轴线从 J7 沿内部通道走，不夹在上下壳缝。
11. 合盖前确认 USB-C、SIM、按键、屏幕线、电池线均没有进入定位舌区域。
12. 四颗 M2×16 对角分两轮手拧到底，目标扭矩从 `0.10 N·m` 起试，PA12 首件以不滑牙、不白化为准。
13. 试装无误后套 TPU 防摔圈，最后贴 4 个脚垫和背面铭牌。

## 6. 当前验证结果

- 11 个 STL 均通过 `watertight=true`、`winding=true` 网格检查。
- 11 个 STL 均为单一连通体（`connected_components=1`）；已消除嘉立创预审提示的多壳体和反向三角面根因。
- 上壳/底壳：非预期交叠 `0 mm³`。
- 已从桌面嘉立创 EDA v9 活板导出 `445` 个实体的完整装配 STEP；板体实测 CAD 包络为 `99.975 × 54.976 × 16.503 mm`，其中顶层最高 `6.503 mm`、底层最低 `-10.000 mm`。
- 真实 v9 PCB/上下壳：非预期交叠 `0 mm³`；上壳最小净空 `1.021 mm`，底壳仅在设计承托面接触。
- 嘉立创可制造性复核：按键保持翻边已加厚到 `1.30 mm`，翻边直径 `12.0 mm`（最小径向边宽 `1.90 mm`）；TPU 95A 防摔圈径向壁厚已加厚到 `2.20 mm`。这些数值均超过当前页面提示的 PA12 `1.0 mm` / 工程塑料 `1.6 mm` 门槛，并保留了额外打印余量。
- 电池/真实 v9 PCB：非预期交叠 `0 mm³`；最小计算间隔 `1.499 mm`。
- 屏幕/上壳、真实 v9 PCB：非预期交叠 `0 mm³`；最小计算间隔分别 `0.200 mm`、`2.095 mm`。
- EDA 未解析的 J6 已按数据手册 `5.5 ± 0.15 mm` 高度和放大后的 `8.2 × 9.2 mm` 平面包络补做最坏代理；与屏幕、上壳净空分别 `2.390 mm`、`3.607 mm`。
- D1/D2 与 MIC1/MIC2 为其余 EDA 缺模器件，都低于 J6 且位于开放净空区，不构成高度门禁。
- 主壁厚、孔径、拆件方式符合嘉立创当前通用 3D 打印门槛，且按 PA12 精度留有配合公差。

验证数据见 `mesh_validation.json`；参数化源文件为 `voxmind_enclosure.py`。

可复现命令（macOS / Python 3.9）：

```bash
python3 -m venv .venv-cad
.venv-cad/bin/pip install -r 结构设计_v1_20260830/requirements-cad.txt
.venv-cad/bin/python 结构设计_v1_20260830/voxmind_enclosure.py
.venv-cad/bin/python 结构设计_v1_20260830/verify_enclosure.py
.venv-cad/bin/python 结构设计_v1_20260830/render_preview.py
```

## 7. 不能跳过的首件冻结

收到 PCB 后只下单 **1 套外壳**。下列实测写回参数化源文件后，才可下 5 套或对外销售：

- PCB 实际成品宽、高、圆角与板厚；
- C32 实际总高度；
- SW1/SW2/SW3 的壳体顶面与按柄高度；
- USB-C 舌口中心相对 PCB 的 Z 高度；
- SIM 卡插拔方向与手指/镊子空间；
- 屏幕玻璃、PCBA 和接线后的真实厚度/弯折半径；
- 503450 实际电池包（含保护板、胶带、导线出口）的最大尺寸；
- LTE 天线实际型号、同轴长度与整机驻波/信号测试。

这一步不是设计没完成，而是消费电子结构从 EVT 到 DVT 的正常门：当前已用 EDA 完整装配 STEP 和 J6 数据手册包络完成虚拟闭环，但打印与贴片的实际公差、线材弯曲和胶带压缩仍必须用 1 套真实首件闭环。

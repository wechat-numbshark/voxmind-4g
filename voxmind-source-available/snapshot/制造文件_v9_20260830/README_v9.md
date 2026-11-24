# VoxMind EVT_V1 v9 制造包

生成时间：2026-08-30（Asia/Shanghai）

本包取代 `制造文件_v8_20260829/`。v9 已加入 ML307C 1.8V ↔ ESP32 3.3V 电平转换：U10/U11 为 `SN74AXC2T45DCUR`（LCSC `C1858360`），C40-C43 为 100nF（LCSC `C1525`）。U3 脚100保持 NC。

验证结果：

- 嘉立创 EDA 原生 PCB DRC：0 条。
- MODEM_RF 原理图 bridge-check：0 bridge、0 orphan。
- 110 个器件；0 overlap、0 off-board、0 tight。
- BOM 有46个有效料项、合计108个贴装件；已确认包含 U10/U11 与 C40-C43，且带正确 LCSC 编号。
- 坐标文件有110个板上器件（含2个DNP）；已确认包含 U10/U11 与 C40-C43，均为底面器件。
- Gerber 含 4 个铜层、双面阻焊/钢网/丝印、板框、PTH/NPTH/过孔钻孔文件。

文件 SHA-256：

- `VoxMind_EVT_V1_v9_Gerber.zip`: `5e0300153d76117ee591cc7c14122dc88340bc0175166d63e9b08f384f05b83f`
- `VoxMind_EVT_V1_v9_BOM.xlsx`: `bd5585daf9be43a11c1779f10b8d812e40bab43b0580f737a8c5987ae3f211f9`
- `VoxMind_EVT_V1_v9_PickAndPlace.zip`: `7213db9f1167ce64a5cc08dbcc5d46cb2be606244d1d4c01d03bc792018c77b9`

下单时仅使用本目录 v9 文件，不要上传旧 v8 文件。建议先让嘉立创 SMT 系统完成器件匹配预览，重点人工核对 U3、U10/U11、U9、J4/J8 的面别、旋转与1脚方向后再付款。

PCB 参数保持：4层、100×55mm、1.6mm板厚、**1 oz铜厚**、ENIG、双面SMT。板上局部间距约4.19mil；嘉立创官方能力标注多层板1 oz可做到3.5/3.5mil，因此满足，但不可擅自改成2 oz（2 oz多层最小约6/6mil）：https://jlcpcb.com/capabilities/pcb-capabilities/

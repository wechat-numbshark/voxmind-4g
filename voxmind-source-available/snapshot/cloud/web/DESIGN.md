---
name: VoxMind 控制台
description: 航管进程单：每个待执行动作是一张插在按风险着色卡槽里的白纸条，签放才执行。
colors:
  console: "#E9EDEC"
  console-deep: "#DDE3E1"
  paper: "#FFFFFF"
  paper-2: "#F6F8F7"
  rule: "#D5DCDA"
  rule-strong: "#B3BFBC"
  ink: "#12202A"
  ink-2: "#445561"
  ink-3: "#61717C"
  act: "#0A6E64"
  act-hover: "#085A52"
  act-tint: "#E1F1EE"
  rec: "#D92D3A"
  tier-ext: "#E9A21B"
  tier-ext-tint: "#FFF3D6"
  tier-ext-ink: "#5E4200"
  tier-own: "#2766AE"
  tier-own-tint: "#E4EFFB"
  tier-own-ink: "#133F6E"
  tier-rec: "#1E7A4B"
  tier-rec-tint: "#E0F3E8"
  tier-rec-ink: "#11502F"
  tier-phy: "#E0604A"
  tier-phy-tint: "#FCE5E0"
  tier-phy-ink: "#7E2616"
  holder-done: "#9AA8A5"
  holder-neutral: "#7D8C89"
  ok: "#1E8A55"
  warn: "#B26A00"
  bad: "#C4262F"
typography:
  display:
    fontFamily: "PingFang SC, Hiragino Sans GB, Microsoft YaHei, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.55
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "PingFang SC, Hiragino Sans GB, Microsoft YaHei, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.55
  title:
    fontFamily: "PingFang SC, Hiragino Sans GB, Microsoft YaHei, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "PingFang SC, Hiragino Sans GB, Microsoft YaHei, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  body-sm:
    fontFamily: "PingFang SC, Hiragino Sans GB, Microsoft YaHei, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.55
  label:
    fontFamily: "PingFang SC, Hiragino Sans GB, Microsoft YaHei, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.55
  clock:
    fontFamily: "SF Mono, JetBrains Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "0"
    fontFeature: "tnum"
  mono-time:
    fontFamily: "SF Mono, JetBrains Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: "15px"
    fontWeight: 600
    letterSpacing: "0"
    fontFeature: "tnum"
  mono-data:
    fontFamily: "SF Mono, JetBrains Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    letterSpacing: "0"
    fontFeature: "tnum"
rounded:
  paper: "1px"
  strip: "2px"
  tag: "4px"
  sm: "6px"
  control: "7px"
  nav: "8px"
  md: "10px"
  full: "999px"
spacing:
  strip-gap: "2px"
  cell: "9px 14px"
  sheet: "16px 18px"
  sheet-head: "14px 18px"
  section: "22px"
  page-x: "28px"
  page-x-mobile: "12px"
  touch: "44px"
components:
  button-sign:
    backgroundColor: "{colors.act}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "0 13px"
    height: "34px"
  button-sign-hover:
    backgroundColor: "{colors.act-hover}"
    textColor: "{colors.paper}"
  button-return:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.bad}"
    rounded: "{rounded.control}"
    padding: "0 13px"
    height: "34px"
  button-default:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 13px"
    height: "34px"
  button-default-hover:
    backgroundColor: "{colors.paper-2}"
  button-flat:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 9px"
    height: "28px"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "6px 11px"
    height: "36px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.nav}"
    padding: "8px 10px"
  nav-item-active:
    backgroundColor: "{colors.act-tint}"
    textColor: "{colors.act}"
  tool-tag:
    backgroundColor: "{colors.tier-own-tint}"
    textColor: "{colors.tier-own-ink}"
    rounded: "{rounded.tag}"
    padding: "1px 6px"
    typography: "{typography.label}"
  pill:
    backgroundColor: "{colors.console}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  strip-paper:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.paper}"
    height: "72px"
  sheet:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  bay:
    backgroundColor: "{colors.console-deep}"
    rounded: "{rounded.strip}"
    padding: "4px 14px 4px 0"
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.nav}"
    padding: "10px 14px"
---

# Design System: VoxMind 控制台

## Overview

**Creative North Star: "塔台进程单架"**

VoxMind 的每一个待执行动作都是一张航管进程单（flight progress strip）：一条纯白长纸，插进一只有色塑料卡槽，一张挨一张竖排在凹进去的架子上。管制员看一眼架子就知道有几张、哪张最急；签了才放行。成员在「今天」页扫架子、读原话、听原声、签放或退回；管理员在同一套纸面语法里管人、发设备、查回执和审计。台账、读数、日志都沿用纸条的印刷格子，而不是另起一套后台组件。

这是明亮版本：冷白控制台底、纯白纸、墨色字。颜色只承担信息——卡槽颜色是风险等级，深青只属于「签放」，录音红只属于录音状态灯。深度来自纸压在架子上的一点落影和架子本身的内凹，不来自渐变、光晕或玻璃。密度偏高、像仪器：时间、倒计时、编号、电量一律等宽数字，格与格之间 1px 竖线。

（方向记录 `.impeccable/direction.json` 里的原始色板是深底 + 荧光青；用户要求明亮配色，实际构建以本文为准。）

**Key Characteristics:**
- 冷白控制台 + 纯白纸条 + 墨色，明亮、低饱和
- 有色卡槽 = 风险等级，左侧握把竖印等级字（对外 / 个人 / 记录 / 设备）
- 纸面用 1px 竖线分格：时间格 / 内容格 / 签放格
- 唯一实心强调是深青「签放」按钮
- 等宽数字承载所有测量值；倒计时是纸条上最大的字
- 急的单子往外推一截，而不是变红一整片

## Colors

冷灰绿的控制台与纯白纸是底，四种卡槽色表示风险，一种深青表示动作，一种红表示录音——其余全是墨的深浅。

### Primary
- **签放深青** (`act`)：全站唯一的实心动作色。「签放」按钮、保存、新建用户等主操作；导航当前项的文字；焦点环（2px 实线 + 2px 偏移）；输入框聚焦描边。`act-tint` 是它的浅底，只用于导航当前项背景和输入聚焦外圈（3px）。`act-hover` 仅用于主按钮悬停。

### Secondary（卡槽 / 风险等级）
每个等级是一组三色：卡槽实色（握把与框）、`-tint` 浅底（工具标签、提示条底）、`-ink` 深字（浅底上的文字）。
- **琥珀·对外** (`tier-ext`)：对外写入与高影响动作。握把字用深棕 `#2B1D00`。同时借作「数量徽标」（导航上的待签放计数，字色 `#3A2900`）、搜索命中高亮底（`tier-ext-tint`）、警示提示条和一次性密钥框的描边——都是「需要你注意」的语义。
- **天蓝·个人** (`tier-own`)：个人写入（飞书任务 / 日程等）。已加深到白字 ≥4.5:1，握把字为白色。`tier-own-tint` / `tier-own-ink` 也用于信息型提示条与 `pill.info`。
- **薄荷·记录** (`tier-rec`)：只记录、自动执行的动作。握把白字。
- **珊瑚·设备** (`tier-phy`)：物理控制（智能家居）。握把字用深红褐 `#2A0A04`。

### Tertiary（专属状态色）
- **录音红** (`rec`)：只用于录音状态灯的圆点。它不是错误色，也不是强调色。
- **成功绿** (`ok`)、**警示褐** (`warn`)、**失败红** (`bad`)：结论文字、状态胶囊、倒计时告急、退回按钮、转写失败行、toast 失败态。`bad` 与 `rec` 是两个不同的值，不可互换。

### Neutral
- **控制台** (`console`)：页面底色；分段切换器与胶囊的底。
- **架子槽** (`console-deep`)：进程单架的内凹托盘底。
- **纸** (`paper`) / **旧纸** (`paper-2`)：纸条、面板、导轨、输入框；`paper-2` 是悬停底、日志分组条、已处理纸条的纸面。
- **细线** (`rule`) / **粗线** (`rule-strong`)：格间 1px 竖线与行分隔用 `rule`；按钮与输入描边、架子上下导轨（2px）用 `rule-strong`。
- **墨** (`ink`)、**次墨** (`ink-2`，白底 7.6:1)、**淡墨** (`ink-3`，白底 4.9:1)：`ink-3` 是最淡的可读字，只给占位符、静音、删除线颜色。
- **已处理卡槽** (`holder-done`) / **中性卡槽** (`holder-neutral`)：处理完的单子卡槽灰掉；设备单这种没有风险等级的纸条用中性灰卡槽。

### Named Rules
**The Holder Means Risk Rule.** 卡槽颜色只表示风险等级。没有风险等级的东西（设备、账号）用中性灰卡槽，处理过的用已处理灰——绝不为了好看给它们挑一个等级色。

**The One Solid Rule.** 深青 `act` 是唯一的实心填充强调。同一张纸条上只允许一个实心按钮，它就是「签放」。

**The Honest Red Rule.** `rec` 只出现在录音状态灯上，且只由真实上传时间推出（2 分钟内有新块为「录音上云中」，1 小时内为「N 分钟没有新录音」，否则「设备未在上传」）。

## Typography

**Display / Body Font:** PingFang SC（回退 Hiragino Sans GB、Microsoft YaHei、系统 UI 栈）
**Mono Font:** SF Mono（回退 JetBrains Mono、ui-monospace、Menlo、Consolas），始终配 `tabular-nums`、`letter-spacing: 0`

**Character:** 中文系统黑体负责读，等宽体负责量。字重只用 400 / 500 / 600 三档，靠字号和墨色深浅分层，不靠粗细堆叠。

### Hierarchy
- **Display**（600，28px，-0.01em；手机 24px）：每页唯一的页标题，左上。
- **Headline**（600，17px）：架子标题（「待签放 4」）、面板标题。计数跟在后面，用 15px 等宽 `ink-2`。
- **Title**（600，16px，行高 1.35）：纸条上的动作标题。
- **Body**（400，15px，行高 1.55）：页面基准字号。
- **Body-sm**（500，14px）：动作说明、台账单元格、读数行、日志行、按钮。
- **Label**（500，13px）：来源（「明确说出 / 推测意图」）、原话、字段名、表头、工具标签（600）、握把等级字（600，0.15em 字距，竖排直立）。13px 是全站最小正文字号。
- **Clock**（等宽 600，20px，行高 1.1）：倒计时，纸条上最大的字；单位「后作废」用 13px 无衬线 `ink-2` 跟在后面。告急（<120 秒）变 `bad`。
- **Mono-time**（等宽 600，15px）：纸条时间格里的 HH:MM。
- **Mono-data**（等宽 400，12–13px）：日志时间、台账时间、设备 ID、回执号、置信度。

### Named Rules
**The Measured Numbers Rule.** 时间、倒计时、编号、计数、电量、置信度一律等宽 + 表格数字。它们是测量数据，要能上下对齐、逐秒跳动而不抖。

**The Printed Field Rule.** 字段名（表头、读数左栏、表单标签）是 13px 500 `ink-2` 的印刷小字，不做全大写、不加字距、不做眉标。

## Layout

- **桌面外框**：左侧 208px 白色导轨（sticky，满高，右 1px `rule`）+ 右侧工作区。工作区页头内边距 `20px 28px 16px`，内容区左右 28px、区块间距 22px。
- **分栏**：主从两栏 `minmax(0, 1.55fr) minmax(300px, 1fr)`（「今天」：左架子、右日志）；等分两栏（总览）；列表 + 详情 `minmax(240px, 0.7fr) minmax(0, 2fr)`。≤900px 全部单栏。
- **进程单内部**：纸面三格 `76px | 1fr | auto`——时间格、内容格、签放格，格内 `9px 14px`，最小高 72px。纸条之间只隔 2px，像插得很满的架子。
- **架子**：右侧留 14px 让告急单外推 10px 后仍在托盘里；左侧 0，卡槽贴着架子边。
- **手机（≤760px）**：导轨隐藏，换成底部固定标签栏（每格最小高 52px，含安全区）；页头 16px 边距，内容区 12px 边距、底部让出 `84px + safe-area`。纸条三格改上下排：时间格横排（时间左、来源右），签放格里倒计时独占一行，下面按钮整行平分、最小高 44px。台账改两行一条（第一行时间和人，第二行做了什么），表头隐藏。管理员的工作区切换挪到页头右侧按钮。
- **最急在上**：架子按剩余时间升序排，不会作废的按到达先后排在最后。

## Elevation & Depth

整体是平的纸面，深度只有两种来源：架子内凹，纸条微微压在架子上。没有渐变背景、没有光晕、没有毛玻璃。

### Shadow Vocabulary
- **架子内凹**（`box-shadow: inset 0 2px 3px -1px rgba(18, 32, 42, 0.14)`，加上下 2px `rule-strong` 导轨）：进程单架托盘。
- **纸条落影**（`box-shadow: 0 1px 1px rgba(18, 32, 42, 0.16)`）：每张待签放纸条；已处理的去掉。
- **分段按下**（`box-shadow: 0 1px 2px rgba(18, 32, 42, 0.12)`）：导轨工作区切换的当前项。
- **浮层**（`box-shadow: 0 8px 24px -8px rgba(18, 32, 42, 0.45)`）：只给 toast。

### Named Rules
**The Paper On Rack Rule.** 能被操作的单子才有落影；处理过的单子贴平、卡槽变灰、纸面变 `paper-2`。深度即状态。

## Shapes

两套形体语言，按「是不是进程单」区分：
- **纸条系**近乎直角：卡槽与架子 2px、纸 1px、工具标签 4px。它们模仿的是印刷纸和注塑卡槽。
- **面板与控件系**轻圆角：面板 `sheet` 10px、导航项 8px、按钮与输入 7px、空架子虚线框 6px、胶囊与录音灯全圆。
- **线**：格间 1px 实线竖分隔；原话备注栏上方是 1px **虚线**（像进程单下半截手写栏）；台账表头下压 1.5px `ink` 墨线；空状态用 1px 虚线 `rule-strong` 框。
- **握把**：卡槽左侧加宽成 26px 握把，等级字竖排直立——这是承载信息的结构，不是装饰色边。

## Components

### Buttons
- **Shape:** 7px 圆角，最小高 34px（`sm` 28px；手机签放行 44px），1px `rule-strong` 描边，白底，14px 500。图标 15px，与文字间距 6px。
- **签放（主）:** `act` 实底白字 600；悬停 `act-hover`。只用于签放、保存、新建这类「放行」动作。
- **退回（否决）:** 白底 `bad` 字，描边 `#E7B4B7`；悬停底 `#FDF0F0`、描边 `bad`。退回、停用、吊销。
- **默认:** 白底墨字；悬停 `paper-2` 底、描边 `ink-3`。
- **Flat:** 透明无描边；悬停 `paper-2`。原声回放、修改（铅笔图标按钮）、「查看全部录音」、读数里的可点数字。
- **状态:** 按下下沉 1px；禁用 50% 透明；忙碌时文字换成进行时（「签放中」「退回中」）。焦点统一 2px `act` 外环、偏移 2px。
- **过渡:** 140ms `cubic-bezier(0.16, 1, 0.3, 1)`，只动背景、描边、文字色。

### 进程单 Strip（签名组件）
- **结构:** 卡槽（`--holder` 实色，26px 握把 + 2px 包边）包住白纸；纸分三格：时间格（HH:MM + 来源）、内容格（工具标签 + 标题 + 说明 + 虚线下的原话栏）、签放格（倒计时在上，铅笔 / 退回 / 签放在下）。
- **等级:** `data-tier` = `ext` / `own` / `rec` / `phy` 切换卡槽、标签浅底、标签深字三色。
- **原话栏:** 「」引号包裹的原话，桌面单行截断、手机三行；右侧「原声」回放与「把握 NN%」。同一时间只放一段原声。
- **告急:** 剩余 <120 秒时整张纸条向右推 10px（手机 6px），倒计时变 `bad`。到零显示「已过时限 · 正在作废」并禁用签放。
- **到达 / 离开:** 新单从左侧推入（-24px → 0，320ms）；签放或退回后向右滑出 28px 并淡出（220ms），然后才移出列表。
- **修改态:** 内容格变两个输入框，签放格变「取消 / 保存」。
- **已处理（回执）:** 卡槽 `holder-done`，无落影，纸面 `paper-2`，工具标签去色；签放格改为结论（✓ 已执行 / ⚠ 执行失败 / ↰ 已退回 / ⊘ 已作废 / 已吊销）+ 等宽回执号或错误说明。退回与作废的标题用删除线划掉。
- **中性纸条:** 设备等无风险等级的对象用 `holder-neutral` 卡槽，握把印状态（在线 / 离线 / 吊销），签放格放电量与网络。

### 进程单架 Bay
- `console-deep` 内凹托盘，上下 2px 导轨，标题行「名称 + 等宽计数」，桌面右侧是卡槽颜色图例（10px 方块 + 等级 + 数量，手机隐藏）。
- 空架子：白底虚线框，绿色对勾图标 + 粗体一句结论 + 一句说明下一张单子会从哪里来。

### Cards / Containers（纸面板 Sheet）
- **Corner Style:** 10px。
- **Background:** `paper`，1px `rule` 描边，无阴影。
- **结构:** 头部 `14px 18px`、下 1px 分隔，右侧可放录音灯或次要按钮；主体 `16px 18px`。
- **读数 Readout:** 面板里的左名右值铭牌行——左栏 `ink-2` 字段名，右栏右对齐等宽值，每行下 1px `rule`。用它代替一排指标卡。

### 台账 Ledger
- 白底整表放进 `sheet`；表头 13px 500 `ink-2`，下压 1.5px 墨线；格间 1px 竖线；行悬停 `paper-2`；时间列等宽 13px `ink-2`。手机改两行一条。

### 日志 Log
- 三列 `58px | 1fr | auto`：等宽时间、转写原文、播放图标按钮；行间 1px `rule`。静音用 `ink-3`，失败行用 `bad` 且写明「稍后会重试」。按会话分组时用 `paper-2` 分组条。

### Chips（工具标签与状态胶囊）
- **工具标签:** 4px 圆角、`1px 6px` 内边距、13px 600，底色与字色取当前卡槽的 `-tint` / `-ink`。
- **状态胶囊:** 全圆、`2px 8px`、13px 600，前置 6px 实心圆点（`currentColor`）。默认 `console` 底 `ink-2` 字；`ok` 为 `#E1F4EA` 底 `#146B40` 字；`warn` 取琥珀 tint / ink；`bad` 为 `#FCE7E8` 底 `#A11D25` 字；`info` 取天蓝 tint / ink。

### 录音状态灯 RecLight
- 全圆白底胶囊、1px `rule` 描边、13px 600；8px 圆点。在录：`rec` 圆点 2.2s 呼吸（透明度 0.35 ↔ 1）；停滞：圆点与文字 `warn`；离线：圆点 `rule-strong`、文字 `ink-3`。

### Inputs / Fields
- **Style:** 白底，1px `rule-strong`，7px 圆角，最小高 36px，`6px 11px`。标签 13px 500 `ink-2` 在上，间距 5px。占位符 `ink-3`。复选框用 `act` 作 accent，18px。
- **Focus:** 描边变 `act`，外加 3px `act-tint` 光圈。
- **Error:** 下方 13px `bad` 文字。
- **分段切换器:** 7px 圆角描边组，格间 1px `rule`；按下项反白为 `ink` 底白字。

### Navigation
- **桌面导轨:** 品牌标（圆环内两道竖线，24px，`ink`）+「VoxMind」；管理员有「我的工作台 / 管理」分段切换（`console` 底，当前项白底 + 微影）；导航项 14px `ink-2`，17px 线性图标，悬停 `paper-2`，当前项 `act-tint` 底 `act` 字 600；待签放数用琥珀等宽小徽标。底部是账号与「退出登录」。
- **手机标签栏:** 白底上 1px `rule`，图标 20px 在上、13px 文字在下，当前项 `act`；计数徽标挂在图标右上。

### 提示条与 Toast
- **Notice:** 8px 圆角，`12px 14px`，默认琥珀 tint 底 / ink 字（警示），`info` 用天蓝；图标 17px；可带「重试」按钮。
- **Toast:** 右下角，`ink` 底白字，8px 圆角，唯一带浮层阴影的元素；失败态底 `#8F1B22`。成功 2.6 秒、失败 5 秒消失。手机横向铺满、浮在标签栏上方。
- **一次性密钥框:** 白底、1px `tier-ext` 描边、等宽 14px、`user-select: all`。

### Motion
- 缓动统一 `cubic-bezier(0.16, 1, 0.3, 1)`；控件 140ms，纸条推移 220ms，到达 320ms，toast 200ms。
- 运动只表达纸条的物理动作（推入、外推、抽出）与录音呼吸，不做装饰动画。`prefers-reduced-motion` 下全部压到 0.01ms。

## Do's and Don'ts

### Do:
- **Do** 把每个需要人决定的动作做成进程单：卡槽着色、握把竖印等级、三格纸面、签放格里倒计时在上按钮在下。
- **Do** 让卡槽颜色只表达风险等级；设备等无等级对象用 `holder-neutral`，处理完的用 `holder-done`。
- **Do** 用读数铭牌行（左名右值、等宽右对齐）展示统计，用台账展示列表，二者都用 1px 竖线 / 行线分格。
- **Do** 所有测量值用等宽表格数字；倒计时是纸条上最大的字。
- **Do** 用外推 10px 表示告急，再配合倒计时变 `bad`。
- **Do** 每张纸条只放一个实心 `act` 按钮；其余操作用描边或 flat 按钮。
- **Do** 手机上签放行按钮 ≥44px 且整行平分，底部标签栏让出安全区。

### Don't:
- **Don't** 做「一排指标卡 + 表格」的通用 SaaS 后台首页。
- **Don't** 把 `rec` 录音红用在错误、退回或强调上；错误用 `bad`。
- **Don't** 为装饰给面板加渐变、光晕、毛玻璃或大阴影；浮层阴影只属于 toast。
- **Don't** 把卡槽退化成卡片左侧的一道彩色边——握把要足够宽、要印等级字。
- **Don't** 给纸条用大圆角；纸条系保持 1–2px，圆角只属于面板与控件。
- **Don't** 显示没有真实数据支撑的录音状态或功能（全文索引、导出、用量统计等尚未实现）。
- **Don't** 用 13px 以下的字承载正文，或用比 `ink-3` 更淡的颜色写可读文字。

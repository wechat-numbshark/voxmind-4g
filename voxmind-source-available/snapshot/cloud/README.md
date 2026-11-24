# VoxMind 云端

TypeScript / Node 20+ ｜ Fastify + MQTT + 飞书 + Claude

## 为什么是 TypeScript 不是 Python

决定性因素是 **ASR 走云 API 而不是自建**。一旦不自建 ASR，Python 的语音 ML 生态优势就归零，
剩下的全是 I/O 编排（收音频、调 Claude、发 MQTT、收飞书回调、带过期的状态队列），这是 Node 的主场。

另外两条更实在的理由：
1. `src/types.ts` 是设备、云端、飞书三方的**唯一契约**。这套协议很碎
   （三级分类 × 双通道 × 过期规则），类型对不上是最容易出的 bug，TS 能在编译期挡掉。
2. 飞书有官方 Node SDK（`@larksuiteoapi/node-sdk`），不是社区包。

**代价**：以后要做自建/端侧 ASR 或音频 ML，得单独起 Python 微服务用 HTTP 接进来。
不要为了那一天现在就把整个云端写成 Python。

## 跑起来

```bash
cp .env.example .env    # 填 Claude / 飞书 / MQTT / ASR 的凭据
npm install
npm run dev
```

`ffmpeg` 必须在 PATH 里（用来把设备传的 Opus 解成 16k PCM）。

## 结构

```
src/
  types.ts          ★ 三方共享契约。改这里会让另外两端编译报错——这是好事
  intent/
    prompt.ts       系统提示词（稳定前缀，走 prompt caching）
    classify.ts     三级分类器：LLM 判 kind，【分级由代码查表】
  queue/pending.ts  待确认队列：双通道状态同步 + 按级过期
  push/mqtt.ts      设备通道（⚠ 只有 30 秒唤醒窗口）
  push/feishu.ts    飞书通道（异步，成本低，中置信度只走这条）
  asr/index.ts      ASR 适配层 + Opus 解码
  pipeline.ts       主管线
  index.ts          HTTP + MQTT 入口 + 过期清扫
```

## 三条不要改错的规则

1. **分级由 `KIND_TIER` 查表决定，不采信模型输出。**
   模型判飘了也不能把"发飞书消息"当成 A 类直接执行。

2. **置信度分流：≥0.85 双通道 / 0.6~0.85 只飞书 / <0.6 不推。**
   设备端弹卡片是"打断用户"，成本很高。宁可漏，不可错。

3. **30 秒唤醒窗口是硬约束。** 设备上传完只醒 30 秒，之后 4G 进 PSM，
   下次能收推送要等一个 TAU 周期（默认 1 小时）。ASR + 意图抽取跑不完就只推飞书。

## 待接入

- [ ] `asr/index.ts` → 选一家接上（建议阿里云智能语音交互）
- [ ] `index.ts` 的 `store` → 换成 Postgres/Redis（现在是内存，重启即丢）
- [ ] 确认后的实际执行：调飞书 API 建日程/发消息/提审批
- [ ] 飞书回调的签名校验（`LARK_ENCRYPT_KEY` / `LARK_VERIFICATION_TOKEN`）
- [ ] 设备鉴权：现在 `/v1/recordings` 谁都能传

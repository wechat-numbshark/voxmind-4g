/* 回放「清晰」模式：人声拉到正常音量，碰撞/摩擦这类尖峰压下去。只用于回放和导出，转写仍用原始录音。
 *
 * 2026-10-04 抽 80 段有人声的录音实测：人声中位 -58 dBFS（正常录音在 -20 左右），块里最响的尖峰
 * 到 -8 dBFS——拿东西、衣服蹭到机身，比人声高 22 dB（中位），17 段高出 30 dB 以上，最多 53 dB。
 * 固定增益（gain.ts）把两者一起放大：人声还是小，碰撞声更吓人。
 *
 * 为什么不用神经网络降噪：文献里降噪对识别普遍有害（伪影比噪声更伤识别），所以识别不走这里；
 * 回放这边主要问题是「人声太小 + 尖峰太大」，是电平问题不是噪声问题，传统处理就能解决，
 * 而且确定、便宜（服务器 2 核 2GB）。真要去背景噪声，第二步再接 DeepFilterNet 这类模型。
 *
 * 处理链：100Hz 高通（碰撞、摩擦能量大多在低频）→ 按这一块里的人声电平定增益（目标 -14 dBFS，
 * 最多 +44 dB）→ 尖峰压制（比人声高 10 dB 以上的 10ms 帧立刻压回去，80ms 慢慢放开，带 5ms 预读）
 * → 字间降噪门（比人声低 20 dB 以上的帧再压最多 10 dB）→ 软限幅。
 * 按块处理，但增益只跟人声电平走、不跟整块最大值走，所以相邻块音量不会忽大忽小。
 *
 * 2026-10-04 用户实测距离（贴着、1/2/5/6~7 米）：人声 -36~-59 dBFS，字间背景约 -70；5 米人声比背景高 ~20 dB，
 * 6~7 米只高 ~10 dB。第一版目标 -20、最多 +36，用户反馈「清晰模式人声还是很小」——手机里视频、音乐的人声在
 * -10~-14 左右，比它响 8~10 dB。远处的话放大 40 多 dB 会把字间的嘶嘶声一起抬起来，所以加了降噪门。*/

const RATE = 16_000;
const FRAME = 160;                 // 10ms
const TARGET_DB = -14;
const MAX_GAIN_DB = 44;
const GATE_BELOW_DB = 20;         // 比人声低这么多的帧算字间背景
const GATE_DEPTH_DB = 10;         // 背景最多再压这么多
const GATE_RELEASE_MS = 150;
const SPIKE_OVER_DB = 10;          // 比人声电平高这么多才算尖峰（正常重读音节在 +6~8 dB 以内）
const RELEASE_MS = 80;
const LOOKAHEAD = 80;              // 5ms
const KNEE = 0.6;

const toDb = (x: number) => (x > 0 ? 20 * Math.log10(x) : -120);
const fromDb = (d: number) => 10 ** (d / 20);

/** 二阶巴特沃斯高通 */
function highpass(x: Float32Array, cutoff: number) {
  const w = (2 * Math.PI * cutoff) / RATE;
  const cos = Math.cos(w), alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0, b1 = -(1 + cos) / a0, b2 = b0, a1 = (-2 * cos) / a0, a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]!; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** 人声电平：有声帧（高于静音门限）里的 80 分位 RMS。没有有声帧返回 null */
export function speechLevelDb(x: Float32Array) {
  const levels: number[] = [];
  for (let i = 0; i + FRAME <= x.length; i += FRAME) {
    let e = 0;
    for (let j = i; j < i + FRAME; j++) e += x[j]! * x[j]!;
    const db = toDb(Math.sqrt(e / FRAME));
    if (db > -75) levels.push(db);
  }
  if (levels.length < 10) return null;          // 不到 0.1 秒有声，当静音处理
  levels.sort((a, b) => a - b);
  return levels[Math.floor(levels.length * 0.8)]!;
}

export function clarify(pcm16: Buffer): Buffer {
  const n = Math.floor(pcm16.length / 2);
  if (!n) return pcm16;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = pcm16.readInt16LE(i * 2) / 32768;
  const x = highpass(raw, 100);

  const speech = speechLevelDb(x);
  const gainDb = speech === null ? 18 : Math.max(0, Math.min(MAX_GAIN_DB, TARGET_DB - speech));
  const ceilingDb = (speech ?? -58) + SPIKE_OVER_DB;   // 尖峰压到不超过「人声 +10 dB」

  /* 两条增益各管各的：
   * - 尖峰：超过「人声 +10 dB」就压。快压（带 5ms 预读）、80ms 慢放，碰撞声来了立刻压住
   * - 降噪门：比人声低 20 dB 以上算字间背景，最多再压 10 dB。快开（看下一帧，字头不被吃掉）、150ms 慢关 */
  const frames = Math.ceil(n / FRAME);
  const spike = new Float32Array(frames).fill(1);
  const gate = new Float32Array(frames).fill(1);
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let peak = 0, e = 0;
    const end = Math.min(n, (f + 1) * FRAME);
    for (let j = f * FRAME; j < Math.min(n, end + LOOKAHEAD); j++) peak = Math.max(peak, Math.abs(x[j]!));
    for (let j = f * FRAME; j < end; j++) e += x[j]! * x[j]!;
    rms[f] = toDb(Math.sqrt(e / Math.max(1, end - f * FRAME)));
    const over = toDb(peak) - ceilingDb;
    if (over > 0) spike[f] = fromDb(-over);
  }
  if (speech !== null) {
    const gateDb = speech - GATE_BELOW_DB;
    for (let f = 0; f < frames; f++) {
      const loudest = Math.max(rms[f]!, rms[f + 1] ?? -120, rms[f + 2] ?? -120);   // 往后看 20ms
      if (loudest < gateDb) gate[f] = fromDb(-Math.min(GATE_DEPTH_DB, gateDb - loudest));
    }
  }
  const spikeRelease = Math.exp(-1 / ((RELEASE_MS / 1000) * RATE));
  const gateClose = Math.exp(-1 / ((GATE_RELEASE_MS / 1000) * RATE));
  const gain = fromDb(gainDb);
  const out = Buffer.alloc(n * 2);
  let gs = 1, gg = 1;
  for (let i = 0; i < n; i++) {
    const f = Math.floor(i / FRAME);
    const ts = spike[f]!, tg = gate[f]!;
    gs = ts < gs ? ts : ts - (ts - gs) * spikeRelease;
    gg = tg > gg ? tg : tg - (tg - gg) * gateClose;
    const v = x[i]! * gs * gg * gain;
    const a = Math.abs(v);
    const y = a <= KNEE ? v : Math.sign(v) * (KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE)));
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(y * 32767))), i * 2);
  }
  return out;
}

/** 给降噪模型用的输入：只把人声拉到 -20 dBFS 左右（最多 +44 dB）并软限幅，不做尖峰压制和降噪门。
 *  模型没见过 -50~-60 dBFS 这么小的人声，直接喂会把人声当噪声压掉 15~24 dB（实测）。*/
export function normalizeForModel(pcm16: Buffer): Buffer {
  const n = Math.floor(pcm16.length / 2);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = pcm16.readInt16LE(i * 2) / 32768;
  const speech = speechLevelDb(x);
  const gain = fromDb(speech === null ? 18 : Math.max(0, Math.min(MAX_GAIN_DB, -20 - speech)));
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = x[i]! * gain;
    const a = Math.abs(v);
    const y = a <= KNEE ? v : Math.sign(v) * (KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE)));
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(y * 32767))), i * 2);
  }
  return out;
}

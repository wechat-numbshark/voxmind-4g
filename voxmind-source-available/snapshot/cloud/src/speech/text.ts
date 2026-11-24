import { pinyin } from "pinyin-pro";

/* 语气词：只有「嗯」「对」「好的」这类字、又很短的，不算一句话。
 * 线上 80% 的转写就是这种，拿它们去调大模型纯属花钱。*/
const FILLER_CHARS = /^[嗯啊哦噢呃额唔哈嘿诶欸哎呀对是好的吧嘛呢喔哇噫嗷]+$/;

export function isFiller(text: string) {
  const bare = text.replace(/[\s\p{P}\p{S}]/gu, "");
  return bare.length === 0 || (bare.length <= 4 && FILLER_CHARS.test(bare));
}

/* ── 唤醒指令 ────────────────────────────────────────────────────
 * 用户会叫两声「小沃小沃」，但识别到一个「小沃」就算：两声里总有一声清楚。
 *
 * 为什么按拼音比对：语音识别常把「沃」写成「我 / 窝 / 握 / 卧」，按汉字比对会大量漏掉。
 * 去掉声调后它们全是 wo。代价是「小我」「小窝」也会命中——所以必须是以唤醒词开头的
 * 完整、明确的本机开关机请求，不能在一大段话里搜到「唤醒词 + 关机」就执行。*/

export type PowerCommand = "off" | "on";

function syllables(text: string): string[] {
  return pinyin(text, { toneType: "none", type: "array", nonZh: "removed", v: true })
    .map((s) => s.toLowerCase().trim()).filter(Boolean);
}

/** 唤醒词的核心音节。「小沃小沃」这种叠词只取一半，识别到一次就够 */
export function wakeSyllables(wakeWord: string): string[] {
  const all = syllables(wakeWord);
  const half = all.length / 2;
  if (all.length >= 4 && Number.isInteger(half) && all.slice(0, half).join(" ") === all.slice(half).join(" ")) {
    return all.slice(0, half);
  }
  return all;
}

/** 设备离线识别用的指令串（ESP-SR MultiNet 按拼音配置，空格分隔、不带声调） */
export function deviceCommandPhrases(wakeWord: string) {
  const w = wakeSyllables(wakeWord).join(" ");
  return { on: [`${w} kai ji`, `${w} ${w} kai ji`], off: [`${w} guan ji`, `${w} ${w} guan ji`] };
}

/* 电源指令绕过普通工具确认，宁可漏掉不明确的说法，也不能误关机。
 * 只对白名单中的本机请求做整句匹配：
 * - 省略目标时，「小沃，关机」明确是在叫设备自己；
 * - 明写目标只接受本机/自己/VoxMind，空调、电脑等不在这里处理；
 * - 否定、转述、引用、提问、定时、混合指令等都无法匹配。
 * 拼音容错只用于唤醒词；命令仍按原文判断，避免把「关鸡」等同音词当电源指令。
 */
const DIRECT_POWER_REQUEST = /^(?:请(?:你)?|请帮我|麻烦(?:你)?|帮我)?(?:现在|立即|马上)?(?:(?:让|把)?(?:本机|你自己|自己|VoxMind))?(关机|开机)(?:一下)?(?:吧)?$/iu;

export function detectPowerCommand(text: string, wakeWord: string): PowerCommand | null {
  // 仅消掉停顿和陈述/祈使标点。引号、问号和其他符号保留，会让整句校验失败。
  const normalized = text.normalize("NFKC").replace(/[\s，,。.!！、]/gu, "");
  const w = wakeSyllables(wakeWord);
  if (!w.length || normalized.length > 64) return null;
  const chars = Array.from(normalized);
  let offset = 0;
  // 一声或两声唤醒词。必须在句首，不接受「他说小沃关机」这种转述。
  for (let repeat = 0; repeat < 2; repeat++) {
    const prefix = syllables(chars.slice(offset, offset + w.length).join(""));
    if (prefix.length !== w.length || !w.every((syl, k) => prefix[k] === syl)) break;
    offset += w.length;
    const request = DIRECT_POWER_REQUEST.exec(chars.slice(offset).join(""));
    if (request) return request[1] === "关机" ? "off" : "on";
  }
  return null;
}

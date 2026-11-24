import { describe, expect, it } from "vitest";
import { isHeaderOnlyOgg, opusToPcm16k } from "../src/asr/index.js";
import { isSpeech } from "../src/audio/vad.js";

/* 设备误碰确认键留下的空块：只有 OpusHead + OpusTags 两页、约 125 字节。以前解码报「End of file」被记成转写失败 */

/** 造一页 Ogg：27 字节页头（最后一字节是段数）+ 段表 + 数据 */
const page = (body: string) => {
  const head = Buffer.alloc(27); head.write("OggS", 0, "latin1");
  const data = Buffer.from(body, "latin1");
  head[26] = data.length ? 1 : 0;
  return Buffer.concat([head, data.length ? Buffer.from([data.length]) : Buffer.alloc(0), data]);
};

describe("只有文件头的空录音块", () => {
  /* 和设备真实空块一样：OpusHead、OpusTags，再加一个空的结束页 */
  const headerOnly = Buffer.concat([page("OpusHead\x01\x01"), page("OpusTags"), page("")]);

  it("认得出来，三页以上（有声音）的不算", () => {
    expect(isHeaderOnlyOgg(headerOnly)).toBe(true);
    expect(isHeaderOnlyOgg(Buffer.concat([headerOnly, page("audio")]))).toBe(false);
    expect(isHeaderOnlyOgg(Buffer.from("not ogg"))).toBe(false);
  });

  it("按没有声音处理：解出空 PCM，人声检测判静音，不再报解码失败", async () => {
    const pcm = await opusToPcm16k(headerOnly);
    expect(pcm.length).toBe(0);
    expect((await isSpeech(pcm)).speech).toBe(false);
  });
});

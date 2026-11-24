import { describe, expect, it } from "vitest";
import { detectPowerCommand, deviceCommandPhrases } from "../src/speech/text.js";

describe("conservative device power commands", () => {
  it.each([
    ["小沃，关机。", "off"],
    ["小沃小沃，关机。", "off"],
    ["小我小我关机", "off"],
    ["小握，开机吧", "on"],
    ["小沃，请关机。", "off"],
    ["小沃，请帮我现在关机一下吧！", "off"],
    ["小沃，麻烦你立即关机。", "off"],
    ["小沃，本机关机。", "off"],
    ["小沃，请让本机关机。", "off"],
    ["小沃，把你自己关机。", "off"],
    ["小沃，请 VoxMind 开机。", "on"],
    [" 小 沃 ， 请 关 机 。 ", "off"],
  ] as const)("accepts an explicit immediate self request: %s", (text, command) => {
    expect(detectPowerCommand(text, "小沃小沃")).toBe(command);
  });

  it.each([
    // Appliance commands must continue through the normal tool/confirmation route.
    "空调关机", "小沃，空调关机", "小沃小沃，把空调关机", "小沃，帮我关机空调",
    "小沃，电脑开机", "小沃，把电视关机", "小沃，请让设备关机", "小沃，让录音机关机",
    // Negation and corrections, even when they occur after a valid-looking command.
    "小沃，不要关机", "小沃，别关机", "小沃，不用关机", "小沃，不能关机",
    "小沃，暂时别关机", "小沃，关机，不对，别关机", "小沃，关机但先不要执行",
    // Questions, hypothetical/scheduled instructions and task requests are not immediate power commands.
    "小沃，关机？", "小沃，开机吗", "小沃，可以关机吗", "小沃，关机好不好",
    "小沃，明天关机", "小沃，等一下关机", "小沃，十分钟后关机", "小沃，提醒我关机",
    "小沃，如果没事就关机", "小沃，准备关机", "小沃，关机了", "小沃，已经关机",
    // Reported/quoted speech and mixed utterances must not bypass ordinary intent checks.
    "他说小沃关机", "刚才我说小沃小沃关机", "不是小沃关机，是空调关机",
    "小沃，说一句关机", "小沃，重复关机", "小沃，播放关机提示",
    "“小沃，关机”", "「小沃关机」", "\"小沃关机\"", "小沃，‘关机’", "小沃，关机，然后打开空调",
    // Do not drop non-Chinese tokens or accept command homophones as authoritative instructions.
    "not 小沃关机", "小沃 no 关机", "小沃，关鸡", "小沃，开鸡", "小沃关机/not",
    "小沃", "关机", "", "小沃小沃小沃关机",
  ])("rejects a non-power or ambiguous utterance: %s", (text) => {
    expect(detectPowerCommand(text, "小沃小沃")).toBeNull();
  });

  it("supports a custom Chinese wake word without accepting the default word", () => {
    expect(detectPowerCommand("小明小明，请关机", "小明小明")).toBe("off");
    expect(detectPowerCommand("晓明，开机吧", "小明小明")).toBe("on");
    expect(detectPowerCommand("小沃，关机", "小明小明")).toBeNull();
    expect(detectPowerCommand("小沃，关机", "")).toBeNull();
  });

  it("keeps the documented offline command vocabulary unchanged", () => {
    expect(deviceCommandPhrases("小沃小沃")).toEqual({
      on: ["xiao wo kai ji", "xiao wo xiao wo kai ji"],
      off: ["xiao wo guan ji", "xiao wo xiao wo guan ji"],
    });
  });
});

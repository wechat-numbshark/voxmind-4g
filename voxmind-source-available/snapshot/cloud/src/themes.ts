/* 设备屏幕主题。
 *
 * 后台选一套，服务器随心跳把"配方"推给设备：30 种颜色 + 5 个形状数，压成一串约 220 字节。
 * 设备在 NVS 里只存当前这一套，换了就覆盖——不攒旧主题，不占文件空间；开机直接用存下的，
 * 不用等联网。推的不是图片：图片要几百 KB，这块屏 4G 推一次就是一笔流量，而且换个颜色
 * 就得重做一遍图。
 *
 * 颜色顺序必须和固件 ui.h 里 ui_palette_t 的字段顺序完全一致；设备收到的颜色数对不上就不换。
 * 每套主题都过了一遍 WCAG 对比度：正文 ≥7、次要字 ≥4.5、提示字和大字 ≥3（2 寸屏，看不清
 * 的配色再好看也没用）。改颜色后跑 test/themes.test.ts。
 *
 * 性能约束（这块屏整屏重画一帧 45ms，见固件 drv_display.c 注释）：不用渐变、不用模糊阴影、
 * 不用半透明。"剪纸"那种纸片垫高一层的效果，是在纸条右下各加一道粗边做的，成本和描边一样。*/

export const THEME_ROLES = [
  "console", "paper", "rule", "rule2", "ink", "ink2", "ink3", "act", "actPress", "onAct", "rec",
  "ext", "extTint", "extInk", "own", "ownInk", "recd", "phy", "warn", "bad", "night", "nightInk",
  "head", "headInk", "headInk2", "headOk", "headBad", "clock", "bigClock", "edge",
] as const;
export type ThemeRole = (typeof THEME_ROLES)[number];

/** 形状：纸条圆角、描边粗细、右下垫层厚度（0＝没有）、按钮圆角、小标签圆角 */
export interface ThemeShape { cardR: number; cardBw: number; edge: number; btnR: number; chipR: number }

export interface Theme {
  id: string;
  label: string;
  /** 网页上选主题时的一句话说明 */
  tagline: string;
  colors: Record<ThemeRole, string>;
  shape: ThemeShape;
}

export const THEMES: Theme[] = [
  {
    id: "classic", label: "默认", tagline: "浅灰台面上的白纸条，像航管进程单。最克制，最耐看。",
    colors: {
      console: "E9EDEC", paper: "FFFFFF", rule: "D5DCDA", rule2: "B3BFBC", ink: "12202A", ink2: "445561", ink3: "61717C",
      act: "0A6E64", actPress: "085A52", onAct: "FFFFFF", rec: "D92D3A",
      ext: "E9A21B", extTint: "FFF3D6", extInk: "5E4200", own: "2766AE", ownInk: "133F6E", recd: "1E7A4B", phy: "E0604A",
      warn: "B26A00", bad: "C4262F", night: "12202A", nightInk: "FFFFFF",
      head: "FFFFFF", headInk: "12202A", headInk2: "445561", headOk: "1E7A4B", headBad: "C4262F",
      clock: "12202A", bigClock: "12202A", edge: "D5DCDA",
    },
    shape: { cardR: 6, cardBw: 1, edge: 0, btnR: 8, chipR: 4 },
  },
  {
    id: "dopamine", label: "多巴胺", tagline: "奶油底、太阳黄顶栏、糖果色卡片，粗描边大圆角。看一眼心情就好。",
    colors: {
      console: "FFF3E0", paper: "FFFFFF", rule: "2A1B3D", rule2: "C9B8D9", ink: "2A1B3D", ink2: "5E4B73", ink3: "7C6A90",
      act: "E8206F", actPress: "C0145A", onAct: "FFFFFF", rec: "F0243F",
      ext: "F27A00", extTint: "FFE7C7", extInk: "8A4200", own: "2F5BF0", ownInk: "1C3AA8", recd: "0E9A6E", phy: "8E44F5",
      warn: "B85F00", bad: "D91A35", night: "2A1B3D", nightInk: "FFF3E0",
      head: "FFD43B", headInk: "2A1B3D", headInk2: "5A4630", headOk: "0B6E49", headBad: "B3122C",
      clock: "2A1B3D", bigClock: "E8206F", edge: "2A1B3D",
    },
    shape: { cardR: 14, cardBw: 2, edge: 0, btnR: 22, chipR: 10 },
  },
  {
    id: "papercut", label: "剪纸", tagline: "宣纸底、中国红顶栏，每张纸条下面垫一层红纸，方角利落，按钮按下去会沉。",
    colors: {
      console: "F2E3C6", paper: "FFF9EE", rule: "4A2A1C", rule2: "BFA27A", ink: "2B1A12", ink2: "5C4033", ink3: "7E6150",
      act: "C8102E", actPress: "9E0B23", onAct: "FFF9EE", rec: "C8102E",
      ext: "C77A12", extTint: "F8E3BC", extInk: "6E3F06", own: "1F5673", ownInk: "163F55", recd: "2F7A4F", phy: "D04A1F",
      warn: "9A520C", bad: "9E0B23", night: "2B1A12", nightInk: "F2E3C6",
      head: "C8102E", headInk: "FFF4E0", headInk2: "FCE6CC", headOk: "FFD98E", headBad: "FFFFFF",
      clock: "FFF4E0", bigClock: "C8102E", edge: "C8102E",
    },
    shape: { cardR: 2, cardBw: 1, edge: 3, btnR: 2, chipR: 2 },
  },
  {
    id: "cool", label: "酷", tagline: "近黑底、青色霓虹钟和按钮，细线窄角，像飞行器的仪表。夜里也不刺眼。",
    colors: {
      console: "06080C", paper: "0F141B", rule: "1F2A36", rule2: "3A4E63", ink: "E6F0F8", ink2: "9AACBC", ink3: "7287A0",
      act: "00E5FF", actPress: "00B8CC", onAct: "00141A", rec: "FF2D55",
      ext: "FFB000", extTint: "2B2208", extInk: "FFC94D", own: "4C8DFF", ownInk: "9CC1FF", recd: "26E6A0", phy: "FF4FD8",
      warn: "FFB000", bad: "FF4D5E", night: "000000", nightInk: "E6F0F8",
      head: "0A0E13", headInk: "E6F0F8", headInk2: "7287A0", headOk: "26E6A0", headBad: "FF4D5E",
      clock: "00E5FF", bigClock: "00E5FF", edge: "00E5FF",
    },
    shape: { cardR: 4, cardBw: 1, edge: 0, btnR: 4, chipR: 2 },
  },
];

export const THEME_IDS = THEMES.map((t) => t.id) as [string, ...string[]];

export function themeOf(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

/** 下发给设备的紧凑格式：v 是格式版本，设备只认它知道的版本 */
export function deviceTheme(id: string) {
  const t = themeOf(id);
  return {
    id: t.id, v: 1,
    c: THEME_ROLES.map((r) => t.colors[r]).join(","),
    s: [t.shape.cardR, t.shape.cardBw, t.shape.edge, t.shape.btnR, t.shape.chipR],
  };
}

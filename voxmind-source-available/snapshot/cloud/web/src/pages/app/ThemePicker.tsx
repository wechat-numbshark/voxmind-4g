import type { CSSProperties } from "react";
import { api } from "../../api.ts";
import { Skeleton, useLoad } from "../../ui/kit.tsx";

/* 设备屏幕主题选择：每套画一个设备首页的缩略图。
 * 配色和形状直接用服务端推给设备的那份定义（/v1/themes），所以预览和真机是同一套颜色；
 * 字体不一样（设备用的是自带字库），只看颜色和形状。*/

export type ThemeId = "classic" | "dopamine" | "papercut" | "cool";
export interface Theme {
  id: ThemeId; label: string; tagline: string;
  colors: Record<string, string>;
  shape: { cardR: number; cardBw: number; edge: number; btnR: number; chipR: number };
}

const S = 0.6;                                   // 设备 240x320 缩到 144x192
const px = (n: number) => `${Math.round(n * S * 10) / 10}px`;

function paper(t: Theme, line: string): CSSProperties {
  const c = (k: string) => `#${t.colors[k]}`;
  const { cardBw, edge } = t.shape;
  /* 和固件 paper_edge() 一样：有垫层时细线走 outline，右下加一道粗边 */
  return edge
    ? { outline: `${Math.max(1, cardBw * S)}px solid ${c(line)}`,
        borderRight: `${px(edge)} solid ${c("edge")}`, borderBottom: `${px(edge)} solid ${c("edge")}` }
    : { border: `${Math.max(1, cardBw * S)}px solid ${c(line)}` };
}

export function ThemePreview({ t }: { t: Theme }) {
  const c = (k: string) => `#${t.colors[k]}`;
  const strip = (y: number): CSSProperties => ({
    position: "absolute", left: px(8), top: px(y), width: px(224), height: px(54), boxSizing: "border-box",
    background: c("paper"), borderRadius: px(t.shape.cardR), ...paper(t, "rule"),
  });
  const slot = (bar: string, chipInk: string, chip: string, title: string, y: number) => (
    <div style={strip(y)}>
      <div style={{ position: "absolute", left: px(2), top: px(4), width: px(5), bottom: px(4), background: c(bar), borderRadius: 2 }} />
      <div style={{ position: "absolute", left: px(16), top: px(6), fontSize: 8, color: c(chipInk), whiteSpace: "nowrap" }}>{chip}</div>
      <div style={{ position: "absolute", left: px(16), top: px(28), fontSize: 10, fontWeight: 600, color: c("ink"), whiteSpace: "nowrap" }}>{title}</div>
      <div style={{ position: "absolute", right: px(10), top: px(6), fontSize: 8, color: c("ink3") }}>09:12</div>
    </div>
  );
  const button = (primary: boolean, text: string, x: number, w: number) => (
    <div style={{ position: "absolute", left: px(x), top: px(264), width: px(w), height: px(44), boxSizing: "border-box",
      borderRadius: px(t.shape.btnR), background: primary ? c("act") : c("paper"),
      ...(t.shape.edge ? paper(t, "rule") : primary ? {} : { border: `${px(2)} solid ${c("rule2")}` }),
      ...(t.shape.edge && primary ? { borderRightColor: c("actPress"), borderBottomColor: c("actPress") } : {}),
      color: primary ? c("onAct") : c("ink2"), fontSize: 12, fontWeight: 600,
      display: "flex", alignItems: "center", justifyContent: "center" }}>{text}</div>
  );
  return (
    <div aria-hidden style={{ width: px(240), height: px(320), position: "relative", overflow: "hidden",
      background: c("console"), borderRadius: 6, boxShadow: "0 0 0 5px #1d1f22", margin: 5, flexShrink: 0 }}>
      <div style={{ position: "absolute", inset: 0, height: px(74), background: c("head") }}>
        <div style={{ position: "absolute", left: px(12), top: px(10), fontSize: 26, fontWeight: 700, lineHeight: 1,
          color: c("clock"), fontVariantNumeric: "tabular-nums", letterSpacing: -0.5 }}>09:41</div>
        <div style={{ position: "absolute", right: px(12), top: px(10), fontSize: 9, color: c("headInk") }}>86%</div>
        <div style={{ position: "absolute", right: px(12), top: px(40), fontSize: 8, color: c("headInk2") }}>周三 10月1日</div>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: px(74), height: 1, background: c("rule") }} />
      <div style={{ position: "absolute", left: px(12), top: px(88), width: px(10), height: px(10), borderRadius: "50%", background: c("rec") }} />
      <div style={{ position: "absolute", left: px(28), top: px(84), fontSize: 9, color: c("ink") }}>录音中
        <span style={{ color: c("ink2"), marginLeft: 6 }}>00:12:34</span></div>
      <div style={{ position: "absolute", right: px(12), top: px(84), display: "flex", gap: 2, alignItems: "center", height: px(18) }}>
        {[5, 11, 7, 14, 9].map((h, i) => <div key={i} style={{ width: px(3), height: px(h), background: c("act"), borderRadius: 1 }} />)}
      </div>
      {slot("own", "ownInk", "个人・飞书任务", "给王总回电话", 122)}
      {slot("recd", "recd", "记录・笔记", "买菜清单", 184)}
      {button(false, "取消", 8, 88)}
      {button(true, "确认", 104, 128)}
    </div>
  );
}

export function ThemePicker({ value, onChange }: { value: ThemeId; onChange: (v: ThemeId) => void }) {
  const themes = useLoad(() => api.get<{ themes: Theme[] }>("/v1/themes").then((r) => r.themes), []);
  if (!themes.data) return <Skeleton h={230} />;
  return (
    <div role="radiogroup" aria-label="屏幕主题" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))", gap: 12 }}>
      {themes.data.map((t) => {
        const on = t.id === value;
        return (
          <button key={t.id} type="button" role="radio" aria-checked={on} onClick={() => onChange(t.id)}
                  style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "12px 8px 10px",
                    borderRadius: 10, cursor: "pointer", textAlign: "center", background: "var(--paper, #fff)",
                    border: on ? "2px solid var(--act, #0A6E64)" : "1px solid var(--rule, #D5DCDA)",
                    boxShadow: on ? "0 0 0 3px color-mix(in srgb, var(--act, #0A6E64) 18%, transparent)" : "none" }}>
            <ThemePreview t={t} />
            <span style={{ fontWeight: 700, fontSize: 15, color: "var(--ink)" }}>{t.label}{on ? "（当前）" : ""}</span>
            <span style={{ fontSize: 12, lineHeight: 1.5, color: "var(--ink-2)" }}>{t.tagline}</span>
          </button>
        );
      })}
    </div>
  );
}

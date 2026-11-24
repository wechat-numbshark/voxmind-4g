import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { api, type Me } from "../../api.ts";
import { LoadError, Skeleton, useLoad, useToast, useWidth } from "../../ui/kit.tsx";
import { PageHead } from "../../ui/Shell.tsx";

interface Row { day: string; userId: string; kind: "asr" | "llm"; model: string; tier: "high" | "economy";
  calls: number; audioMs: number; inputTokens: number; outputTokens: number; costYuan: number }
interface ModelPrice { label: string; perSecond?: number; inputPerM?: number; outputPerM?: number; source: string; verified: boolean }
interface PriceBook { serverMonthly: number; models: Record<string, ModelPrice> }
interface CostData {
  rows: Row[]; users: { id: string; displayName: string }[]; prices: PriceBook;
  month: { usageYuan: number; serverYuan: number; projectedYuan: number; elapsedDays: number; daysInMonth: number };
}

/* 图表两色取自经校验的分类色板前两位（蓝、橙），白底上色盲可分、对比度 ≥3:1。
 * 它们只属于这张图，和卡槽的风险色不是一回事。*/
const SERIES = [
  { kind: "asr" as const, label: "语音识别", color: "#2a78d6" },
  { kind: "llm" as const, label: "意图模型", color: "#eb6834" },
];

const yuan = (n: number) => n === 0 ? "¥0" : n >= 100 ? `¥${n.toFixed(0)}` : n >= 1 ? `¥${n.toFixed(2)}` : `¥${n.toFixed(4)}`;


const hoursOf = (ms: number) => ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} 小时` : `${Math.round(ms / 60_000)} 分钟`;

function lastDays(n: number) {
  const out: string[] = [];
  const bj = Date.now() + 8 * 3600_000;
  for (let i = n - 1; i >= 0; i--) out.push(new Date(bj - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

export function Costs({ me, path }: { me: Me; path: string }) {
  const data = useLoad(() => api.get<CostData>("/v1/admin/costs?days=30"), [], 60_000);
  const d = data.data;
  const unverified = d ? Object.values(d.prices.models).filter((m) => !m.verified) : [];

  return (
    <>
      <PageHead title="成本" me={me} path={path} />
      <div className="work-body">
        {data.error && !d && <LoadError error={data.error} onRetry={() => void data.reload()} />}
        {unverified.length > 0 && (
          <div className="notice" role="note">
            <AlertTriangle aria-hidden />
            <div>{unverified.map((m) => m.label).join("、")} 的单价没有从官方核实过。去百炼控制台「费用中心」对一下实际账单，在下面「单价」里改掉，之后的记账就准了。</div>
          </div>
        )}
        <div className="split even">
          <section className="sheet" aria-labelledby="month-title">
            <div className="sheet-head"><h2 id="month-title">本月</h2></div>
            <div className="sheet-body">
              {!d ? <Skeleton h={110} /> : (
                <dl className="readout" style={{ margin: 0 }}>
                  <div><dt>已发生的调用费用</dt><dd>{yuan(d.month.usageYuan)}</dd></div>
                  <div><dt>服务器月费（按已过天数摊）</dt><dd>{yuan(d.month.serverYuan)}</dd></div>
                  <div><dt>按目前日均，月底预计</dt><dd style={{ fontWeight: 600 }}>{yuan(d.month.projectedYuan)}</dd></div>
                  <div><dt>本月已过</dt><dd className="txt">{d.month.elapsedDays.toFixed(1)} / {d.month.daysInMonth} 天</dd></div>
                </dl>
              )}
            </div>
          </section>
          <ByUser data={d} />
        </div>
        <DailyChart data={d} />
        {d && <PriceEditor book={d.prices} onSaved={() => void data.reload()} />}
      </div>
    </>
  );
}

/* ── 每日堆叠柱：识别在下、模型在上，段间 2px 白缝，柱宽 ≤24px ── */
function DailyChart({ data }: { data: CostData | null }) {
  const [showTable, setShowTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [boxRef, W] = useWidth();
  const days = useMemo(() => lastDays(30), []);
  const series = useMemo(() => {
    const byDay = new Map(days.map((day) => [day, { asr: 0, llm: 0 }]));
    for (const r of data?.rows ?? []) { const b = byDay.get(r.day); if (b) b[r.kind] += r.costYuan; }
    return days.map((day) => ({ day, ...byDay.get(day)! }));
  }, [data, days]);
  const max = Math.max(...series.map((s) => s.asr + s.llm), 0);
  // 刻度取整：0 和一个"好看"的上限
  const top = max <= 0 ? 1 : (() => { const p = 10 ** Math.floor(Math.log10(max)); const m = max / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; })();
  const H = 220, left = 56, bottom = 22, plotW = W - left - 8, plotH = H - bottom - 8;
  const labelEvery = W < 500 ? 10 : 5;   // 窄屏日期标签隔得开一点，免得挤在一起
  const slot = plotW / days.length, bar = Math.min(24, slot - 6);
  const y = (v: number) => (v / top) * plotH;
  const hv = hover === null ? null : series[hover]!;

  return (
    <section className="sheet" aria-labelledby="daily-title">
      <div className="sheet-head">
        <h2 id="daily-title">每日成本 · 近 30 天</h2>
        <div className="end">
          <div className="legend" style={{ display: "flex", gap: 14, fontSize: 13, fontWeight: 500, color: "var(--ink-2)" }}>
            {SERIES.map((s) => <span key={s.kind}><i style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: s.color, marginRight: 5, verticalAlign: -1 }} />{s.label}</span>)}
          </div>
          <button className="btn sm" onClick={() => setShowTable((v) => !v)}>{showTable ? "看图" : "看表格"}</button>
        </div>
      </div>
      <div className="sheet-body">
        {!data ? <Skeleton h={H} /> : showTable ? (
          <div className="table-scroll">
            <table className="ledger">
              <thead><tr><th>日期</th><th className="right">语音识别</th><th className="right">意图模型</th><th className="right">合计</th></tr></thead>
              <tbody>{[...series].reverse().map((s) => (
                <tr key={s.day}><td className="time">{s.day}</td><td className="right mono">{yuan(s.asr)}</td>
                  <td className="right mono">{yuan(s.llm)}</td><td className="right mono">{yuan(s.asr + s.llm)}</td></tr>))}</tbody>
            </table>
          </div>
        ) : (
          <div style={{ position: "relative" }} ref={boxRef}>
            <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`近 30 天每日成本，最高一天 ${yuan(max)}`}
                 onPointerLeave={() => setHover(null)} style={{ display: "block", overflow: "visible" }}>
              {[0, 0.5, 1].map((f) => (
                <g key={f}>
                  <line x1={left} x2={W - 8} y1={8 + plotH - f * plotH} y2={8 + plotH - f * plotH} stroke="#E4E9E8" strokeWidth="1" />
                  <text x={left - 8} y={8 + plotH - f * plotH + 4} textAnchor="end" fontSize="12" fill="var(--ink-2)" fontFamily="var(--mono)">{yuan(top * f)}</text>
                </g>
              ))}
              {series.map((s, i) => {
                const x = left + i * slot + (slot - bar) / 2;
                const hA = y(s.asr), hL = y(s.llm), base = 8 + plotH;
                const gap = hA > 0 && hL > 0 ? 2 : 0;
                return (
                  <g key={s.day} opacity={hover === null || hover === i ? 1 : 0.55}>
                    {hA > 0 && <path d={roundedTop(x, base - hA, bar, hA, hL > 0 ? 0 : 4)} fill={SERIES[0]!.color} />}
                    {hL > 0 && <path d={roundedTop(x, base - hA - gap - hL, bar, hL, 4)} fill={SERIES[1]!.color} />}
                    {/* 命中区比柱子宽，整列都能悬停 */}
                    <rect x={left + i * slot} y={8} width={slot} height={plotH} fill="transparent" tabIndex={0}
                          aria-label={`${s.day} 识别 ${yuan(s.asr)} 模型 ${yuan(s.llm)}`}
                          onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
                    {(i % labelEvery === labelEvery - 1 || i === series.length - 1) && (
                      <text x={left + i * slot + slot / 2} y={H - 4} textAnchor="middle" fontSize="12" fill="var(--ink-2)" fontFamily="var(--mono)">{s.day.slice(5)}</text>
                    )}
                  </g>
                );
              })}
            </svg>
            {hv && hover !== null && (
              <div role="status" style={{ position: "absolute", top: 0, left: `${Math.min(78, Math.max(4, ((left + hover * slot) / W) * 100))}%`,
                background: "var(--paper)", border: "1px solid var(--rule-strong)", borderRadius: 6, padding: "8px 10px",
                boxShadow: "0 4px 14px -6px rgba(18,32,42,.3)", pointerEvents: "none", fontSize: 13, minWidth: 150 }}>
                <div className="mono ink-2" style={{ marginBottom: 4 }}>{hv.day}</div>
                {SERIES.map((s) => (
                  <div key={s.kind} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 12, height: 2, background: s.color }} />
                    <b className="mono" style={{ fontWeight: 600 }}>{yuan(hv[s.kind])}</b><span className="ink-2">{s.label}</span>
                  </div>
                ))}
              </div>
            )}
            {max === 0 && <p className="ink-2" style={{ fontSize: 14, marginTop: 8 }}>还没有记账数据。新版转写上线后，每一次识别和意图判断都会记在这里。</p>}
          </div>
        )}
      </div>
    </section>
  );
}

/** 顶部两角圆 4px、底部方角的柱段 */
function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

function ByUser({ data }: { data: CostData | null }) {
  const rows = useMemo(() => {
    const m = new Map<string, { name: string; tiers: Set<string>; audioMs: number; llmCalls: number; tokens: number; cost: number }>();
    for (const r of data?.rows ?? []) {
      const u = m.get(r.userId) ?? { name: data!.users.find((x) => x.id === r.userId)?.displayName ?? r.userId, tiers: new Set(), audioMs: 0, llmCalls: 0, tokens: 0, cost: 0 };
      u.tiers.add(r.tier); u.cost += r.costYuan;
      if (r.kind === "asr") u.audioMs += r.audioMs; else { u.llmCalls += r.calls; u.tokens += r.inputTokens + r.outputTokens; }
      m.set(r.userId, u);
    }
    return [...m.values()].sort((a, b) => b.cost - a.cost);
  }, [data]);
  return (
    <section className="sheet" aria-labelledby="byuser-title">
      <div className="sheet-head"><h2 id="byuser-title">按用户 · 近 30 天</h2></div>
      {!data ? <div className="sheet-body"><Skeleton h={110} /></div> : rows.length === 0 ? (
        <div className="empty"><b>还没有用量</b>用户开始录音后，这里按人列出识别时长、模型调用和花费。</div>
      ) : (
        <div className="table-scroll">
          <table className="ledger stack">
            <thead><tr><th>用户</th><th>档位</th><th className="right">识别时长</th><th className="right">模型调用</th><th className="right">成本</th></tr></thead>
            <tbody>{rows.map((u) => (
              <tr key={u.name}>
                <td className="span" style={{ fontWeight: 600 }}>{u.name}</td>
                <td>{[...u.tiers].map((t) => t === "high" ? "高质量" : "经济").join(" / ")}</td>
                <td className="right mono">{hoursOf(u.audioMs)}</td>
                <td className="right mono hide-sm">{u.llmCalls} 次</td>
                <td className="right mono" style={{ fontWeight: 600 }}>{yuan(u.cost)}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PriceEditor({ book, onSaved }: { book: PriceBook; onSaved: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState(book);
  const [busy, setBusy] = useState(false);
  const setModel = (key: string, patch: Partial<ModelPrice>) =>
    setDraft((b) => ({ ...b, models: { ...b.models, [key]: { ...b.models[key]!, ...patch } } }));
  const num = (v: string) => Number(v) || 0;
  // 哪一类模型按原始单价表判断，免得清空输入框时整行变成另一类
  const isAsr = (key: string) => book.models[key]?.perSecond !== undefined;

  async function save() {
    setBusy(true);
    try { await api.put("/v1/admin/prices", draft); toast("单价已保存，之后的记账按新单价算"); onSaved(); }
    catch (e) { toast(e instanceof Error ? e.message : "保存失败", true); }
    finally { setBusy(false); }
  }

  return (
    <section className="sheet" aria-labelledby="price-title">
      <div className="sheet-head">
        <h2 id="price-title">单价</h2>
        <div className="end"><button className="btn go" onClick={() => void save()} disabled={busy}>{busy ? "保存中" : "保存单价"}</button></div>
      </div>
      <div className="sheet-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="ink-2" style={{ fontSize: 14, fontWeight: 500, maxWidth: "70ch" }}>
          每次调用按当时的单价记账，改单价只影响以后，不改历史。服务器月费按设备数和天数摊进成本。
        </p>
        <div className="field" style={{ maxWidth: 240 }}>
          <label htmlFor="srv">服务器月费（元）</label>
          <input id="srv" type="text" inputMode="decimal" value={draft.serverMonthly}
                 onChange={(e) => setDraft({ ...draft, serverMonthly: Number(e.target.value) || 0 })} />
        </div>
        <div className="table-scroll">
          <table className="ledger">
            <thead><tr><th>模型</th><th className="right">元/秒音频</th><th className="right">输入 元/百万</th><th className="right">输出 元/百万</th><th>来源</th><th>已核实</th></tr></thead>
            <tbody>{Object.entries(draft.models).map(([key, m]) => (
              <tr key={key}>
                <td><b style={{ fontWeight: 600 }}>{m.label}</b><div className="mono ink-2" style={{ fontSize: 12 }}>{key}</div></td>
                {(["perSecond", "inputPerM", "outputPerM"] as const).map((f) => (
                  <td key={f} className="right">
                    {(f === "perSecond") === isAsr(key) ? (
                      <input type="text" inputMode="decimal" aria-label={`${m.label} ${f}`} value={m[f] ?? ""} style={{ width: 96, textAlign: "right", minHeight: 30 }}
                             onChange={(e) => setModel(key, { [f]: num(e.target.value) })} />
                    ) : <span className="ink-3">–</span>}
                  </td>
                ))}
                <td className="ink-2" style={{ fontSize: 13 }}>{m.source}</td>
                <td><input type="checkbox" checked={m.verified} aria-label={`${m.label} 已核实`} onChange={(e) => setModel(key, { verified: e.target.checked })} /></td>
              </tr>))}</tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

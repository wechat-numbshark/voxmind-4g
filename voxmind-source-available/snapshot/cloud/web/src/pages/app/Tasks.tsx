import { useEffect, useState } from "react";
import { api } from "../../api.ts";
import type { Me } from "../../api.ts";
import { dayKey, dayLabel, hhmm, TOOL_LABEL, toolLabel } from "../../format.ts";
import { LoadError, Pager, Skeleton, useLoad, usePaged, useToast } from "../../ui/kit.tsx";
import { PageHead } from "../../ui/Shell.tsx";
import { DoneStrip, Strip, type StripDraft } from "../../ui/Strip.tsx";
import { SuggestionRow, type Suggestion } from "../../ui/Suggestions.tsx";

/* 任务中心：所有动作，不只今天。
 * 「今天」页管的是当下要你拍板的事；这里管的是查旧账——上周那条飞书任务建成什么样了、
 * 哪些失败了、某个人的名字出现在哪几条里。按状态、类型、时间筛，点开看详情。*/

const STATUS_TABS = [
  { value: "", label: "全部" },
  { value: "pending", label: "等我确认" },
  { value: "executed", label: "已执行" },
  { value: "failed", label: "执行失败" },
  { value: "cancelled", label: "已退回" },
  { value: "expired", label: "已作废" },
] as const;

const MODES = [{ value: "drafts", label: "已建的" }, { value: "suggestions", label: "建议" }] as const;
const RANGES = [{ days: 0, label: "全部时间" }, { days: 1, label: "今天" }, { days: 7, label: "近 7 天" }, { days: 30, label: "近 30 天" }];
const PAGE = 20;

export function Tasks({ me, path }: { me: Me; path: string }) {
  const [mode, setMode] = useState<"drafts" | "suggestions">("drafts");
  const [status, setStatus] = useState("");
  const [tool, setTool] = useState("");
  const [days, setDays] = useState(0);
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");          // 真正提交去搜的词，不跟着每次按键变
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [status, tool, days, term]);

  const list = useLoad(async () => {
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE) });
    if (status) params.set("status", status);
    if (tool) params.set("tool", tool);
    if (days) params.set("days", String(days));
    if (term) params.set("q", term);
    return api.get<{ drafts: StripDraft[]; total: number }>(`/v1/action-drafts?${params}`);
  }, [status, tool, days, term, page], 30000);

  const drafts = list.data?.drafts ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  // 同一天的排在一起，方便按天回看
  const byDay = new Map<string, StripDraft[]>();
  for (const d of drafts) byDay.set(dayLabel(d.createdAt), [...(byDay.get(dayLabel(d.createdAt)) ?? []), d]);

  return (
    <>
      <PageHead title="任务中心" me={me} path={path}>
        {mode === "drafts" && <span className="ink-2" style={{ fontSize: 13 }}>共 {total} 条</span>}
      </PageHead>
      <div className="work-body">
        <div className="seg" role="group" aria-label="看什么" style={{ alignSelf: "flex-start" }}>
          {MODES.map((m) => <button key={m.value} aria-pressed={mode === m.value} onClick={() => setMode(m.value)}>{m.label}</button>)}
        </div>
        {mode === "suggestions" && <SuggestionList />}
        {mode === "drafts" && <>
        <div className="sheet" style={{ padding: 12, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <div className="seg" role="group" aria-label="状态">
            {STATUS_TABS.map((t) => (
              <button key={t.value} aria-pressed={status === t.value} onClick={() => setStatus(t.value)}>{t.label}</button>
            ))}
          </div>
          <select value={tool} onChange={(e) => setTool(e.target.value)} aria-label="动作类型" style={{ width: "auto" }}>
            <option value="">所有类型</option>
            {Object.keys(TOOL_LABEL).map((t) => <option key={t} value={t}>{toolLabel(t)}</option>)}
          </select>
          <div className="seg" role="group" aria-label="时间范围">
            {RANGES.map((r) => <button key={r.days} aria-pressed={days === r.days} onClick={() => setDays(r.days)}>{r.label}</button>)}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); setTerm(q); }} style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜标题、说明、原话"
                   aria-label="搜索任务" style={{ maxWidth: 220 }} />
            <button className="btn sm" type="submit">搜索</button>
          </form>
        </div>

        {list.error && !list.data && <LoadError error={list.error} onRetry={() => void list.reload()} />}
        {!list.data && !list.error && <div style={{ display: "grid", gap: 10 }}>{[0, 1, 2].map((i) => <Skeleton key={i} h={80} />)}</div>}
        {list.data && total === 0 && (
          <div className="sheet empty"><b>没有符合条件的任务</b>换个状态或时间范围看看。设备听到需要拍板的事，会先出现在「今天」。</div>
        )}

        {[...byDay].map(([day, items]) => (
          <section key={day} className="bay" aria-label={day}>
            <div className="bay-head"><h2>{day} <span className="ink-3" style={{ fontWeight: 400 }}>{items.length} 条</span></h2></div>
            <div className="bay-stack">
              {items.map((d) => d.status === "pending"
                ? <Strip key={d.id} draft={d} onSettled={() => void list.reload()} />
                : <DoneStrip key={d.id} draft={d} />)}
            </div>
          </section>
        ))}

        <Pager page={page} pages={pages} onPage={setPage} />
        </>}
      </div>
    </>
  );
}

/* 建议：看出来了但没建的。忽略过的也留着能翻——万一当时忽略错了。
 * 攒多了要能一把清掉：勾几条一起忽略，或者整天忽略（今天漏看的那些也一样） */
const SUG_PAGE = 20;
function SuggestionList() {
  const toast = useToast();
  const [status, setStatus] = useState<"open" | "accepted" | "dismissed">("open");
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const list = useLoad(() => api.get<{ suggestions: Suggestion[] }>(`/v1/suggestions?status=${status}&limit=200`).then((r) => r.suggestions), [status], 60_000);
  const items = (list.data ?? []).filter((s) => !gone.has(s.id));
  const paged = usePaged(items, SUG_PAGE, status);
  const byDay = new Map<string, Suggestion[]>();
  for (const s of paged.slice) byDay.set(dayKey(s.createdAt), [...(byDay.get(dayKey(s.createdAt)) ?? []), s]);
  const allOnPage = paged.slice.length > 0 && paged.slice.every((s) => picked.has(s.id));

  function pick(id: string, on: boolean) {
    const next = new Set(picked);
    if (on) next.add(id); else next.delete(id);
    setPicked(next);
  }
  async function dismiss(payload: { ids: string[] } | { day: string }, label: string) {
    setBusy(true);
    try {
      const r = await api.post<{ dismissed: number }>("/v1/suggestions/dismiss", payload);
      toast(`已忽略 ${r.dismissed} 条${label}`);
      setPicked(new Set());
      if ("ids" in payload) setGone(new Set([...gone, ...payload.ids]));
      else setGone(new Set([...gone, ...items.filter((s) => dayKey(s.createdAt) === payload.day).map((s) => s.id)]));
      void list.reload();
    } catch (e) { toast(e instanceof Error ? e.message : "忽略失败", true); }
    finally { setBusy(false); }
  }

  return (
    <section className="sheet" aria-label="建议">
      <div className="sheet-head">
        <h2>说过但没让我办的事 {status === "open" && items.length > 0 && <span className="ink-3" style={{ fontWeight: 400 }}>{items.length} 条</span>}</h2>
        <div className="end">
          <div className="seg" role="group" aria-label="建议状态">
            {([["open", "等你决定"], ["accepted", "已采纳"], ["dismissed", "已忽略"]] as const).map(([v, label]) => (
              <button key={v} aria-pressed={status === v} onClick={() => { setStatus(v); setPicked(new Set()); }}>{label}</button>
            ))}
          </div>
        </div>
      </div>
      {status === "open" && items.length > 0 && (
        <div className="sheet-body" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", paddingBottom: 0 }}>
          <label className="switch-inline">
            <input type="checkbox" checked={allOnPage} onChange={(e) => {
              const next = new Set(picked);
              for (const s of paged.slice) { if (e.target.checked) next.add(s.id); else next.delete(s.id); }
              setPicked(next);
            }} />
            全选这一页
          </label>
          <button className="btn sm" disabled={busy || picked.size === 0}
                  onClick={() => void dismiss({ ids: [...picked] }, "")}>忽略选中的 {picked.size || ""}</button>
        </div>
      )}
      {list.error && !list.data && <div className="sheet-body"><LoadError error={list.error} onRetry={() => void list.reload()} /></div>}
      {!list.data && !list.error && <div className="sheet-body" style={{ display: "grid", gap: 10 }}>{[0, 1].map((i) => <Skeleton key={i} h={40} />)}</div>}
      {list.data && items.length === 0 && (
        <div className="empty">
          <b>{status === "open" ? "没有漏网的事" : "这里是空的"}</b>
          拆主题时会顺手扫一遍没按键说过的话，像是要办的事、要记的账会出现在这里，点一下才真的建。
          在「我的 → AI 助手」里可以关掉。
        </div>
      )}
      {[...byDay].map(([day, group]) => {
        const dayTotal = items.filter((s) => dayKey(s.createdAt) === day).length;
        return (
          <div key={day}>
            <div className="log-group" style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {dayLabel(group[0]!.createdAt)} <span className="ink-3" style={{ fontWeight: 400 }}>{dayTotal} 条</span>
              {status === "open" && (
                <button className="btn sm flat" style={{ marginLeft: "auto" }} disabled={busy}
                        onClick={() => { if (confirm(`把${dayLabel(group[0]!.createdAt)}的 ${dayTotal} 条建议都忽略？忽略的还能在「已忽略」里看到。`)) void dismiss({ day }, `（${dayLabel(group[0]!.createdAt)}）`); }}>
                  忽略这一天
                </button>
              )}
            </div>
            <ol className="log">
              {group.map((s) => status === "open"
                ? <SuggestionRow key={s.id} s={s} showTime selected={picked.has(s.id)} onSelect={(v) => pick(s.id, v)}
                                 onSettled={(id) => setGone(new Set([...gone, id]))} />
                : (
                  <li key={s.id} style={{ gridTemplateColumns: "58px minmax(0,1fr) auto" }}>
                    <time>{hhmm(s.createdAt)}</time>
                    <div><b style={{ fontWeight: 600 }}>{s.title}</b>{s.evidence && <div className="ink-3" style={{ fontSize: 13 }}><q>{s.evidence}</q></div>}</div>
                    <span className="ink-3" style={{ fontSize: 13 }}>{status === "accepted" ? "已建" : "已忽略"}</span>
                  </li>
                ))}
            </ol>
          </div>
        );
      })}
      <Pager page={paged.page} pages={paged.pages} onPage={paged.setPage} />
    </section>
  );
}

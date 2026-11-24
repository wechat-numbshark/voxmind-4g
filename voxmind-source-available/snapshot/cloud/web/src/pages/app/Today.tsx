import { useMemo, useRef, useState } from "react";
import { CheckCircle2, Eraser, Play, Square } from "lucide-react";
import { api, type Me, type Session, type Timeline } from "../../api.ts";
import { dayKey, hhmm, TIER_LABEL } from "../../format.ts";
import { navigate } from "../../router.ts";
import { LoadError, Pager, playRun, RecLight, Skeleton, useLoad, usePaged, useToast } from "../../ui/kit.tsx";
import { Markdown } from "../../ui/Markdown.tsx";
import { SuggestionRow, type Suggestion } from "../../ui/Suggestions.tsx";
import { PageHead } from "../../ui/Shell.tsx";
import { DoneStrip, Strip, type StripDraft } from "../../ui/Strip.tsx";

const CLEARED = "voxmind:settled-cleared";

/** 最急的在最上面：有倒计时的按剩余时间排，不会作废的按到达先后排在后面 */
function byUrgency(a: StripDraft, b: StripDraft) {
  const ea = a.expiresAt ?? Infinity, eb = b.expiresAt ?? Infinity;
  return ea !== eb ? ea - eb : a.createdAt.localeCompare(b.createdAt);
}

export function Today({ me, path, onPendingChange }: { me: Me; path: string; onPendingChange: (n: number) => void }) {
  // 首次加载的单子本来就在架上；之后轮询带来的新单子才从左边推进来
  const seen = useRef<Set<string> | null>(null);
  const [arriving, setArriving] = useState<Set<string>>(new Set());
  const pending = useLoad(async () => {
    const { drafts } = await api.get<{ drafts: StripDraft[] }>("/v1/action-drafts?status=pending");
    const sorted = [...drafts].sort(byUrgency);
    onPendingChange(sorted.length);
    if (seen.current) {
      const fresh = sorted.filter((d) => !seen.current!.has(d.id)).map((d) => d.id);
      if (fresh.length) setArriving(new Set(fresh));
    }
    seen.current = new Set(sorted.map((d) => d.id));
    return sorted;
  }, [], 5000);

  // 「只看今天」只影响这一屏的显示；早于今天还没处理的单子仍然在，切回"全部"就看得到
  const [todayOnly, setTodayOnly] = useState(false);
  /* 清空已处理：只是把这一屏收起来（记上一个时间点，比它早的不再显示）。
   * 不删服务端记录——「记录」页里还能查到，审计不能被一键抹掉。*/
  const [clearedAt, setClearedAt] = useState(() => localStorage.getItem(CLEARED) ?? "");

  const settled = useLoad(async () => {
    const { drafts } = await api.get<{ drafts: StripDraft[] }>("/v1/action-drafts");
    const today = dayKey(Date.now());
    return drafts.filter((d) => d.status !== "pending" && dayKey(d.updatedAt) === today)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 40);
  }, [], 15000);

  function removeSettled(id: string) {
    pending.setData((list) => {
      const next = (list ?? []).filter((d) => d.id !== id);
      onPendingChange(next.length);
      return next;
    });
    void settled.reload();
  }

  const today = dayKey(Date.now());
  const list = todayOnly ? pending.data?.filter((d) => dayKey(d.createdAt) === today) : pending.data;
  const hiddenPending = (pending.data?.length ?? 0) - (list?.length ?? 0);
  const done = (settled.data ?? []).filter((d) => d.updatedAt > clearedAt);
  /* 待签放、已处理都按页翻，每页 10 张——以前一直往下叠，攒多了要滚很久 */
  const pendingPage = usePaged(list, 10, todayOnly);
  const donePage = usePaged(done, 10, clearedAt);
  const tiers = useMemo(() => {
    const count = { ext: 0, own: 0, rec: 0, phy: 0 };
    for (const d of list ?? []) {
      const t = d.risk === "external_write" || d.risk === "destructive" ? "ext"
        : d.risk === "physical_control" ? "phy" : d.risk === "record" ? "rec" : "own";
      count[t]++;
    }
    return count;
  }, [list]);

  return (
    <>
      <PageHead title="今天" me={me} path={path} />
      <div className="work-body">
        <TodayStats />
        <div className="split">
          <section aria-labelledby="bay-title" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div className="bay">
              <div className="bay-head">
                <h2 id="bay-title">待签放 <span className="mono">{list ? list.length : "–"}</span></h2>
                <button className="btn sm" aria-pressed={todayOnly} onClick={() => setTodayOnly(!todayOnly)}
                        title={todayOnly ? "改为显示全部待签放" : "只显示今天生成的"}>
                  {todayOnly ? `只看今天${hiddenPending > 0 ? `（另有 ${hiddenPending} 张）` : ""}` : "只看今天"}
                </button>
                <div className="legend" aria-label="卡槽颜色">
                  {(["ext", "own", "phy", "rec"] as const).map((t) => (
                    <span key={t}><i style={{ background: `var(--tier-${t})` }} />{TIER_LABEL[t]} {tiers[t]}</span>
                  ))}
                </div>
              </div>
              {pending.error && !list && <LoadError error={pending.error} onRetry={() => void pending.reload()} />}
              {!list && !pending.error && (
                <div className="bay-stack">{[0, 1].map((i) => <Skeleton key={i} h={80} />)}</div>
              )}
              {list && list.length === 0 && (
                <div className="empty-bay">
                  <CheckCircle2 aria-hidden />
                  <p><b>架子是空的</b>设备听到需要你拍板的事，会在这里插一张单子，同时出现在设备屏上。</p>
                </div>
              )}
              {list && list.length > 0 && (
                <>
                  <div className="bay-stack">
                    {pendingPage.slice.map((d) => <Strip key={d.id} draft={d} onSettled={removeSettled} arriving={arriving.has(d.id)} />)}
                  </div>
                  <Pager page={pendingPage.page} pages={pendingPage.pages} onPage={pendingPage.setPage} />
                </>
              )}
            </div>

            {done.length > 0 && (
              <section aria-labelledby="done-title">
                <div className="bay">
                  <div className="bay-head">
                    <h2 id="done-title">今天已处理 <span className="mono">{done.length}</span></h2>
                    <div className="end">
                      <button className="btn sm" onClick={() => {
                        const at = new Date().toISOString();
                        localStorage.setItem(CLEARED, at);
                        setClearedAt(at);
                      }}><Eraser aria-hidden />清空</button>
                    </div>
                  </div>
                  <div className="bay-stack">
                    {donePage.slice.map((d) => <DoneStrip key={d.id} draft={d} />)}
                  </div>
                  <Pager page={donePage.page} pages={donePage.pages} onPage={donePage.setPage} />
                  <p className="hint" style={{ padding: "8px 2px 0" }}>点单子看详情。清空只是收起这一屏，记录在「记录」页里还查得到。</p>
                </div>
              </section>
            )}
          </section>

          <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
            <MissedToday />
            <DailySummary />
            <TodayLog />
          </div>
        </div>
      </div>
    </>
  );
}

/* ── 右侧：今天录到的话 ─────────────────────────────────────── */

interface Line { key: string; sessionId: string; sequence: number; endSequence: number | null; at: number; text: string; failed: boolean }

function TodayLog() {
  const [playing, setPlaying] = useState<{ key: string; stop: () => void } | null>(null);
  const log = useLoad(async () => {
    const { sessions } = await api.get<{ sessions: Session[] }>("/v1/sessions?limit=20");
    const today = dayKey(Date.now());
    // 一次开机一个会话；持续录音一天通常只有几个，取今天最近的三个就够覆盖
    const recent = sessions.filter((s) => dayKey(s.startedAt) === today || s.status === "recording").slice(0, 3);
    const timelines = await Promise.all(recent.map((s) =>
      api.get<{ timeline: Timeline }>(`/v1/sessions/${s.id}/timeline`).then((r) => r.timeline)));
    const lines: Line[] = [];
    let lastUpload: string | null = null;
    let chunks = 0;
    for (const t of timelines) {
      const started = Date.parse(t.session.startedAt);
      chunks += t.chunks.length;
      for (const c of t.chunks) if (!lastUpload || c.uploadedAt > lastUpload) lastUpload = c.uploadedAt;
      for (const seg of t.transcripts) {
        // 静音、语气词、并进前句的块都不占行
        if (seg.status === "succeeded" && (seg.kind !== "speech" || !seg.text.trim())) continue;
        lines.push({ key: `${seg.sessionId}:${seg.sequence}`, sessionId: seg.sessionId, sequence: seg.sequence, endSequence: seg.endSequence,
          at: started + seg.startMs, text: seg.text, failed: seg.status === "failed" });
      }
    }
    lines.sort((a, b) => b.at - a.at);
    return { lines: lines.slice(0, 60), lastUpload, chunks };
  }, [], 20000);

  function toggle(line: Line) {
    if (playing?.key === line.key) { playing.stop(); setPlaying(null); return; }
    playing?.stop();
    setPlaying({ key: line.key, ...playRun(line.sessionId, line.sequence, line.endSequence ?? line.sequence, () => setPlaying(null)) });
  }

  return (
    <aside className="sheet" aria-labelledby="log-title">
      <div className="sheet-head">
        <h2 id="log-title">今天录到的话</h2>
        <div className="end"><RecLight lastUploadAt={log.data?.lastUpload} /></div>
      </div>
      {log.error && !log.data && <div className="sheet-body"><LoadError error={log.error} onRetry={() => void log.reload()} /></div>}
      {!log.data && !log.error && (
        <div className="sheet-body" style={{ display: "grid", gap: 10 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} />)}</div>
      )}
      {log.data && log.data.lines.length === 0 && (
        <div className="empty">
          <b>今天还没有转写</b>
          {log.data.chunks > 0 ? `已上云 ${log.data.chunks} 段录音，转写跟上后会出现在这里。` : "设备开机后，说的话大约半分钟内出现在这里。"}
        </div>
      )}
      {log.data && log.data.lines.length > 0 && (
        <>
          <ol className="log">
            {log.data.lines.map((line) => (
              <li key={line.key}>
                <time>{hhmm(line.at)}</time>
                <span className={line.failed ? "failed" : ""}>{line.failed ? "这一段转写失败，稍后会重试" : line.text}</span>
                <button className="btn sm icon flat" onClick={() => toggle(line)}
                        aria-label={playing?.key === line.key ? "停止" : `播放 ${hhmm(line.at)} 的录音`}>
                  {playing?.key === line.key ? <Square aria-hidden /> : <Play aria-hidden />}
                </button>
              </li>
            ))}
          </ol>
          <div style={{ padding: "10px 18px", borderTop: "1px solid var(--rule)" }}>
            <button className="btn sm flat" onClick={() => navigate("/app/recordings")} style={{ paddingLeft: 0 }}>查看全部录音</button>
          </div>
        </>
      )}
    </aside>
  );
}

/* ── 顶上一条：今天录了多久、说了几句、办了几件、花了多少。和设备屏同一个数据源 ── */
interface TodayNumbers { recordedSec: number; sentences: number; done: number; failed: number; pending: number; costYuan: number }

function TodayStats() {
  const stats = useLoad(() => api.get<TodayNumbers>("/v1/today"), [], 60_000);
  const s = stats.data;
  if (!s) return null;
  const h = Math.floor(s.recordedSec / 3600), m = Math.floor(s.recordedSec / 60) % 60;
  const items: [string, string, (string | undefined)?][] = [
    [h ? `${h}时${m}分` : `${m} 分钟`, "录了"],
    [String(s.sentences), "句话"],
    [String(s.done), "件事办完", s.failed ? `另有 ${s.failed} 件失败` : undefined],
    [s.costYuan === 0 ? "¥0" : `¥${s.costYuan.toFixed(s.costYuan < 1 ? 3 : 2)}`, "今天花费"],
  ];
  return (
    <div className="stat-row" role="group" aria-label="今天的统计">
      {items.map(([value, label, note]) => (
        <div key={label} className="stat">
          <b>{value}</b><span>{label}{note && <em> · {note}</em>}</span>
        </div>
      ))}
    </div>
  );
}

/* ── 今日小结：打开了自动写的，晚上 21:30 以后出现；也可以随时手动写一份 ── */
interface DailyData { day: string; output: { content: string; createdAt: string } | null; auto: boolean; aiReady: boolean }

function DailySummary() {
  const toast = useToast();
  const daily = useLoad(() => api.get<DailyData>("/v1/daily"), [], 5 * 60_000);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);
  const d = daily.data;
  if (!d || (!d.output && !d.aiReady)) return null;

  async function generate() {
    setBusy(true);
    try { await api.post("/v1/daily", {}); await daily.reload(); toast("今日小结已生成"); }
    catch (e) { toast(e instanceof Error ? e.message : "生成失败", true); }
    finally { setBusy(false); }
  }

  return (
    <section className="sheet" aria-labelledby="daily-title">
      <div className="sheet-head">
        <h2 id="daily-title">今日小结</h2>
        <div className="end">
          {d.output && <span className="ink-3" style={{ fontSize: 13 }}>{hhmm(d.output.createdAt)} 写的</span>}
          {d.output && <button className="btn sm flat" onClick={() => setOpen(!open)}>{open ? "收起" : "展开"}</button>}
          {d.aiReady && <button className="btn sm" disabled={busy} onClick={() => void generate()}>{busy ? "正在写（约半分钟）" : d.output ? "重写" : "现在写一份"}</button>}
        </div>
      </div>
      {d.output && open && <div className="sheet-body"><Markdown text={d.output.content} /></div>}
      {!d.output && (
        <div className="sheet-body ink-2" style={{ fontSize: 14 }}>
          {d.auto ? "今晚 21:30 以后自动写：见了谁、定了什么、还有什么没做。" : "把今天的主题和待办汇成一页。想每晚自动写，到「我的 → AI」里打开。"}
        </div>
      )}
    </section>
  );
}

/* ── 可能漏了：没按确认键说过、但像是要办的事。点一下才真的建 ── */
function MissedToday() {
  const list = useLoad(() => api.get<{ suggestions: Suggestion[] }>("/v1/suggestions?status=open&days=2&limit=20").then((r) => r.suggestions), [], 2 * 60_000);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const items = (list.data ?? []).filter((s) => !gone.has(s.id));
  if (!items.length) return null;
  return (
    <section className="sheet" aria-labelledby="missed-title">
      <div className="sheet-head">
        <h2 id="missed-title">可能漏了 <span className="mono">{items.length}</span></h2>
        <div className="end"><span className="ink-3" style={{ fontSize: 13 }}>说过但没让我办的事</span></div>
      </div>
      <ol className="log">
        {items.map((s) => <SuggestionRow key={s.id} s={s} showTime onSettled={(id) => setGone(new Set([...gone, id]))} />)}
      </ol>
    </section>
  );
}

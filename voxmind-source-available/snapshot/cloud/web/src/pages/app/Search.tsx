import { useEffect, useState, type ReactNode } from "react";
import { Play, Search as SearchIcon, Square } from "lucide-react";
import { api, audioUrl, type Me, type SearchHit, type Topic } from "../../api.ts";
import { navigate } from "../../router.ts";

type Hit = SearchHit & { match: "text" | "semantic"; topic: { id: string; title: string } | null };
type TopicHit = Topic & { sessionStartedAt: string };
import { dayLabel, hhmm } from "../../format.ts";
import { PageHead } from "../../ui/Shell.tsx";
import { useToast } from "../../ui/kit.tsx";

function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{highlight(text.slice(i + q.length), q)}</>;
}

export function Search({ me, path }: { me: Me; path: string }) {
  const toast = useToast();
  const [q, setQ] = useState(() => new URLSearchParams(location.search).get("q") ?? "");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [topicHits, setTopicHits] = useState<TopicHit[]>([]);
  const [semanticReady, setSemanticReady] = useState(true);
  const [searched, setSearched] = useState("");
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState<number>(() => Number(new URLSearchParams(location.search).get("days")) || 0);
  const [kind, setKind] = useState<"all" | "text" | "semantic">("all");
  const [playing, setPlaying] = useState<{ key: string; el: HTMLAudioElement } | null>(null);

  async function run(term: string, range = days) {
    const t = term.trim();
    if (!t) { setHits(null); setSearched(""); return; }
    setBusy(true);
    try {
      const rq = `q=${encodeURIComponent(t)}${range ? `&days=${range}` : ""}`;
      const r = await api.get<{ hits: Hit[]; topics: TopicHit[]; semanticReady: boolean }>(`/v1/search?${rq}`);
      setHits(r.hits); setTopicHits(r.topics ?? []); setSearched(t); setSemanticReady(r.semanticReady);
      history.replaceState(null, "", `/app/search?${rq}`);
    } catch (e) { toast(e instanceof Error ? e.message : "搜索失败", true); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (q) void run(q); /* 带着 ?q= 打开时直接搜 */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => playing?.el.pause(), [playing]);

  function toggle(h: SearchHit) {
    const key = `${h.sessionId}:${h.sequence}`;
    if (playing?.key === key) { playing.el.pause(); setPlaying(null); return; }
    playing?.el.pause();
    const el = new Audio(audioUrl(h.sessionId, h.sequence));
    el.onended = () => setPlaying(null);
    void el.play();
    setPlaying({ key, el });
  }

  const shown = hits && (kind === "all" ? hits : hits.filter((h) => h.match === kind));

  return (
    <>
      <PageHead title="搜索说过的话" me={me} path={path} />
      <div className="work-body">
        <form className="sheet" role="search" onSubmit={(e) => { e.preventDefault(); void run(q); }}
              style={{ display: "flex", gap: 8, padding: 10 }}>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索转写"
                 placeholder="比如：合同、张伟、下周三" autoFocus />
          <button className="btn go" type="submit" disabled={busy}><SearchIcon aria-hidden />{busy ? "搜索中" : "搜索"}</button>
        </form>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <div className="seg" role="group" aria-label="时间范围">
            {[[0, "全部时间"], [1, "今天"], [7, "近 7 天"], [30, "近 30 天"]].map(([d, label]) => (
              <button key={d} aria-pressed={days === d} onClick={() => { setDays(d as number); if (q.trim()) void run(q, d as number); }}>{label}</button>
            ))}
          </div>
          {hits && hits.length > 0 && semanticReady && (
            <div className="seg" role="group" aria-label="匹配方式">
              {([["all", "全部"], ["text", "字面命中"], ["semantic", "意思相近"]] as const).map(([k, label]) => (
                <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{label}</button>
              ))}
            </div>
          )}
        </div>

        {hits === null && (
          <p className="ink-2" style={{ fontSize: 14, fontWeight: 500, padding: "0 4px", maxWidth: "62ch" }}>
            {semanticReady
              ? "既按字面搜，也按意思搜——搜「合同」也能找到「那个协议对方回了没」。找到后可以直接回放原声。"
              : "按字面搜索所有转写。找到后可以直接回放那一段原声。"}
          </p>
        )}
        {topicHits.length > 0 && (
          <section className="sheet" aria-label="匹配的主题">
            <div className="sheet-head"><h2>主题 <span className="mono">{topicHits.length}</span></h2></div>
            <ol className="log">
              {topicHits.map((t) => (
                <li key={t.id} style={{ gridTemplateColumns: "96px minmax(0,1fr) auto" }}>
                  <time>{dayLabel(Date.parse(t.sessionStartedAt) + t.startMs)}<br />{hhmm(Date.parse(t.sessionStartedAt) + t.startMs)}</time>
                  <span><b style={{ fontWeight: 600 }}>{highlight(t.title, searched)}</b>
                    {t.summary && <><br /><span className="ink-2" style={{ fontSize: 14 }}>{highlight(t.summary, searched)}</span></>}</span>
                  <button className="btn sm" onClick={() => navigate(`/app/recordings?session=${t.sessionId}`)}>打开</button>
                </li>
              ))}
            </ol>
          </section>
        )}
        {hits && hits.length === 0 && topicHits.length === 0 && (
          <div className="sheet empty"><b>没有找到「{searched}」</b>
            {semanticReady ? "换个说法试试。意思相近的句子也会找出来，但差得太远的不会。" : "换个说法试试，或者少打几个字——这里按原文逐字匹配。"}</div>
        )}
        {shown && shown.length > 0 && (
          <section className="sheet" aria-label="搜索结果">
            <div className="sheet-head"><h2>找到 <span className="mono">{shown.length}</span> 段</h2></div>
            <ol className="log">
              {shown.map((h) => {
                const key = `${h.sessionId}:${h.sequence}`;
                return (
                  <li key={key} style={{ gridTemplateColumns: "96px minmax(0,1fr) auto" }}>
                    <time>{dayLabel(Date.parse(h.sessionStartedAt) + h.startMs)}<br />{hhmm(Date.parse(h.sessionStartedAt) + h.startMs)}</time>
                    <span>
                      {highlight(h.text, searched)}
                      {h.match === "semantic" && <span className="pill" style={{ marginLeft: 8 }}>意思相近</span>}
                      <br />
                      <button className="linklike ink-3" style={{ fontSize: 13 }} onClick={() => navigate(`/app/recordings?session=${h.sessionId}&at=${h.sequence}`)}>
                        {h.topic ? `主题：${h.topic.title}` : `${hhmm(h.sessionStartedAt)} 开机的那次录音`} ›
                      </button>
                    </span>
                    <button className="btn sm icon flat" onClick={() => toggle(h)}
                            aria-label={playing?.key === key ? "停止" : `播放 ${hhmm(Date.parse(h.sessionStartedAt) + h.startMs)}`}>
                      {playing?.key === key ? <Square aria-hidden /> : <Play aria-hidden />}
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        )}
      </div>
    </>
  );
}

import { Fragment, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderPlus, Headphones, Pencil, Play, Square, Trash2, Zap } from "lucide-react";
import { api, type Me, type Timeline } from "../../api.ts";
import { dayLabel, hhmm, hours, offset, toolLabel } from "../../format.ts";
import { getRate, LoadError, Pill, playList, playLive, RATES, RecLight, setRate, Skeleton, useLoad, useToast } from "../../ui/kit.tsx";
import { PageHead } from "../../ui/Shell.tsx";
import { Wave, type WaveSelection } from "../../ui/Wave.tsx";
import { Topics } from "../../ui/Topics.tsx";
import { CopyForAi, ShareLinks } from "../../ui/CopyForAi.tsx";
import { FavoriteControl, StarButton, useFavorites, type Favorites } from "../../ui/Favorites.tsx";
import type { Topic } from "../../api.ts";

/* 三种看法：
 * - 按天：一天里的每一段。分段只有两种：开机、按设备中间的返回键手动分段（1.0.18 起暂停再继续还是同一段；
 *   之前的固件暂停后继续也会另起一段）。长的排前面，不到 3 分钟的收进折叠小组
 * - 按开机：一次开机到关机算一组，组里是手动分出的几段（靠设备上报的开机号；2026-10-04 之前的录音没有开机号，一段一组）
 * - 实时：设备正在录的那一段，新的话一到就滚到底
 * 按天、按开机、按段都能删：音频和转写删掉，已经产生的动作记录留着。
 * 名字优先用 AI 拆出来的第一个主题标题；没有就用时间。*/
interface SessionRow {
  id: string; deviceId: string; startedAt: string; status: string;
  durationMs: number; lastUploadAt: string | null; topicCount: number;
  title: string | null; actionCount: number; sentenceCount: number; bootId: string | null;
}
type View = "day" | "boot" | "live" | "fav";
const VIEW_KEY = "voxmind:rec-view";
const LIVE_MS = 2 * 60_000;           // 最后一块 2 分钟内到的，算正在录
const isLive = (s: SessionRow) => !!s.lastUploadAt && Date.now() - Date.parse(s.lastUploadAt) < LIVE_MS;
const endOf = (s: SessionRow) => Date.parse(s.startedAt) + s.durationMs;

interface BootGroup { key: string; sessions: SessionRow[]; startedAt: string; endMs: number; durationMs: number; legacy: boolean }
function bootGroups(rows: SessionRow[]): BootGroup[] {
  const map = new Map<string, SessionRow[]>();
  for (const s of rows) {
    const key = s.bootId ? `${s.deviceId}:${s.bootId}` : `one:${s.id}`;
    map.set(key, [...(map.get(key) ?? []), s]);
  }
  return [...map].map(([key, list]) => {
    const sorted = [...list].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return { key, sessions: sorted, startedAt: sorted[0]!.startedAt, endMs: Math.max(...sorted.map(endOf)),
      durationMs: sorted.reduce((n, s) => n + s.durationMs, 0), legacy: key.startsWith("one:") };
  }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

const SHORT_MS = 3 * 60_000;
const CONT_KEY = "voxmind:continuous";

function sessionName(s: SessionRow) {
  if (s.title) return s.title;
  if (s.deviceId === "web-console") return "网页输入";
  return `${hhmm(s.startedAt)} 的录音`;
}

function sessionNote(s: SessionRow) {
  const end = s.lastUploadAt && s.durationMs ? hhmm(Date.parse(s.startedAt) + s.durationMs) : null;
  const parts = [end && end !== hhmm(s.startedAt) ? `${hhmm(s.startedAt)}–${end}` : hhmm(s.startedAt)];
  if (s.durationMs) parts.push(s.durationMs < 60_000 ? "不到 1 分钟" : hours(s.durationMs));
  if (s.topicCount > 1) parts.push(`${s.topicCount} 个主题`);
  if (s.actionCount) parts.push(`${s.actionCount} 个动作`);
  return parts.join(" · ");
}

function SessionButton({ s, selected, onPick, onDelete, indent = false, star }: {
  s: SessionRow; selected: boolean; onPick: () => void; onDelete?: () => void; indent?: boolean;
  star?: { on: boolean; toggle: () => void };
}) {
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      <button className="nav" aria-current={selected ? "page" : undefined} onClick={onPick}
              style={{ borderRadius: 0, padding: `9px 8px 9px ${indent ? 34 : 18}px`, display: "flex", flexDirection: "column",
                       alignItems: "flex-start", gap: 2, flex: 1, minWidth: 0 }}>
        <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>
          {sessionName(s)}{isLive(s) && <span className="pill bad" style={{ marginLeft: 6 }}><i />在录</span>}
        </span>
        <span className="ink-3 mono" style={{ fontSize: 12 }}>{sessionNote(s)}</span>
      </button>
      {star && <StarButton on={star.on} onClick={star.toggle} />}
      {onDelete && !isLive(s) && (
        <button className="btn sm icon flat" onClick={onDelete} aria-label={`删除 ${sessionName(s)}`} title="删除这一段"
                style={{ marginRight: 8 }}><Trash2 aria-hidden /></button>
      )}
    </div>
  );
}

/* 「收藏」在左边主菜单里单独一项（/app/favorites），复用这一页：只显示收藏，不显示按天/按开机/实时 */
export function Favorites({ me, path }: { me: Me; path: string }) {
  return <Recordings me={me} path={path} only="fav" />;
}

export function Recordings({ me, path, only }: { me: Me; path: string; only?: "fav" }) {
  const toast = useToast();
  const sessions = useLoad(() => api.get<{ sessions: SessionRow[] }>("/v1/sessions?limit=200").then((r) => r.sessions), [], 30000);
  // 从搜索结果点过来会带 ?session=，直接打开那一次
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get("session"));
  const [view, setViewState] = useState<View>(() => {
    if (only) return only;
    try { const v = localStorage.getItem(VIEW_KEY); return v === "boot" || v === "live" ? v : "day"; } catch { return "day"; }
  });
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* 无痕模式 */ } };
  /* 按天：只有今天默认展开，其他天折叠，点开才看（录音多了一屏全是旧的）。打开的那段所在的那天也会展开 */
  const [openDays, setOpenDays] = useState<Set<string>>(new Set(["今天"]));
  const [openBoots, setOpenBoots] = useState<Set<string>>(new Set());
  /* 按客户/项目回看：销售和顾问关心的是"这个客户我们聊过什么"，不是"上周二录了什么" */
  const [byLabel, setByLabel] = useState("");
  const labels = useLoad(() => api.get<{ labels: { label: string; count: number }[] }>("/v1/labels").then((r) => r.labels), [], 5 * 60_000);
  const labelTopics = useLoad(() => byLabel
    ? api.get<{ topics: (Topic & { sessionStartedAt: string })[] }>(`/v1/labels/${encodeURIComponent(byLabel)}/topics`).then((r) => r.topics)
    : Promise.resolve([]), [byLabel]);
  const [openShort, setOpenShort] = useState<Set<string>>(new Set());
  const live = (sessions.data ?? []).find(isLive) ?? null;
  const fav = useFavorites<SessionRow>();
  const star = (s: SessionRow) => ({ on: fav.has(s.id), toggle: () => void fav.toggleStar(s.id) });
  useEffect(() => {
    if (selected) return;
    if (only === "fav") { if (fav.data?.items[0]) setSelected(fav.data.items[0].sessionId); }   // 收藏页：默认打开第一条收藏
    else if (sessions.data?.[0]) setSelected(sessions.data[0].id);
  }, [sessions.data, fav.data, selected, only]);
  /* 从搜索点过来（?session=）或者选中的是更早的一天：把那天展开，不然选中了却看不见 */
  const selectedDay = selected ? sessions.data?.find((x) => x.id === selected)?.startedAt : undefined;
  useEffect(() => {
    if (!selectedDay) return;
    const day = dayLabel(selectedDay);
    setOpenDays((prev) => (prev.has(day) ? prev : new Set([...prev, day])));
  }, [selectedDay]);
  useEffect(() => { if (view === "live" && live) setSelected(live.id); }, [view, live?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (set: Set<string>, key: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    apply(next);
  };

  async function remove(list: SessionRow[], what: string) {
    const ids = list.filter((s) => !isLive(s)).map((s) => s.id);
    const skipped = list.length - ids.length;
    if (!ids.length) { toast("正在录的这段删不了，等设备暂停或关机后再删", true); return; }
    const total = list.filter((s) => !isLive(s)).reduce((n, s) => n + s.durationMs, 0);
    if (!confirm(`删除${what}（${ids.length} 段，${hours(total)}）？\n音频和转写会删掉、找不回来；已经产生的动作记录会留着。${skipped ? `\n正在录的那段不会删。` : ""}`)) return;
    try {
      const r = await api.post<{ deleted: number }>("/v1/sessions/delete", { ids });
      toast(`已删除 ${r.deleted} 段`);
      if (selected && ids.includes(selected)) setSelected(null);
      void sessions.reload();
    } catch (e) { toast(e instanceof Error ? e.message : "删除失败", true); }
  }

  const days = new Map<string, SessionRow[]>();
  for (const s of sessions.data ?? []) days.set(dayLabel(s.startedAt), [...(days.get(dayLabel(s.startedAt)) ?? []), s]);
  const boots = bootGroups(sessions.data ?? []);

  return (
    <>
      <PageHead title={only ? "收藏" : "录音"} me={me} path={path} />
      <div className="work-body">
        <div className="split list">
          <nav className="sheet" aria-label="录音列表">
            {!only && <div className="sheet-head">
              <div className="seg" role="group" aria-label="怎么分">
                {([["day", "按天"], ["boot", "按开机"], ["live", "实时"]] as const).map(([v, label]) => (
                  <button key={v} aria-pressed={!byLabel && view === v} onClick={() => { setByLabel(""); setView(v); }}>
                    {label}{v === "live" && live && <i className="rec-dot" aria-hidden style={{ display: "inline-block", width: 7, height: 7, borderRadius: 9,
                      background: "var(--bad, #d33)", marginLeft: 5, verticalAlign: "middle" }} />}
                  </button>
                ))}
              </div>
              <div className="end">
                <select value={byLabel} aria-label="按客户或项目筛选" style={{ width: "auto", fontSize: 13 }}
                        onChange={(e) => setByLabel(e.target.value)}>
                  <option value="">全部录音</option>
                  {(labels.data ?? []).map((l) => <option key={l.label} value={l.label}>{l.label}（{l.count}）</option>)}
                </select>
              </div>
            </div>}
            {byLabel && (
              <div className="sheet-body" style={{ paddingTop: 10, paddingBottom: 4 }}>
                {!labelTopics.data && <Skeleton h={40} />}
                {labelTopics.data?.length === 0 && <span className="ink-3" style={{ fontSize: 13 }}>这个客户下还没有主题</span>}
                {(labelTopics.data ?? []).map((t) => (
                  <button key={t.id} className="linklike" style={{ display: "block", marginBottom: 8 }}
                          onClick={() => setSelected(t.sessionId)}>
                    <b style={{ fontWeight: 600 }}>{t.title}</b>
                    <div className="ink-3" style={{ fontSize: 12 }}>
                      {dayLabel(Date.parse(t.sessionStartedAt) + t.startMs)} {hhmm(Date.parse(t.sessionStartedAt) + t.startMs)}
                      {t.summary ? ` · ${t.summary.slice(0, 24)}` : ""}
                    </div>
                  </button>
                ))}
              </div>
            )}
            {sessions.error && !sessions.data && <div className="sheet-body"><LoadError error={sessions.error} onRetry={() => void sessions.reload()} /></div>}
            {!sessions.data && !sessions.error && <div className="sheet-body" style={{ display: "grid", gap: 10 }}>{[0, 1, 2].map((i) => <Skeleton key={i} h={36} />)}</div>}
            {sessions.data?.length === 0 && <div className="empty"><b>还没有录音</b>设备开机联网后，第一段录音会出现在这里。</div>}

            {!byLabel && view === "day" && [...days].map(([day, list]) => {
              // 当天全是短录音时不折叠——折起来这一天就像是空的
              const fold = list.some((s) => s.durationMs >= SHORT_MS);
              const long = list.filter((s) => !fold || s.durationMs >= SHORT_MS).sort((a, b) => b.durationMs - a.durationMs);
              const short = fold ? list.filter((s) => s.durationMs < SHORT_MS) : [];
              const total = list.reduce((n, s) => n + s.durationMs, 0);
              const dayOpen = openDays.has(day);
              return (
                <div key={day}>
                  <div className="log-group" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <button onClick={() => toggle(openDays, day, setOpenDays)}
                            style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, border: 0, background: "none", padding: 0,
                                     font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left" }}>
                      {dayOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                      {day}
                      <span className="ink-3" style={{ fontWeight: 400 }}>{list.length} 段 · {hours(total)}</span>
                    </button>
                    <button className="btn sm icon flat" title={`删除${day}的录音`} aria-label={`删除${day}的全部录音`}
                            onClick={() => void remove(list, `${day}的全部录音`)}><Trash2 aria-hidden /></button>
                  </div>
                  {dayOpen && (
                    <>
                      {long.map((s) => <SessionButton key={s.id} s={s} star={star(s)} selected={selected === s.id} onPick={() => setSelected(s.id)}
                                                      onDelete={() => void remove([s], `「${sessionName(s)}」`)} />)}
                      {short.length > 0 && (
                        <>
                          <button className="nav" onClick={() => toggle(openShort, day, setOpenShort)}
                                  style={{ borderRadius: 0, padding: "7px 18px", color: "var(--ink-3)", fontSize: 13, gap: 6 }}>
                            {openShort.has(day) ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                            短录音 {short.length} 条（不到 3 分钟）
                          </button>
                          {openShort.has(day) && short.map((s) => (
                            <SessionButton key={s.id} s={s} star={star(s)} selected={selected === s.id} onPick={() => setSelected(s.id)}
                                           onDelete={() => void remove([s], `「${sessionName(s)}」`)} />
                          ))}
                        </>
                      )}
                    </>
                  )}
                </div>
              );
            })}

            {!byLabel && view === "boot" && boots.map((g) => {
              const open = openBoots.has(g.key) || g.sessions.some((s) => s.id === selected);
              const first = g.sessions[0]!;
              const pauses = g.sessions.length - 1;
              const liveNow = g.sessions.some(isLive);
              return (
                <div key={g.key} style={{ borderBottom: "1px solid var(--rule)" }}>
                  <div style={{ display: "flex", alignItems: "center" }}>
                    <button className="nav" onClick={() => { toggle(openBoots, g.key, setOpenBoots); setSelected(first.id); }}
                            style={{ borderRadius: 0, padding: "10px 8px 10px 18px", display: "flex", flexDirection: "column",
                                     alignItems: "flex-start", gap: 2, flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                        {g.sessions.length > 1 ? (open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />) : null}
                        {dayLabel(g.startedAt)} {hhmm(g.startedAt)}–{liveNow ? "现在" : hhmm(g.endMs)}
                        {liveNow && <span className="pill bad"><i />在录</span>}
                      </span>
                      <span className="ink-3 mono" style={{ fontSize: 12 }}>
                        {hours(g.durationMs)}{pauses > 0 ? ` · 分成 ${pauses + 1} 段` : ""}{g.legacy ? " · 早期录音（没有开机记录）" : ""}
                        {first.title ? ` · ${first.title}` : ""}
                      </span>
                    </button>
                    {g.sessions.some((s) => !isLive(s)) && (
                      <button className="btn sm icon flat" style={{ marginRight: 8 }} title="删除这次开机的全部录音"
                              aria-label={`删除 ${dayLabel(g.startedAt)} ${hhmm(g.startedAt)} 这次开机的录音`}
                              onClick={() => void remove(g.sessions, `${dayLabel(g.startedAt)} ${hhmm(g.startedAt)} 这次开机的录音`)}><Trash2 aria-hidden /></button>
                    )}
                  </div>
                  {open && g.sessions.length > 1 && g.sessions.map((s, i) => (
                    <SessionButton key={s.id} s={s} star={star(s)} indent selected={selected === s.id} onPick={() => setSelected(s.id)}
                                   onDelete={() => void remove([s], `这次开机的第 ${i + 1} 段`)} />
                  ))}
                </div>
              );
            })}

            {!byLabel && view === "live" && sessions.data && (
              <div className="sheet-body" style={{ display: "grid", gap: 8 }}>
                {live ? (
                  <>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}><RecLight lastUploadAt={live.lastUploadAt} /><b>设备正在录</b></span>
                    <span className="ink-2" style={{ fontSize: 14 }}>{hhmm(live.startedAt)} 开始 · 已录 {hours(live.durationMs)}</span>
                    <span className="ink-3" style={{ fontSize: 13 }}>右边是这一段的文字稿，新的话转写出来就会出现在最下面（有十几秒到半分钟延迟）。</span>
                  </>
                ) : (
                  <>
                    <b>设备现在没在录</b>
                    <span className="ink-3" style={{ fontSize: 13 }}>
                      {sessions.data[0]?.lastUploadAt ? `最近一段在 ${dayLabel(sessions.data[0].lastUploadAt)} ${hhmm(sessions.data[0].lastUploadAt)} 停下。` : ""}
                      暂停、关机或者没联网时这里是空的；开始录了会自动出现。
                    </span>
                  </>
                )}
              </div>
            )}

            {!byLabel && view === "fav" && (
              <FavoriteList fav={fav} selected={selected} onPick={setSelected} star={star} />
            )}
          </nav>
          {selected ? <SessionDetail key={selected} id={selected} follow={view === "live" && live?.id === selected} fav={fav} /> : null}
        </div>
      </div>
    </>
  );
}

/* 收藏视图：文件夹（可改名、删除）+ 没放进文件夹的。一段可以出现在几个文件夹里 */
function FavoriteList({ fav, selected, onPick, star }: {
  fav: ReturnType<typeof useFavorites<SessionRow>>; selected: string | null; onPick: (id: string) => void;
  star: (s: SessionRow) => { on: boolean; toggle: () => void };
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  if (!fav.data) return <div className="sheet-body"><Skeleton h={36} /></div>;
  const { folders, items, sessions } = fav.data;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const group = (key: string, title: React.ReactNode, ids: string[], actions?: React.ReactNode, note?: React.ReactNode) => {
    const open = !closed.has(key);
    const list = ids.map((id) => byId.get(id)).filter((s): s is SessionRow => !!s);
    return (
      <div key={key}>
        <div className="log-group" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {/* 手机上放不下时操作按钮换到下一行，别把文件夹名挤成一字一行 */}
          <button onClick={() => { const n = new Set(closed); if (n.has(key)) n.delete(key); else n.add(key); setClosed(n); }}
                  style={{ display: "flex", alignItems: "center", gap: 6, flex: "1 1 150px", minWidth: 0, whiteSpace: "nowrap", border: 0, background: "none", padding: 0, font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left" }}>
            {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}{title}
            <span className="ink-3" style={{ fontWeight: 400 }}>{list.length} 段</span>
          </button>
          {actions}
        </div>
        {open && note}
        {open && list.map((s) => <SessionButton key={`${key}:${s.id}`} s={s} indent selected={selected === s.id} onPick={() => onPick(s.id)} star={star(s)} />)}
        {open && !list.length && <div className="ink-3" style={{ fontSize: 13, padding: "8px 34px" }}>空的。打开一段录音，点右上角「放进文件夹」。</div>}
      </div>
    );
  };
  const unfiled = items.filter((i) => !i.folderIds.length).map((i) => i.sessionId);
  const folderHasItems = (folderId: string) => items.some((i) => i.folderIds.includes(folderId));
  return (
    <>
      <div className="sheet-body" style={{ display: "flex", gap: 8, alignItems: "center", paddingBottom: 8 }}>
        <button className="btn sm" onClick={() => { const name = prompt("新文件夹叫什么？")?.trim(); if (name) void fav.createFolder(name.slice(0, 40)); }}>
          <FolderPlus aria-hidden />新建文件夹
        </button>
        <span className="ink-3" style={{ fontSize: 12 }}>也可以在「聊天」里说：把和某某相关的录音放进收藏的新文件夹</span>
      </div>
      {!items.length && !folders.length && (
        <div className="empty"><b>还没有收藏</b>点每段录音旁边的 ☆ 收藏；打开一段录音还能放进文件夹，一段可以放进好几个。</div>
      )}
      {folders.map((f) => group(f.id, <><Folder size={14} aria-hidden />{f.name}</>,
        items.filter((i) => i.folderIds.includes(f.id)).map((i) => i.sessionId),
        <>
          {folderHasItems(f.id) && <CopyForAi folderId={f.id} label="给 AI" what={`收藏夹「${f.name}」里的全部录音`} />}
          <button className="btn sm icon flat" title="自动归档：提到某些词的录音自动放进来" aria-label={`给「${f.name}」设自动归档`}
                  onClick={() => {
                    const raw = prompt("提到哪些词的录音自动放进这个文件夹？用逗号隔开（比如：张总，某某公司）。清空就是关掉。", f.keywords.join("，"));
                    if (raw !== null) void fav.setKeywords(f.id, raw.split(/[，,、\s]+/).map((x) => x.trim()).filter(Boolean).slice(0, 10));
                  }}><Zap aria-hidden fill={f.keywords.length ? "currentColor" : "none"} /></button>
          <button className="btn sm icon flat" title="改名" aria-label={`给「${f.name}」改名`}
                  onClick={() => { const name = prompt("改成什么名字？", f.name)?.trim(); if (name && name !== f.name) void fav.renameFolder(f.id, name.slice(0, 40)); }}><Pencil aria-hidden /></button>
          <button className="btn sm icon flat" title="删除文件夹" aria-label={`删除文件夹「${f.name}」`}
                  onClick={() => { if (confirm(`删除文件夹「${f.name}」？里面的录音不会删，还在收藏里。`)) void fav.deleteFolder(f.id); }}><Trash2 aria-hidden /></button>
        </>,
        f.keywords.length ? <div className="ink-3" style={{ fontSize: 12, padding: "4px 18px 4px 34px" }}>自动收：提到「{f.keywords.join("」「")}」的录音</div> : null))}
      {unfiled.length > 0 && group("unfiled", "没放进文件夹", unfiled)}
    </>
  );
}

function SessionDetail({ id, follow = false, fav }: { id: string; follow?: boolean; fav: Favorites }) {
  const [playing, setPlaying] = useState<{ seq: number; stop: () => void; setRate: (v: number) => void } | null>(null);
  const [current, setCurrent] = useState<number | null>(null);        // 正在播的那句（句首块号）
  const [rate, setRateState] = useState(getRate);
  // 连播：点一句往后一直播到结尾，静音块不在列表里＝自动跳过
  const [continuous, setContinuous] = useState(() => { try { return localStorage.getItem(CONT_KEY) !== "0"; } catch { return true; } });
  const [selection, setSelection] = useState<WaveSelection | null>(null);
  const [focus, setFocus] = useState<{ topicId: string | null; range: (WaveSelection & { key: string }) | null }>({ topicId: null, range: null });
  const [topics, setTopics] = useState<Topic[]>([]);
  /* 实时收听：从最新一块开始一直往后播 */
  const [live, setLive] = useState<{ stop: () => void } | null>(null);
  const [liveWaiting, setLiveWaiting] = useState(false);
  useEffect(() => () => live?.stop(), [live]);
  /* 设备不录了（暂停、关机）或者切出了「实时」：收听跟着停，别在后台一直要下一块 */
  useEffect(() => { if (!follow && live) { live.stop(); setLive(null); setLiveWaiting(false); } }, [follow, live]);
  const tl = useLoad(() => api.get<{ timeline: Timeline }>(`/v1/sessions/${id}/timeline`).then((r) => r.timeline), [id, follow], follow ? 8000 : 20000);
  /* 实时：有新的转写到了就滚到最后一句（正在播的时候不抢滚动） */
  const lastSeq = tl.data ? Math.max(-1, ...tl.data.transcripts.filter((x) => x.status === "succeeded" && x.text.trim()).map((x) => x.sequence)) : -1;
  useEffect(() => {
    if (!follow || lastSeq < 0 || playing) return;
    requestAnimationFrame(() => document.querySelector(`#ln-${id}-${lastSeq}`)?.scrollIntoView({ block: "end", behavior: "smooth" }));
  }, [follow, lastSeq, id, playing]);
  useEffect(() => () => playing?.stop(), [playing]);
  /* 从搜索结果点过来带 ?at=块号：滚到那一句并高亮一下 */
  const [jumped, setJumped] = useState(false);
  useEffect(() => {
    if (jumped || !tl.data) return;
    const params = new URLSearchParams(location.search);
    const raw = params.get("at");
    if (raw === null || params.get("session") !== id) return;
    const at = Number(raw);
    const head = [...tl.data.transcripts].filter((x) => x.sequence <= at && (x.endSequence ?? x.sequence) >= at)[0]?.sequence ?? at;
    requestAnimationFrame(() => document.getElementById(`ln-${id}-${head}`)?.scrollIntoView({ block: "center" }));
    setCurrent(head);
    setJumped(true);
  }, [tl.data, jumped, id]);

  if (tl.error && !tl.data) return <LoadError error={tl.error} onRetry={() => void tl.reload()} />;
  if (!tl.data) return <div className="sheet sheet-body" style={{ display: "grid", gap: 10 }}>{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} />)}</div>;
  const t = tl.data;
  const transcripts = new Map(t.transcripts.map((s) => [s.sequence, s]));
  const draftsAt = new Map<number, typeof t.drafts>();
  for (const d of t.drafts) {
    const k = d.evidenceStartMs ?? -1;
    draftsAt.set(k, [...(draftsAt.get(k) ?? []), d]);
  }
  const totalMs = t.chunks.reduce((n, c) => n + c.durationMs, 0);
  // 红灯只由最后一块真实上传的时间决定。会话状态停在 recording 不代表还在录——
  // 设备断电时根本来不及告诉云端"结束了"
  const lastUpload = t.chunks.reduce<string | null>((m, c) => (!m || c.uploadedAt > m ? c.uploadedAt : m), null);
  const started = Date.parse(t.session.startedAt);

  /* 按时间正着排，像读一份文字稿；主题的标题插在它开始的那一句前面，当章节用 */
  const lines = [...t.chunks].sort((a, b) => a.sequence - b.sequence).filter((c) => {
    const seg = transcripts.get(c.sequence);
    // 静音、语气词、并进前句的块不单独占行（它们的声音已经算在那一句里）
    return !(seg?.status === "succeeded" && (seg.kind !== "speech" || !seg.text.trim()) && !(draftsAt.get(c.startMs)?.length));
  });
  const headOf = new Map<number, number>();           // 块号 → 所在那句的句首块号（高亮用）
  for (const c of lines) {
    const end = transcripts.get(c.sequence)?.endSequence ?? c.sequence;
    for (let q = c.sequence; q <= end; q++) headOf.set(q, c.sequence);
  }
  const sortedTopics = [...topics].sort((a, b) => a.startMs - b.startMs);
  const chapterAt = new Map<number, Topic>();
  for (const topic of sortedTopics) {
    const first = lines.find((c) => c.startMs + c.durationMs > topic.startMs && !chapterAt.has(c.sequence));
    if (first) chapterAt.set(first.sequence, topic);
  }

  function toggle(index: number) {
    const c = lines[index]!;
    if (live) { live.stop(); setLive(null); setLiveWaiting(false); }
    if (playing?.seq === c.sequence) { playing.stop(); setPlaying(null); setCurrent(null); return; }
    playing?.stop();
    const seqs: number[] = [];
    for (const line of continuous ? lines.slice(index) : [c]) {
      const seg = transcripts.get(line.sequence);
      if (continuous && seg?.status === "succeeded" && seg.kind !== "speech") continue;
      const end = seg?.endSequence ?? line.sequence;
      for (let q = line.sequence; q <= end; q++) seqs.push(q);
    }
    const run = playList(id, seqs, () => { setPlaying(null); setCurrent(null); }, (seq) => {
      const head = headOf.get(seq) ?? seq;
      setCurrent(head);
      if (continuous) document.getElementById(`ln-${id}-${head}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    setPlaying({ seq: c.sequence, ...run });
  }

  const chunkSec = Math.round((t.chunks.reduce((m, c) => (c.sequence > m.sequence ? c : m), t.chunks[0] ?? { sequence: 0, durationMs: 15_000 }).durationMs || 15_000) / 1000);
  function toggleLive() {
    if (live) { live.stop(); setLive(null); setCurrent(null); setLiveWaiting(false); return; }
    playing?.stop(); setPlaying(null);
    const latest = Math.max(0, ...t.chunks.map((c) => c.sequence));
    setLive(playLive(id, latest, (seq) => {
      const head = headOf.get(seq) ?? seq;
      setCurrent(head);
    }, setLiveWaiting));
  }

  function changeRate(v: number) { setRate(v); setRateState(v); playing?.setRate(v); }
  function changeContinuous(v: boolean) {
    setContinuous(v);
    try { localStorage.setItem(CONT_KEY, v ? "1" : "0"); } catch { /* 无痕模式 */ }
  }

  return (
    <section className="sheet" aria-label="录音详情">
      <div className="sheet-head">
        <h2>{dayLabel(t.session.startedAt)} {hhmm(t.session.startedAt)} 起</h2>
        <div className="end">
          <FavoriteControl sessionId={id} fav={fav} />
          <span className="ink-2" style={{ fontSize: 13, fontWeight: 500 }}>{hours(totalMs)} · {t.chunks.length} 段 · {t.drafts.length} 个动作</span>
          {lastUpload && Date.now() - Date.parse(lastUpload) < 3600_000 && <RecLight lastUploadAt={lastUpload} />}
        </div>
      </div>
      {t.chunks.length > 0 && (
        <div className="sheet-body" style={{ paddingBottom: 12, borderBottom: "1px solid var(--rule)" }}>
          <Wave sessionId={id} startedAt={t.session.startedAt} onChanged={() => void tl.reload()}
                bands={topics} activeBand={focus.topicId} select={focus.range} onSelection={setSelection} />
          <div style={{ marginTop: 10 }}><ShareLinks sessionId={id} /></div>
          <div style={{ marginTop: 16 }}>
            <Topics sessionId={id} startedAt={t.session.startedAt} chunks={t.chunks} selection={selection} onChanged={setTopics}
                    onFocus={(f) => setFocus({ topicId: f.topicId, range: f.range ? { ...f.range, key: `${f.topicId}:${Date.now()}` } : null })} />
          </div>
        </div>
      )}
      {t.chunks.length === 0 && <div className="empty"><b>这段会话没有音频</b>网页文字指令也会生成会话，但没有录音可回放。</div>}
      {follow && (
        <div className="play-bar">
          <button className={live ? "btn go" : "btn"} onClick={toggleLive}>
            {live ? <Square aria-hidden /> : <Headphones aria-hidden />}{live ? "停止收听" : "实时收听"}
          </button>
          <span className="ink-3" style={{ fontSize: 13 }}>
            {live ? (liveWaiting ? "等设备传下一段…" : `正在听，比现场慢 ${chunkSec + 5} 秒左右`)
              : `设备每录满一段（${chunkSec} 秒）传一次，所以会比现场慢 ${chunkSec + 5} 秒左右`}
          </span>
        </div>
      )}
      {lines.length > 0 && (
        <div className="play-bar">
          <label className="switch-inline">
            <input type="checkbox" checked={continuous} onChange={(e) => changeContinuous(e.target.checked)} />
            连着往下播（跳过静音）
          </label>
          <div className="seg" role="group" aria-label="播放速度">
            {RATES.map((r) => <button key={r} aria-pressed={rate === r} onClick={() => changeRate(r)}>{r}×</button>)}
          </div>
          {sortedTopics.length > 1 && (
            <div className="chapters" aria-label="章节">
              {sortedTopics.map((tp) => (
                <button key={tp.id} className="chip" onClick={() => document.getElementById(`ch-${tp.id}`)?.scrollIntoView({ block: "start", behavior: "smooth" })}>
                  <span className="mono">{hhmm(started + tp.startMs)}</span>{tp.title}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <ol className="log">
        {lines.map((c, index) => {
          const seg = transcripts.get(c.sequence);
          const drafts = draftsAt.get(c.startMs) ?? [];
          const chapter = chapterAt.get(c.sequence);
          return (
            <Fragment key={c.sequence}>
              {chapter && (
                <li id={`ch-${chapter.id}`} className="chapter-head">
                  <time>{hhmm(started + chapter.startMs)}</time>
                  <div><b>{chapter.title}</b>{chapter.summary && <span className="ink-2"> — {chapter.summary}</span>}</div>
                </li>
              )}
              <li id={`ln-${id}-${c.sequence}`} className={current === c.sequence ? "now-playing" : undefined}>
                <time title={`第 ${c.sequence}${seg?.endSequence ? `–${seg.endSequence}` : ""} 段，偏移 ${offset(c.startMs)}`}>{hhmm(started + c.startMs)}</time>
                <div>
                  {!seg && <span className="quiet">等待转写</span>}
                  {seg?.status === "failed" && <span className="failed">转写失败：{seg.error}</span>}
                  {seg?.status === "succeeded" && <span>{seg.text || <span className="quiet">（静音）</span>}</span>}
                  {drafts.map((d) => (
                    <div key={d.id} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, fontSize: 13 }}>
                      <span className="pill info">{toolLabel(d.tool)}</span>{d.title}<Pill status={d.status} />
                    </div>
                  ))}
                </div>
                <button className="btn sm icon flat" onClick={() => toggle(index)}
                        aria-label={playing?.seq === c.sequence ? "停止" : `从 ${hhmm(started + c.startMs)} 开始播放`}>
                  {playing?.seq === c.sequence ? <Square aria-hidden /> : <Play aria-hidden />}
                </button>
              </li>
            </Fragment>
          );
        })}
      </ol>
    </section>
  );
}

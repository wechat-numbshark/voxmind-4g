import { useState } from "react";
import { ChevronDown, ChevronRight, Download, FileText, GitFork, ListChecks, Pencil, Printer, Play, RefreshCw, Scissors, Square, Trash2, Wand2 } from "lucide-react";
import { api, type AiOutput, type MindNode, type Topic } from "../api.ts";
import { clock, hhmm } from "../format.ts";
import { CopyForAi } from "./CopyForAi.tsx";
import { Markdown } from "./Markdown.tsx";
import { MindMap } from "./MindMap.tsx";
import { LoadError, playRun, Skeleton, useLoad, useToast } from "./kit.tsx";
import { SuggestionRow, type Suggestion } from "./Suggestions.tsx";
import type { WaveSelection } from "./Wave.tsx";

/* 一次录音里的主题：AI 拆的 + 人自己划的。
 * 每个主题都能试听、导出、生成纪要和思维导图、改标题、在波形上重新拖范围。
 * 人改过的主题标成「人工」，以后再重新拆分也不会被覆盖。*/

interface TopicData { topics: Topic[]; outputs: AiOutput[]; templates: { key: string; label: string }[]; aiReady: boolean }
interface ChunkRef { sequence: number; startMs: number; durationMs: number }

export function Topics({ sessionId, startedAt, chunks, selection, onFocus, onChanged }: {
  sessionId: string; startedAt: string; chunks: ChunkRef[];
  selection: WaveSelection | null;
  /** 让波形选中某一段、高亮某个主题（调整范围时用） */
  onFocus: (focus: { topicId: string | null; range: WaveSelection | null }) => void;
  onChanged: (topics: Topic[]) => void;
}) {
  const toast = useToast();
  const data = useLoad(async () => {
    const r = await api.get<TopicData>(`/v1/sessions/${sessionId}/topics`);
    onChanged(r.topics);
    return r;
  }, [sessionId]);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<{ id: string; kind: AiOutput["kind"] } | null>(null);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [template, setTemplate] = useState("general");
  const [playing, setPlaying] = useState<{ id: string; stop: () => void } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  /* 客户/项目标签：输入框里的临时值（失焦才保存），以及已经用过的名字用来自动提示 */
  const [labels, setLabels] = useState<Record<string, string>>({});
  const known = useLoad(() => api.get<{ labels: { label: string }[] }>("/v1/labels").then((r) => r.labels.map((x) => x.label)), []);
  /* 这次录音里"看出来了但没建"的事，按主题挂在各自的卡片下面 */
  const suggestions = useLoad(() => api.get<{ suggestions: Suggestion[] }>(`/v1/suggestions?status=open&sessionId=${sessionId}&limit=50`)
    .then((r) => r.suggestions), [sessionId], 60_000);
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  /* 「可能漏了的事」默认收起：大多是旁人的话、视频里的话，铺开会把主题淹掉（14 天 104 条，采纳 0）。想看再点开 */
  const [missedOpen, setMissedOpen] = useState<Set<string>>(new Set());

  const started = Date.parse(startedAt);
  const reload = () => data.reload();

  async function act(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    try { await fn(); if (ok) toast(ok); await reload(); }
    catch (e) { toast(e instanceof Error ? e.message : "操作失败", true); }
    finally { setBusy(null); }
  }

  function play(t: Topic) {
    if (playing?.id === t.id) { playing.stop(); setPlaying(null); return; }
    playing?.stop();
    const inRange = chunks.filter((c) => c.startMs < t.endMs && c.startMs + c.durationMs > t.startMs);
    if (!inRange.length) { toast("这一段没有音频", true); return; }
    setPlaying({ id: t.id, ...playRun(sessionId, inRange[0]!.sequence, inRange[inRange.length - 1]!.sequence, () => setPlaying(null)) });
  }

  const outputsOf = (id: string, kind: AiOutput["kind"]) => (data.data?.outputs ?? []).filter((o) => o.targetId === id && o.kind === kind);

  function generate(targetType: "topic" | "session", targetId: string, kind: AiOutput["kind"]) {
    void act(`${targetId}:${kind}`, async () => {
      await api.post("/v1/outputs", { kind, targetType, targetId, ...(kind === "minutes" ? { template } : {}) });
      setOpen({ id: targetId, kind });
    }, kind === "minutes" ? "纪要已生成" : "思维导图已生成");
  }

  if (data.error && !data.data) return <LoadError error={data.error} onRetry={() => void reload()} />;
  if (!data.data) return <div style={{ display: "grid", gap: 8 }}><Skeleton h={28} /><Skeleton h={60} /></div>;
  const { topics, aiReady, templates } = data.data;

  /** 生成/查看按钮 + 展开的内容，主题和整次录音共用 */
  const outputControls = (targetType: "topic" | "session", id: string, name: string) => (
    <>
      {(["minutes", "mindmap"] as const).map((kind) => {
        const have = outputsOf(id, kind);
        const isOpen = open?.id === id && open.kind === kind;
        const key = `${id}:${kind}`;
        return (
          <button key={kind} className={`btn sm${isOpen ? " go" : ""}`} disabled={busy === key || (!have.length && !aiReady)}
                  onClick={() => (have.length ? setOpen(isOpen ? null : { id, kind }) : generate(targetType, id, kind))}
                  title={!have.length && !aiReady ? "没有配置大模型" : undefined}>
            {kind === "minutes" ? <FileText aria-hidden /> : <GitFork aria-hidden />}
            {busy === key ? "生成中（约半分钟）" : `${have.length ? "看" : "生成"}${kind === "minutes" ? "纪要" : "导图"}`}
          </button>
        );
      })}
    </>
  );

  const outputPanel = (targetType: "topic" | "session", id: string, name: string) => {
    if (open?.id !== id) return null;
    const latest = outputsOf(id, open.kind)[0];
    if (!latest) return null;
    return (
      <div style={{ marginTop: 10, padding: 12, border: "1px solid var(--rule)", borderRadius: 8, background: "var(--paper)", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8, fontSize: 13 }}>
          <span className="ink-2">{open.kind === "minutes" ? `纪要（${templates.find((t) => t.key === latest.template)?.label ?? "通用"}）` : "思维导图"}
            · {hhmm(latest.createdAt)} 生成</span>
          {open.kind === "minutes" && (
            <>
              <button className="btn sm" onClick={() => {
                const a = document.createElement("a");
                a.href = URL.createObjectURL(new Blob([latest.content], { type: "text/markdown" }));
                a.download = `${name}-纪要.md`; a.click();
              }}><Download aria-hidden />下载</button>
              <button className="btn sm" onClick={() => void navigator.clipboard.writeText(latest.content).then(() => toast("已复制"), () => toast("浏览器不允许复制", true))}>复制</button>
              <a className="btn sm" href={`/v1/outputs/${latest.id}/export.docx`} download><Download aria-hidden />Word</a>
              {/* PDF 走浏览器打印：中文在服务端生成要嵌字体，背一个几兆的依赖不值，
                  而且浏览器导出的排版更可控 */}
              <button className="btn sm" onClick={() => printMarkdown(name, latest.content)}><Printer aria-hidden />打印/PDF</button>
              {/* 纪要里有待办：一键变成飞书任务卡片，要不要先问照「执行规则」 */}
              {/##[^\n]*待办[^\n]*\n\s*(?:[-*]|\d+[.、)])\s*(?!无)\S/.test(latest.content) && (
                <button className="btn sm" disabled={!aiReady || busy === `${id}:tasks`} onClick={() => void act(`${id}:tasks`, async () => {
                  const r = await api.post<{ drafts: { status: string }[] }>(`/v1/outputs/${latest.id}/tasks`);
                  const pending = r.drafts.filter((d) => d.status === "pending").length;
                  toast(pending ? `已生成 ${r.drafts.length} 张飞书任务卡，${pending} 张在「今天」等你确认` : `已交给飞书建 ${r.drafts.length} 个任务`);
                })}>
                  <ListChecks aria-hidden />{busy === `${id}:tasks` ? "整理中" : "待办转飞书任务"}
                </button>
              )}
            </>
          )}
          <button className="btn sm" disabled={!aiReady || busy === `${id}:${open.kind}`} onClick={() => generate(targetType, id, open.kind)}>
            <RefreshCw aria-hidden />{busy === `${id}:${open.kind}` ? "生成中" : "重新生成"}
          </button>
        </div>
        {open.kind === "minutes" ? <Markdown text={latest.content} /> : <MindMap tree={JSON.parse(latest.content) as MindNode} name={name} />}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      {/* 已经用过的客户/项目名：输入时自动提示，免得同一个客户写出三种写法 */}
      <datalist id="voxmind-labels">{(known.data ?? []).map((l: string) => <option key={l} value={l} />)}</datalist>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h3 style={{ marginRight: "auto" }}>主题 <span className="mono ink-3">{topics.length}</span></h3>
        <label className="ink-2" style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6 }}>纪要模板
          <select value={template} onChange={(e) => setTemplate(e.target.value)} style={{ width: "auto" }}>
            {templates.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
        <button className="btn sm" disabled={!selection || busy === "new"}
                title={selection ? "" : "先在上面的波形上拖选一段"}
                onClick={() => {
                  if (!selection) return;
                  const title = window.prompt("给这段起个标题", `${hhmm(started + selection.from)} 起的一段`);
                  if (!title?.trim()) return;
                  void act("new", () => api.post(`/v1/sessions/${sessionId}/topics`, { startMs: selection.from, endMs: selection.to, title: title.trim() }), "已新建主题");
                }}><Scissors aria-hidden />用选中范围新建主题</button>
        <button className="btn sm" disabled={!aiReady || busy === "analyze"}
                onClick={() => void act("analyze", () => api.post(`/v1/sessions/${sessionId}/topics/analyze`), "已重新拆分，人工主题保留")}>
          <Wand2 aria-hidden />{busy === "analyze" ? "拆分中（约一分钟）" : topics.length ? "重新拆分" : "AI 拆主题"}
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 13 }}>
        <span className="ink-2">整次录音：</span>
        {outputControls("session", sessionId, `录音-${hhmm(started)}`)}
      </div>
      {outputPanel("session", sessionId, `录音-${hhmm(started)}`)}

      {topics.length === 0 && (
        <p className="ink-2" style={{ fontSize: 14 }}>
          还没有主题。录音结束 20 分钟后会自动拆（在「我的 → AI 助手」里可以关掉或改间隔），也可以点「AI 拆主题」马上拆，或者在波形上拖选一段自己建。
        </p>
      )}
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {topics.map((t) => {
          const name = t.title.replace(/[\\/:*?"<>|]/g, "");
          const range = `?from=${t.startMs}&to=${t.endMs}`;
          return (
            <li key={t.id} className="sheet" style={{ padding: 12, borderColor: adjusting === t.id ? "var(--act)" : undefined }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span className="mono ink-2" style={{ fontSize: 13 }}>{hhmm(started + t.startMs)}–{hhmm(started + t.endMs)} · {clock(Math.round((t.endMs - t.startMs) / 1000))}</span>
                <span className={`pill${t.source === "user" ? " info" : ""}`}>{t.source === "user" ? "人工" : "AI"}</span>
              </div>
              {editing?.id === t.id ? (
                <form style={{ display: "flex", gap: 8, marginTop: 6 }} onSubmit={(e) => {
                  e.preventDefault();
                  void act(`title:${t.id}`, () => api.patch(`/v1/topics/${t.id}`, { title: editing.title }), "标题已改");
                  setEditing(null);
                }}>
                  <input value={editing.title} maxLength={80} autoFocus onChange={(e) => setEditing({ id: t.id, title: e.target.value })} aria-label="主题标题" />
                  <button className="btn sm go" type="submit" disabled={!editing.title.trim()}>保存</button>
                  <button className="btn sm" type="button" onClick={() => setEditing(null)}>取消</button>
                </form>
              ) : (
                <div style={{ fontWeight: 600, fontSize: 16, marginTop: 4 }}>{t.title}</div>
              )}
              {t.summary && <p className="ink-2" style={{ fontSize: 14, marginTop: 2 }}>{t.summary}</p>}

              {/* 这一段里说过、但没让它办的事：点「建」才真的建 */}
              {(suggestions.data ?? []).filter((x) => x.topicId === t.id && !dropped.has(x.id)).length > 0 && (
                <div style={{ marginTop: 8, border: "1px solid var(--rule)", borderRadius: 8, overflow: "hidden" }}>
                  <button className="ink-3" aria-expanded={missedOpen.has(t.id)}
                          onClick={() => { const next = new Set(missedOpen); if (next.has(t.id)) next.delete(t.id); else next.add(t.id); setMissedOpen(next); }}
                          style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", fontSize: 13, padding: "6px 10px",
                                   background: "var(--paper-2)", border: 0, font: "inherit", cursor: "pointer", textAlign: "left" }}>
                    {missedOpen.has(t.id) ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                    这一段里可能漏了的事（{(suggestions.data ?? []).filter((x) => x.topicId === t.id && !dropped.has(x.id)).length}）
                  </button>
                  {missedOpen.has(t.id) && (
                    <ol className="log">
                      {(suggestions.data ?? []).filter((x) => x.topicId === t.id && !dropped.has(x.id)).map((x) => (
                        <SuggestionRow key={x.id} s={x} onSettled={(id) => setDropped(new Set([...dropped, id]))} />
                      ))}
                    </ol>
                  )}
                </div>
              )}

              {adjusting === t.id && (
                <div className="notice info" style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span>在上面的波形上拖出新的范围，然后保存。</span>
                  <button className="btn sm go" disabled={!selection} onClick={() => {
                    if (!selection) return;
                    void act(`range:${t.id}`, () => api.patch(`/v1/topics/${t.id}`, { startMs: selection.from, endMs: selection.to }), "范围已更新");
                    setAdjusting(null); onFocus({ topicId: null, range: null });
                  }}>保存范围</button>
                  <button className="btn sm" onClick={() => { setAdjusting(null); onFocus({ topicId: null, range: null }); }}>取消</button>
                </div>
              )}

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                <button className="btn sm" onClick={() => play(t)}>{playing?.id === t.id ? <Square aria-hidden /> : <Play aria-hidden />}{playing?.id === t.id ? "停止" : "试听"}</button>
                <a className="btn sm" href={`/v1/sessions/${sessionId}/export.wav${range}`} download><Download aria-hidden />音频</a>
                <a className="btn sm" href={`/v1/sessions/${sessionId}/export.txt${range}`} download><FileText aria-hidden />文字</a>
                <CopyForAi sessionId={sessionId} from={t.startMs} to={t.endMs} what={`「${t.title}」这个话题`} />
                {outputControls("topic", t.id, name)}
                <button className="btn sm" onClick={() => setEditing({ id: t.id, title: t.title })}><Pencil aria-hidden />改标题</button>
                <button className="btn sm" onClick={() => { setAdjusting(t.id); onFocus({ topicId: t.id, range: { from: t.startMs, to: t.endMs } }); }}>
                  <Scissors aria-hidden />调整范围</button>
                {confirmDelete === t.id ? (
                  <>
                    <button className="btn sm no" onClick={() => { setConfirmDelete(null); void act(`del:${t.id}`, () => api.del(`/v1/topics/${t.id}`), "主题已删除（录音还在）"); }}>确认删除</button>
                    <button className="btn sm" onClick={() => setConfirmDelete(null)}>取消</button>
                  </>
                ) : <button className="btn sm no" onClick={() => setConfirmDelete(t.id)}><Trash2 aria-hidden />删除</button>}
              </div>
              {outputPanel("topic", t.id, name)}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** 开一个只有纪要内容的窗口直接调打印：用户在打印对话框里选"存成 PDF" */
function printMarkdown(title: string, markdown: string) {
  const html = markdown
    .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] ?? c))
    .split("\n")
    .map((line) => {
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) return `<h${h[1]!.length + 1}>${h[2]}</h${h[1]!.length + 1}>`;
      const b = line.match(/^\s*[-*]\s+(.*)$/);
      if (b) return `<li>${b[1]}</li>`;
      if (line.startsWith("&gt;")) return `<blockquote>${line.replace(/^&gt;\s?/, "")}</blockquote>`;
      return line.trim() ? `<p>${line}</p>` : "";
    })
    .join("\n")
    .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>");
  const win = window.open("", "_blank", "width=800,height=900");
  if (!win) return;
  win.document.write(`<!doctype html><meta charset="utf-8"><title>${title}</title>
    <style>body{font:15px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#12202A}
    h1{font-size:24px}h2{font-size:19px;margin-top:28px}h3{font-size:16px}
    blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #D5DCDA;color:#55635F}
    ul{padding-left:22px}li{margin:4px 0}@media print{body{margin:0}}</style>
    <h1>${title}</h1>${html}`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}

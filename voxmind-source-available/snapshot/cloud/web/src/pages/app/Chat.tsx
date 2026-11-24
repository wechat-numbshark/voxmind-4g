import { useEffect, useRef, useState } from "react";
import { Download, Play, Send, Square, Trash2 } from "lucide-react";
import { api, type Me } from "../../api.ts";
import { toolLabel } from "../../format.ts";
import { Markdown } from "../../ui/Markdown.tsx";
import { PageHead } from "../../ui/Shell.tsx";
import { playRun, useLoad, useToast } from "../../ui/kit.tsx";
import { navigate } from "../../router.ts";

/* 和 AI 聊录音里的事，或者让它办事。
 * 回答里的 [1] [2] 是出处：下面列出对应的时间，点一下直接播那段原声。
 * 让它办事时生成的是动作卡片——要不要先问你，和「我的 → 执行规则」一致。
 * 对话只存在这个浏览器里（关掉标签页前都在），服务器不保存聊天记录。*/

interface Citation { sessionId: string; startMs: number; endMs: number; label: string }
interface ActionResult { draftId: string; title: string; tool: string; status: string }
interface Link { label: string; url: string }
interface Turn { role: "user" | "assistant"; content: string; citations?: Citation[]; actions?: ActionResult[]; links?: Link[] }

const STORE = "voxmind:chat";
/* 快捷问题在「我的 → AI 助手」里改；没加载到时先用这几个 */
const EXAMPLES = ["今天上午见了谁，聊了什么？", "客户说的预算是多少？", "把下午那个会的纪要要点列一下", "帮我建个飞书任务：明天上午十点给王总回电话"];

const STATUS: Record<string, string> = { pending: "已生成卡片，等你确认", executed: "已执行", failed: "执行失败", confirmed: "执行中" };

export function Chat({ me, path }: { me: Me; path: string }) {
  const toast = useToast();
  const prompts = useLoad(() => api.get<{ settings: { prefs: { chatPrompts?: string[] } } }>("/v1/settings")
    .then((r) => r.settings.prefs.chatPrompts ?? EXAMPLES), []);
  const [turns, setTurns] = useState<Turn[]>(() => {
    try { return JSON.parse(sessionStorage.getItem(STORE) ?? "[]") as Turn[]; } catch { return []; }
  });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<{ key: string; stop: () => void } | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // 输入框跟着内容长高（先归零再按 scrollHeight 收，删字时才缩得回去）
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  useEffect(() => { try { sessionStorage.setItem(STORE, JSON.stringify(turns.slice(-40))); } catch { /* 无痕模式 */ } }, [turns]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [turns.length, busy]);
  useEffect(() => () => playing?.stop(), [playing]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const next = [...turns, { role: "user" as const, content }];
    setTurns(next); setDraft(""); setBusy(true);
    try {
      const r = await api.post<{ reply: string; citations: Citation[]; actions: ActionResult[]; links: Link[] }>("/v1/chat",
        { messages: next.map((t) => ({ role: t.role, content: t.content })) });
      setTurns([...next, { role: "assistant", content: r.reply, citations: r.citations, actions: r.actions, links: r.links }]);
    } catch (e) {
      toast(e instanceof Error ? e.message : "没有得到回答", true);
      setTurns(next);
    } finally { setBusy(false); }
  }

  async function play(c: Citation, key: string) {
    if (playing?.key === key) { playing.stop(); setPlaying(null); return; }
    playing?.stop();
    try {
      const tl = await api.get<{ timeline: { chunks: { sequence: number; startMs: number; durationMs: number }[] } }>(`/v1/sessions/${c.sessionId}/timeline`);
      const inRange = tl.timeline.chunks.filter((x) => x.startMs < Math.max(c.endMs, c.startMs + 1) && x.startMs + x.durationMs > c.startMs);
      if (!inRange.length) { toast("这一段的音频已经删了", true); return; }
      // 出处是一句话时播这句；是一整个主题时先播开头 30 秒，想听全就去录音页
      const last = inRange.find((x) => x.startMs >= c.startMs + 30_000) ?? inRange[inRange.length - 1]!;
      setPlaying({ key, ...playRun(c.sessionId, inRange[0]!.sequence, last.sequence, () => setPlaying(null)) });
    } catch (e) { toast(e instanceof Error ? e.message : "播放失败", true); }
  }

  return (
    <>
      <PageHead title="聊天" me={me} path={path}>
        {turns.length > 0 && <button className="btn" onClick={() => { playing?.stop(); setTurns([]); }}><Trash2 aria-hidden />清空</button>}
      </PageHead>
      <div className="work-body">
        <section className="sheet" aria-label="对话">
          <div className="chat-log">
            {turns.length === 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <p className="ink-2" style={{ fontSize: 15, maxWidth: "62ch" }}>
                  问录音里的事，它会去查你的转写和主题，回答带出处，点一下就能听原声。也可以让它办事：导出某一段、建飞书任务、记笔记。
                  办事会生成动作卡片，要不要先问你，和「我的 → 执行规则」一致。
                </p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {(prompts.data ?? EXAMPLES).map((e) => <button key={e} className="btn sm" onClick={() => void send(e)}>{e}</button>)}
                  <button className="btn sm flat" onClick={() => navigate("/app/me?group=ai")} title="在「我的 → AI 助手」里改">改快捷问题</button>
                </div>
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className={`chat-msg ${t.role}`}>
                {t.role === "assistant" ? <Markdown text={t.content} /> : t.content}
                {t.citations && t.citations.length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                    {t.citations.map((c, k) => {
                      const key = `${i}:${k}`;
                      return (
                        <button key={key} className="chat-cite" onClick={() => void play(c, key)} title="播放这段原声">
                          [{k + 1}] {playing?.key === key ? <Square aria-hidden size={12} /> : <Play aria-hidden size={12} />}{c.label}
                        </button>
                      );
                    })}
                  </div>
                )}
                {t.actions && t.actions.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                    {t.actions.map((a) => (
                      <div key={a.draftId} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 14 }}>
                        <span className="pill info">{toolLabel(a.tool)}</span><b style={{ fontWeight: 600 }}>{a.title}</b>
                        <span className={a.status === "failed" ? "error-text" : "ink-2"}>{STATUS[a.status] ?? a.status}</span>
                        {a.status === "pending" && <button className="btn sm" onClick={() => navigate("/app")}>去确认</button>}
                      </div>
                    ))}
                  </div>
                )}
                {t.links && t.links.length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                    {t.links.map((l) => <a key={l.url} className="btn sm" href={l.url} download><Download aria-hidden />{l.label}</a>)}
                  </div>
                )}
              </div>
            ))}
            {busy && <div className="chat-msg assistant ink-2">正在查录音……（通常 5–20 秒）</div>}
            <div ref={end} />
          </div>
          <form className="chat-form" onSubmit={(e) => { e.preventDefault(); void send(draft); }}>
            <div className="chat-box">
              <textarea ref={box} value={draft} rows={1} aria-label="输入问题" maxLength={2000}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder="问录音里的事，或者让它办事"
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(draft); } }} />
              <button className="btn go" type="submit" disabled={busy || !draft.trim()}><Send aria-hidden />发送</button>
            </div>
            <div className="chat-hint">回车发送，Shift + 回车换行。对话只留在这个浏览器里。</div>
          </form>
        </section>
      </div>
    </>
  );
}

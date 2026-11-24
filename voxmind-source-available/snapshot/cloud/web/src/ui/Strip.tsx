import { useEffect, useState } from "react";
import { Ban, Check, CircleSlash, CornerUpLeft, Info, Pencil, Play, Square, TriangleAlert } from "lucide-react";
import { api, audioUrl, type ActionDraft } from "../api.ts";
import { clock, hhmm, stamp, TIER_LABEL, tierOf, type Tier, toolLabel } from "../format.ts";
import type { ReactNode } from "react";
import { Modal, useToast } from "./kit.tsx";
import { navigate } from "../router.ts";

export interface StripDraft extends ActionDraft {
  expiresAt?: number | null;
  evidenceChunk?: number | null;
  pushToTalk?: boolean;
}

/** 每秒走一格的倒计时。到零时交给服务端去作废，这里只负责显示。 */
function useRemaining(expiresAt: number | null | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return expiresAt ? Math.max(0, Math.round((expiresAt - now) / 1000)) : null;
}

/* 同一时间只放一段原声，点第二张卡的回放会停掉第一张 */
let playing: HTMLAudioElement | null = null;

export function Strip({ draft, onSettled, arriving = false }: { draft: StripDraft; onSettled: (id: string) => void; arriving?: boolean }) {
  const toast = useToast();
  const tier = tierOf(draft.risk);
  const remaining = useRemaining(draft.expiresAt);
  const [busy, setBusy] = useState<"confirm" | "cancel" | "revise" | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(draft.title);
  const [detail, setDetail] = useState(draft.detail);
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  const [detail0, setDetail0] = useState(false);   // 详情弹窗
  const source = draft.sessionId && draft.evidenceChunk !== null && draft.evidenceChunk !== undefined
    ? audioUrl(draft.sessionId, draft.evidenceChunk) : null;

  useEffect(() => () => { audio?.pause(); }, [audio]);

  async function settle(verb: "confirm" | "cancel") {
    setBusy(verb);
    try {
      await api.post(`/v1/action-drafts/${draft.id}/${verb}`);
      toast(verb === "confirm" ? `已签放：${draft.title}` : `已退回：${draft.title}`);
      // 纸条先从架子上滑出去，再从列表里移除——和把单子抽出卡槽是同一个动作
      setLeaving(true);
      setTimeout(() => onSettled(draft.id), 220);
    } catch (e) {
      toast(e instanceof Error ? e.message : "操作失败", true);
      setBusy(null);
    }
  }

  async function saveRevision() {
    if (!title.trim()) { toast("标题不能为空", true); return; }
    setBusy("revise");
    try {
      await api.post(`/v1/action-drafts/${draft.id}/revise`, { title: title.trim(), detail: detail.trim() });
      draft.title = title.trim(); draft.detail = detail.trim();
      setEditing(false);
      toast("已修改，签放前请再核对一遍");
    } catch (e) {
      toast(e instanceof Error ? e.message : "修改失败", true);
    } finally { setBusy(null); }
  }

  function toggleAudio() {
    if (!source) return;
    if (audio && !audio.paused) { audio.pause(); setAudio(null); return; }
    playing?.pause();
    const el = new Audio(source);
    el.onended = () => setAudio(null);
    el.onerror = () => { toast("原声读取失败", true); setAudio(null); };
    void el.play();
    playing = el;
    setAudio(el);
  }

  const urgent = remaining !== null && remaining < 120;
  const lapsed = remaining === 0;   // 到点了，服务端的作废扫描半分钟内会收走它

  return (
    <article className={`strip ${leaving ? "leaving" : urgent ? "urgent" : ""} ${arriving ? "arriving" : ""}`}
             data-tier={tier} aria-label={`${TIER_LABEL[tier]}：${draft.title}`}>
      <div className="grip" aria-hidden>{TIER_LABEL[tier]}</div>
      <div className="paper">
        <div className="cell when">
          <span className="t">{hhmm(draft.createdAt)}</span>
          <span className="src">{draft.pushToTalk ? "按键说的" : draft.mode === "explicit" ? "明确说出" : "推测意图"}</span>
        </div>

        <div className="cell what">
          {editing ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="tool" style={{ alignSelf: "flex-start" }}>{toolLabel(draft.tool)}</span>
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="标题" maxLength={80} />
              <input type="text" value={detail} onChange={(e) => setDetail(e.target.value)} aria-label="说明" maxLength={500} placeholder="时间、参与人、地点" />
            </div>
          ) : (
            <>
              <div className="head"><span className="tool">{toolLabel(draft.tool)}</span><div className="title">{draft.title}</div></div>
              {draft.detail && <div className="detail">{draft.detail}</div>}
            </>
          )}
          <div className="said">
            {draft.evidence ? <q>{draft.evidence}</q> : <span className="ink-3">没有原话记录</span>}
            <span className="said-meta">
              {source && (
                <button className="btn sm flat" onClick={toggleAudio} aria-label={audio ? "停止回放" : "回放原声"}>
                  {audio ? <Square aria-hidden /> : <Play aria-hidden />}{audio ? "停止" : "原声"}
                </button>
              )}
              <span className="conf">把握 {Math.round(draft.confidence * 100)}%</span>
            </span>
          </div>
        </div>

        <div className="cell sign">
          {remaining === null
            ? <span className="clock none">不会作废</span>
            : lapsed
              ? <span className="clock urgent" style={{ fontSize: 15 }}>已过时限<small>正在作废</small></span>
              : <span className={`clock ${urgent ? "urgent" : ""}`} aria-label={`剩余 ${clock(remaining)}`}>
                  {clock(remaining)}<small>后作废</small>
                </span>}
          <div className="sign-row">
            {editing ? (
              <>
                <button className="btn sm" onClick={() => { setEditing(false); setTitle(draft.title); setDetail(draft.detail); }} disabled={busy !== null}>取消</button>
                <button className="btn sm go" onClick={() => void saveRevision()} disabled={busy !== null}>{busy === "revise" ? "保存中" : "保存"}</button>
              </>
            ) : (
              <>
                <button className="btn sm icon flat" onClick={() => setDetail0(true)} aria-label="详情" title="详情"><Info aria-hidden /></button>
                <button className="btn sm icon flat" onClick={() => setEditing(true)} disabled={busy !== null} aria-label="修改" title="修改"><Pencil aria-hidden /></button>
                <button className="btn sm no" onClick={() => void settle("cancel")} disabled={busy !== null}>
                  <CornerUpLeft aria-hidden />{busy === "cancel" ? "退回中" : "退回"}
                </button>
                <button className="btn sm go" onClick={() => void settle("confirm")} disabled={busy !== null || lapsed}>
                  <Check aria-hidden />{busy === "confirm" ? "签放中" : "签放"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      {detail0 && <StripDetail draft={draft} onClose={() => setDetail0(false)} />}
    </article>
  );
}

const VERDICT: Record<string, { text: string; tone: "ok" | "bad" | "muted"; icon: ReactNode; struck?: boolean }> = {
  executed:  { text: "已执行", tone: "ok", icon: <Check aria-hidden /> },
  succeeded: { text: "已执行", tone: "ok", icon: <Check aria-hidden /> },
  confirmed: { text: "已签放", tone: "ok", icon: <Check aria-hidden /> },
  executing: { text: "执行中", tone: "muted", icon: <Check aria-hidden /> },
  running:   { text: "执行中", tone: "muted", icon: <Check aria-hidden /> },
  queued:    { text: "排队中", tone: "muted", icon: <Check aria-hidden /> },
  failed:    { text: "执行失败", tone: "bad", icon: <TriangleAlert aria-hidden /> },
  unknown:   { text: "结果未知", tone: "bad", icon: <TriangleAlert aria-hidden /> },
  cancelled: { text: "已退回", tone: "muted", icon: <CornerUpLeft aria-hidden />, struck: true },
  expired:   { text: "已作废", tone: "muted", icon: <CircleSlash aria-hidden />, struck: true },
  revoked:   { text: "已吊销", tone: "bad", icon: <Ban aria-hidden /> },
};

/** 处理过的单子：卡槽灰掉，右端写下结论；退回和作废的把标题划掉，像铅笔划掉一样 */
export function DoneStrip({ draft }: { draft: StripDraft }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* 整张单子可以点开看详情——失败的单子要看原因和参数，就在这里 */}
      <div role="button" tabIndex={0} style={{ cursor: "pointer" }} onClick={() => setOpen(true)}
           onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(true); } }}
           aria-label={`查看详情：${draft.title}`}>
        <Receipt tier={tierOf(draft.risk)} time={draft.updatedAt} tool={draft.tool} title={draft.title}
                 status={draft.status} evidence={draft.evidence} />
      </div>
      {open && <StripDetail draft={draft} onClose={() => setOpen(false)} />}
    </>
  );
}

export function Receipt({ tier, time, tool, title, status, evidence, who, note, date }: {
  tier: Tier; time: string; tool: string; title: string; status: string;
  evidence?: string; who?: string; note?: string | null; date?: string;
}) {
  const v = VERDICT[status] ?? { text: status, tone: "muted" as const, icon: null };
  return (
    <article className="strip done" data-tier={tier}>
      <div className="grip" aria-hidden>{TIER_LABEL[tier]}</div>
      <div className="paper">
        <div className="cell when">
          <span className="t">{hhmm(time)}</span>
          {date && <span className="src">{date}</span>}
        </div>
        <div className="cell what">
          <div className="head"><span className="tool">{toolLabel(tool)}</span><div className={`title ${v.struck ? "struck" : ""}`}>{title}</div></div>
          {who && <div className="who">{who}</div>}
          {evidence && <div className="said"><q>{evidence}</q></div>}
        </div>
        <div className="cell sign" style={{ flexDirection: "column", alignItems: "flex-end", justifyContent: "center", gap: 4 }}>
          <span className={`verdict ${v.tone}`}>{v.icon}{v.text}</span>
          {note && <span className="receipt" style={{ color: v.tone === "bad" ? "var(--bad)" : undefined }}>{note}</span>}
        </div>
      </div>
    </article>
  );
}

/* 任务详情：卡片上放不下的东西都在这——原样的参数、证据时间点、两次时间戳。
 * 参数是真正发给飞书/日历的内容，出问题时先看这里。*/
export function StripDetail({ draft, onClose }: { draft: StripDraft; onClose: () => void }) {
  const v = VERDICT[draft.status] ?? { text: draft.status, tone: "muted" as const, icon: null };
  const args = Object.entries(draft.args ?? {});
  return (
    <Modal title="任务详情" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className="pill info">{toolLabel(draft.tool)}</span>
            <span className="pill">{TIER_LABEL[tierOf(draft.risk)]}</span>
            <span className={`verdict ${v.tone}`}>{v.icon}{draft.status === "pending" ? "等你确认" : v.text}</span>
          </div>
          <h3 style={{ margin: "8px 0 0", fontSize: 17 }}>{draft.title}</h3>
          {draft.detail && <p className="ink-2" style={{ margin: "4px 0 0" }}>{draft.detail}</p>}
        </div>

        {args.length > 0 && (
          <div>
            <div className="ink-3" style={{ fontSize: 13, marginBottom: 6 }}>实际发出去的内容</div>
            <dl className="kv">
              {args.map(([k, val]) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt className="mono">{k}</dt>
                  <dd>{typeof val === "string" ? val : JSON.stringify(val)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        <div>
          <div className="ink-3" style={{ fontSize: 13, marginBottom: 6 }}>依据的原话</div>
          {draft.evidence ? <q>{draft.evidence}</q> : <span className="ink-3">没有原话记录</span>}
        </div>

        <dl className="kv">
          <dt>来源</dt><dd>{draft.mode === "explicit" ? "明确说出" : "推测意图"} · 把握 {Math.round(draft.confidence * 100)}%</dd>
          <dt>生成</dt><dd>{stamp(draft.createdAt)}</dd>
          <dt>最后更新</dt><dd>{stamp(draft.updatedAt)}{draft.revision > 1 ? ` · 改过 ${draft.revision - 1} 次` : ""}</dd>
        </dl>

        {draft.sessionId && (
          <button className="btn sm" style={{ alignSelf: "flex-start" }}
                  onClick={() => { onClose(); navigate(`/app/recordings?session=${draft.sessionId}`); }}>
            打开这段录音
          </button>
        )}
      </div>
    </Modal>
  );
}

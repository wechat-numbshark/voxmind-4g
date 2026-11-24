import { useEffect, useMemo, useState } from "react";
import { CopyForAi } from "./CopyForAi.tsx";
import { Download, FileText, Play, Square, Trash2 } from "lucide-react";
import { api } from "../api.ts";
import { clock } from "../format.ts";
import { LoadError, playRun, Skeleton, useLoad, useToast, useWidth } from "./kit.tsx";

interface ChunkWave { sequence: number; startMs: number; durationMs: number; envelope: string | null; kind: string | null; text: string }

/* 录音波形与切片。
 *
 * 波形来自服务端存的音量包络（每 200ms 一个字节），不用下载音频就能画整段录音——
 * 一小时录音的包络只有 18KB，而音频有几十 MB。
 * 拖选一段后可以试听、导出或删除；删除不可逆，所以要按两次。*/
export interface WaveBand { id: string; startMs: number; endMs: number }
export interface WaveSelection { from: number; to: number }

/* bands：主题的时间段，画在波形上方一条细带里；select：外面要求选中某一段（比如"调整这个主题的范围"），
 * key 变了才生效；onSelection：选区变化告诉外面（"用选中范围新建主题"要用）。*/
export function Wave({ sessionId, startedAt, onChanged, bands = [], activeBand = null, select = null, onSelection }: {
  sessionId: string; startedAt: string; onChanged: () => void;
  bands?: WaveBand[]; activeBand?: string | null; select?: (WaveSelection & { key: string }) | null;
  onSelection?: (sel: WaveSelection | null) => void;
}) {
  const toast = useToast();
  const [boxRef, W] = useWidth(240);
  const [sel, setSel] = useState<{ from: number; to: number } | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [playing, setPlaying] = useState<{ stop: () => void } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { if (select) setSel({ from: select.from, to: select.to }); }, [select?.key]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (drag === null) onSelection?.(sel); }, [sel, drag]);                        // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const wave = useLoad(() => api.get<{ chunks: ChunkWave[] }>(`/v1/sessions/${sessionId}/waveform`).then((r) => r.chunks), [sessionId]);

  const BAND = bands.length ? 10 : 0;         // 主题带的高度；没有主题就不占地方
  const H = 64 + BAND, PAD = 2;
  const chunks = wave.data ?? [];
  const totalMs = chunks.length ? chunks[chunks.length - 1]!.startMs + chunks[chunks.length - 1]!.durationMs : 0;

  /** 把所有包络铺到屏幕宽度上：每一列取这段时间里的最大值 */
  const bars = useMemo(() => {
    if (!totalMs || !chunks.length) return [];
    const cols = new Array<number>(Math.max(1, Math.floor(W))).fill(-1);   // -1＝这段时间没有音频（已删或缺块）
    for (const c of chunks) {
      if (!c.envelope) continue;
      const bytes = atob(c.envelope);
      const step = bytes.length ? c.durationMs / bytes.length : 0;
      for (let i = 0; i < bytes.length; i++) {
        const x = Math.floor(((c.startMs + i * step) / totalMs) * cols.length);
        if (x >= 0 && x < cols.length) cols[x] = Math.max(cols[x]!, bytes.charCodeAt(i));
      }
    }
    return cols;
  }, [chunks, totalMs, W]);

  /* 按这段录音自身的最大音量缩放。设备录音整体电平很低（实测人声峰值常在 -50dBFS
   * 上下），按绝对值画出来是一条直线，等于没有波形；缩放后才能看出哪里有人说话。*/
  const peak = Math.max(8, ...bars);

  const xToMs = (x: number) => Math.max(0, Math.min(totalMs, Math.round((x / Math.max(1, W)) * totalMs)));
  const msToX = (ms: number) => (ms / Math.max(1, totalMs)) * W;

  function onDown(e: React.PointerEvent<SVGSVGElement>) {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    setDrag(xToMs(x));
    setSel(null);
    setConfirmDelete(false);
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    if (drag === null) return;
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const ms = xToMs(x);
    setSel({ from: Math.min(drag, ms), to: Math.max(drag, ms) });
  }
  function onUp() {
    setDrag(null);
    // 拖得太短当成点一下，取消选择
    if (sel && sel.to - sel.from < 500) setSel(null);
  }

  function togglePlay() {
    if (playing) { playing.stop(); setPlaying(null); return; }
    if (!sel) return;
    const inRange = chunks.filter((c) => c.startMs < sel.to && c.startMs + c.durationMs > sel.from);
    if (!inRange.length) { toast("这一段没有音频", true); return; }
    setPlaying(playRun(sessionId, inRange[0]!.sequence, inRange[inRange.length - 1]!.sequence, () => setPlaying(null)));
  }

  const range = sel ? `?from=${sel.from}&to=${sel.to}` : "";



  async function doDelete() {
    if (!sel) return;
    setBusy(true);
    try {
      const res = await fetch(`/v1/sessions/${sessionId}/audio${range}`, { method: "DELETE", credentials: "same-origin" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as { error?: string }).error ?? "删除失败");
      toast(`已删除这 ${clock(Math.round((sel.to - sel.from) / 1000))} 的录音`);
      setSel(null); setConfirmDelete(false);
      await wave.reload();
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "删除失败", true);
    } finally { setBusy(false); }
  }

  if (wave.error && !wave.data) return <LoadError error={wave.error} onRetry={() => void wave.reload()} />;
  if (!wave.data) return <Skeleton h={H + 40} />;
  if (!totalMs) return <p className="ink-2" style={{ fontSize: 14 }}>这段会话没有音频可以切。</p>;

  const startedMs = Date.parse(startedAt);
  const at = (ms: number) => new Date(startedMs + ms).toLocaleTimeString("zh-CN", { hour12: false });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      {/* 宽度固定跟父级走：否则里面的 SVG 会把这个容器撑大，量到的宽度又让 SVG 更宽 */}
      <div ref={boxRef} style={{ position: "relative", userSelect: "none", width: "100%", minWidth: 0, overflow: "hidden" }}>
        <svg width={W} height={H} style={{ display: "block", cursor: "crosshair", touchAction: "none" }}
             onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
             role="img" aria-label={`录音波形，共 ${clock(Math.round(totalMs / 1000))}，可拖选一段`}>
          <rect x={0} y={0} width={W} height={H} fill="var(--paper-2)" />
          {bands.map((b, i) => (
            <rect key={b.id} x={msToX(b.startMs) + 1} y={1} width={Math.max(2, msToX(b.endMs) - msToX(b.startMs) - 2)} height={BAND - 3} rx={2}
                  fill={b.id === activeBand ? "var(--act)" : i % 2 ? "var(--rule-strong)" : "var(--tier-own)"} opacity={b.id === activeBand ? 1 : 0.55} />
          ))}
          {sel && <rect x={msToX(sel.from)} y={0} width={Math.max(1, msToX(sel.to) - msToX(sel.from))} height={H} fill="var(--act-tint)" />}
          {bars.map((v, i) => {
            if (v < 0) return null;                       // 没有音频的时间段：留白
            const h = Math.max(1, (v / peak) * (H - BAND - PAD * 2));
            const inSel = sel !== null && xToMs(i) >= sel.from && xToMs(i) <= sel.to;
            return <rect key={i} x={i} y={BAND + (H - BAND - h) / 2} width={1} height={h} fill={inSel ? "var(--act)" : "var(--rule-strong)"} />;
          })}
          <line x1={0} x2={W} y1={BAND + (H - BAND) / 2} y2={BAND + (H - BAND) / 2} stroke="var(--rule)" strokeWidth="1" />
        </svg>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 13 }}>
        {sel ? (
          <>
            <span className="mono" style={{ fontWeight: 600 }}>{at(sel.from)} – {at(sel.to)}</span>
            <span className="ink-2">共 {clock(Math.round((sel.to - sel.from) / 1000))}</span>
            <button className="btn sm" onClick={togglePlay}>
              {playing ? <Square aria-hidden /> : <Play aria-hidden />}{playing ? "停止" : "试听"}
            </button>
            <a className="btn sm" href={`/v1/sessions/${sessionId}/export.wav${range}`} download>
              <Download aria-hidden />导出音频
            </a>
            <a className="btn sm" href={`/v1/sessions/${sessionId}/export.txt${range}`} download>
              <FileText aria-hidden />导出文字
            </a>
            <CopyForAi sessionId={sessionId} from={sel.from} to={sel.to} what="一段录音里选中的这一截" />
            {confirmDelete ? (
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <span className="ink-2">删掉这段音频和它的转写，不可恢复</span>
                <button className="btn sm no" onClick={() => void doDelete()} disabled={busy}>{busy ? "删除中" : "确认删除"}</button>
                <button className="btn sm" onClick={() => setConfirmDelete(false)} disabled={busy}>取消</button>
              </span>
            ) : (
              <button className="btn sm no" onClick={() => setConfirmDelete(true)}><Trash2 aria-hidden />删除这一段</button>
            )}
          </>
        ) : (
          <>
            <span className="ink-2">在波形上拖选一段，可以试听、导出或删除。</span>
            <a className="btn sm" href={`/v1/sessions/${sessionId}/export.txt`} download><FileText aria-hidden />导出全文</a>
            <CopyForAi sessionId={sessionId} />
          </>
        )}
      </div>
    </div>
  );
}

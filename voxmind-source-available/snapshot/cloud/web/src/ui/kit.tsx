import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import { STATUS_LABEL } from "../format.ts";
import { audioUrl } from "../api.ts";

/* 播放速度：全站共用一个，记在这个浏览器里。倍速时保持音高（浏览器默认），不会变成"唐老鸭" */
const RATE_KEY = "voxmind:rate";
export const RATES = [1, 1.25, 1.5, 2] as const;
export function getRate(): number {
  try { const v = Number(localStorage.getItem(RATE_KEY)); return RATES.includes(v as never) ? v : 1; } catch { return 1; }
}
export function setRate(v: number) { try { localStorage.setItem(RATE_KEY, String(v)); } catch { /* 无痕模式 */ } }

/** 按顺序播放一串录音块（中间可以跳号——连播时静音块直接不在列表里，就是"跳过静音"）。
 *  onAdvance 每开始一块回调一次，界面用来高亮正在播的那句。返回的 stop() 随时可停 */
export function playList(sessionId: string, seqs: number[], onDone: () => void, onAdvance?: (seq: number) => void) {
  let current: HTMLAudioElement | null = null, stopped = false;
  /* 播这一块的同时把下一块先要过来：选了 AI 降噪时服务器第一次处理一块要 2 秒多，不预取的话每块之间都会停一下 */
  const prepared = new Map<number, HTMLAudioElement>();
  const prepare = (i: number) => {
    if (i >= seqs.length || prepared.has(i)) return prepared.get(i);
    const a = new Audio(audioUrl(sessionId, seqs[i]!));
    a.preload = "auto";
    prepared.set(i, a);
    return a;
  };
  const play = (i: number) => {
    if (stopped) return;
    if (i >= seqs.length) { onDone(); return; }
    current = prepare(i)!;
    prepared.delete(i);
    current.playbackRate = getRate();
    current.onended = () => play(i + 1);
    current.onerror = () => onDone();
    onAdvance?.(seqs[i]!);
    void current.play();
    prepare(i + 1);
  };
  play(0);
  return {
    stop: () => { stopped = true; current?.pause(); prepared.clear(); },
    /** 播放中改倍速立刻生效 */
    setRate: (v: number) => { if (current) current.playbackRate = v; },
  };
}

/** 实时收听：从某一块开始一直往后播，下一块还没传上来就每 2 秒再要一次，到了接着播。
 *  设备录满一块（默认 15 秒）才上传，所以比现场慢 20 秒左右；回放选了 AI 降噪再多 2 秒左右（首次处理）。*/
export function playLive(sessionId: string, fromSeq: number, onAdvance: (seq: number) => void, onWaiting: (waiting: boolean) => void) {
  let current: HTMLAudioElement | null = null, stopped = false, timer = 0;
  const play = (seq: number) => {
    if (stopped) return;
    const a = new Audio(audioUrl(sessionId, seq));
    current = a;
    a.onplaying = () => { onWaiting(false); onAdvance(seq); };
    a.onended = () => play(seq + 1);
    /* 还没传上来（404）：等一会儿再要同一块 */
    a.onerror = () => { if (stopped) return; onWaiting(true); timer = window.setTimeout(() => play(seq), 2000); };
    void a.play().catch(() => { /* 出错走 onerror */ });
  };
  play(fromSeq);
  return { stop: () => { stopped = true; window.clearTimeout(timer); current?.pause(); } };
}

/** 连着播放一句话覆盖的几段录音（一句最多拼 6 段）。返回的 stop() 随时可停 */
export function playRun(sessionId: string, from: number, to: number, onDone: () => void) {
  const seqs: number[] = [];
  for (let s = from; s <= to; s++) seqs.push(s);
  return playList(sessionId, seqs, onDone);
}

/* ── 品牌标：圆环里两道竖线，与设备屏和旧控制台一致 ── */
export function BrandMark({ className = "brand-mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10.5" stroke="currentColor" strokeWidth="2" />
      <path d="M9 7.5v9M15 7.5v9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/* ── 录音状态灯。只由真实上传时间推出来，不写"应该在录" ── */
export function RecLight({ lastUploadAt }: { lastUploadAt: string | null | undefined }) {
  const age = lastUploadAt ? (Date.now() - Date.parse(lastUploadAt)) / 1000 : Infinity;
  // 设备每 5 秒一块，4G 抖动时会攒一会儿再补传；2 分钟内有新块就算在录
  if (age < 120) return <span className="rec live"><i />录音上云中</span>;
  if (age < 3600) return <span className="rec stale"><i />{Math.round(age / 60)} 分钟没有新录音</span>;
  return <span className="rec off"><i />设备未在上传</span>;
}

export function Pill({ status }: { status: string }) {
  const s = STATUS_LABEL[status] ?? { text: status, tone: "" };
  return <span className={`pill ${s.tone}`}><i />{s.text}</span>;
}

/* ── 数据加载：可选轮询，出错保留上一次数据 ── */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[], pollMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const reload = useCallback(async () => {
    try { setData(await loaderRef.current()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => {
    setData(null);
    void reload();
    if (!pollMs) return;
    const timer = setInterval(() => { if (!document.hidden) void reload(); }, pollMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, reload, setData };
}

/* ── 翻页：列表不再无限往下叠。页码最多露 10 个，当前页尽量在中间 ── */
export function usePaged<T>(items: T[] | null | undefined, size: number, resetKey?: unknown) {
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [resetKey]);
  const pages = Math.max(1, Math.ceil((items?.length ?? 0) / size));
  const cur = Math.min(page, pages - 1);
  return { page: cur, pages, setPage, slice: (items ?? []).slice(cur * size, cur * size + size) };
}

export function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  const start = Math.max(0, Math.min(page - 4, pages - 10));
  const nums = Array.from({ length: Math.min(10, pages - start) }, (_, i) => start + i);
  return (
    <nav aria-label="翻页" style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "center", flexWrap: "wrap", padding: "10px 0" }}>
      <button className="btn sm" disabled={page === 0} onClick={() => onPage(page - 1)}>上一页</button>
      {nums.map((n) => (
        <button key={n} className="btn sm" aria-pressed={n === page} aria-current={n === page ? "page" : undefined}
                style={{ minWidth: 34 }} onClick={() => onPage(n)}>{n + 1}</button>
      ))}
      <button className="btn sm" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>下一页</button>
      <span className="ink-3" style={{ fontSize: 13 }}>共 {pages} 页</span>
    </nav>
  );
}

/* ── 提示条 ── */
interface Toast { id: number; text: string; bad: boolean }
const ToastContext = createContext<(text: string, bad?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, bad = false) => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all, { id, text, bad }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), bad ? 5000 : 2600);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.bad ? "bad" : ""}`}>
            {t.bad ? <AlertTriangle aria-hidden /> : <Check aria-hidden />}{t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** 按容器实际像素宽度画图：SVG 不整体缩放，里面的字在哪都是真字号。
 *  用回调 ref：容器常常要等数据到了才出现，挂载时还不存在。*/
export function useWidth(min = 280) {
  const [width, setWidth] = useState(720);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    if (!el) return;
    observer.current = new ResizeObserver(([e]) => setWidth(Math.max(min, Math.round(e!.contentRect.width))));
    observer.current.observe(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min]);
  return [ref, width] as const;
}

export function Skeleton({ h = 16, w = "100%" }: { h?: number; w?: number | string }) {
  return <div className="skel" style={{ height: h, width: w }} aria-hidden />;
}

export function LoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="notice" role="alert">
      <AlertTriangle aria-hidden />
      <div style={{ flex: 1 }}>没能读取数据：{error}</div>
      <button className="btn sm" onClick={onRetry}>重试</button>
    </div>
  );
}

export function IconClose() { return <X aria-hidden />; }

/* 弹出层：点背景或按 Esc 关掉。用在「任务详情」这种看一眼就走的地方。 */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose} role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2 style={{ fontSize: 16 }}>{title}</h2>
          <div className="end"><button className="btn sm icon flat" onClick={onClose} aria-label="关闭"><IconClose /></button></div>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

import { useState } from "react";
import { Bot, Copy } from "lucide-react";
import { api } from "../api.ts";
import { Modal, useLoad, useToast } from "./kit.tsx";

/* 「复制给 AI」：生成一个带密钥的只读链接（默认 7 天有效），连同一句说明一起复制。
 * 贴给任何 AI 助手，它打开链接就能读到这一段（或其中一个主题、选中的一截）的全文，不用登录。
 *
 * iPhone Safari 只允许在点按的那一刻写剪贴板，先去服务器要链接再写会被拒——所以点按时就把
 * 「将来的文字」交给剪贴板（ClipboardItem 接受 Promise）；不支持或失败就弹框让人手动复制。*/

function promptFor(url: string, what: string) {
  return `请先打开下面这个链接，读取我${what}的完整文字稿（随身录音设备自动转写，可能有同音错字），然后按我接下来的要求处理：\n${url}\n（链接里带访问密钥，7 天内有效，不需要登录。）`;
}

export function CopyForAi({ sessionId, folderId, from, to, what = "一段录音", label = "复制给 AI" }: {
  /** 分享一段录音，或者整个收藏文件夹（给 folderId） */
  sessionId?: string; folderId?: string; from?: number | undefined; to?: number | undefined; what?: string; label?: string;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState<string | null>(null);

  async function make() {
    const body: Record<string, number> = {};
    if (from !== undefined) body.from = Math.round(from);
    if (to !== undefined) body.to = Math.round(to);
    const r = await api.post<{ url: string }>(folderId ? `/v1/favorite-folders/${folderId}/share` : `/v1/sessions/${sessionId}/share`, body);
    return promptFor(r.url, what);
  }

  async function copy() {
    setBusy(true);
    const text = make();
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
      } else {
        await navigator.clipboard.writeText(await text);
      }
      toast("已复制。粘贴给 AI 就能读到全文（7 天内有效）");
    } catch {
      try { setManual(await text); }                     // 剪贴板被浏览器拦了：弹框手动复制
      catch (e) { toast(e instanceof Error ? e.message : "生成链接失败", true); }
    } finally { setBusy(false); }
  }

  return (
    <>
      <button className="btn sm" onClick={() => void copy()} disabled={busy} title="生成一个带密钥的只读链接，贴给 AI 就能读全文">
        <Bot aria-hidden />{busy ? "生成中" : label}
      </button>
      {manual && (
        <Modal title="复制给 AI" onClose={() => setManual(null)}>
          <p className="ink-2" style={{ fontSize: 14, marginTop: 0 }}>浏览器没让自动复制，长按下面的文字全选复制，再贴给 AI：</p>
          <textarea readOnly value={manual} rows={6} style={{ width: "100%" }} onFocus={(e) => e.currentTarget.select()} autoFocus />
        </Modal>
      )}
    </>
  );
}

/** 这一段已经分享出去、还有效的链接：能看被读了几次，能撤销 */
export function ShareLinks({ sessionId }: { sessionId: string }) {
  const toast = useToast();
  const list = useLoad(() => api.get<{ shares: { id: string; fromMs: number; toMs: number | null; expiresAt: string; revokedAt: string | null; uses: number }[] }>(
    `/v1/shares?sessionId=${sessionId}`).then((r) => r.shares.filter((s) => !s.revokedAt && Date.parse(s.expiresAt) > Date.now())), [sessionId], 60_000);
  const live = list.data ?? [];
  if (!live.length) return null;
  async function revoke(id?: string) {
    try {
      for (const s of id ? live.filter((x) => x.id === id) : live) await api.del(`/v1/shares/${s.id}`);
      toast(id ? "已撤销，这个链接打不开了" : "已全部撤销");
      void list.reload();
    } catch (e) { toast(e instanceof Error ? e.message : "撤销失败", true); }
  }
  return (
    <div className="ink-2" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
      <Copy size={13} aria-hidden />这一段有 {live.length} 个给 AI 的链接还有效
      （共被读取 {live.reduce((n, s) => n + s.uses, 0)} 次）
      <button className="btn sm flat" onClick={() => { if (confirm("撤销这一段所有给 AI 的链接？撤销后链接立刻打不开。")) void revoke(); }}>全部撤销</button>
    </div>
  );
}

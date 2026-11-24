import { useState } from "react";
import { Check, X } from "lucide-react";
import { api } from "../api.ts";
import { hhmm, toolLabel } from "../format.ts";
import { useToast } from "./kit.tsx";

/* 「看出来了但没替你做的」。
 * 按住模式下没按键说的话，系统照样看得见，只是不动手——这里列出来，点一下才真的建。
 * 采纳走的是和说话、聊天一样的执行规则，所以该问你的还是会先问。*/

export interface Suggestion {
  id: string; sessionId: string; topicId: string | null; tool: string; title: string; detail: string;
  args: Record<string, unknown>; evidence: string; confidence: number;
  status: "open" | "accepted" | "dismissed"; draftId: string | null; createdAt: string;
}

export function SuggestionRow({ s, onSettled, showTime = false, selected, onSelect }: {
  s: Suggestion; onSettled: (id: string) => void; showTime?: boolean;
  /** 给了 onSelect 就在最前面多一个勾选框（任务中心批量忽略用） */
  selected?: boolean; onSelect?: (v: boolean) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<"accept" | "dismiss" | null>(null);

  async function act(verb: "accept" | "dismiss") {
    setBusy(verb);
    try {
      const r = await api.post<{ draft?: { status: string } }>(`/v1/suggestions/${s.id}/${verb}`);
      toast(verb === "dismiss" ? "已忽略"
        : r.draft?.status === "pending" ? "已生成卡片，去「今天」确认" : `已建：${s.title}`);
      onSettled(s.id);
    } catch (e) { toast(e instanceof Error ? e.message : "操作失败", true); setBusy(null); }
  }

  const amount = Number(s.args.amount);
  return (
    <li className={`sug-row${onSelect ? " pick" : ""}${showTime ? " timed" : ""}`}>
      {onSelect && <input type="checkbox" checked={!!selected} onChange={(e) => onSelect(e.target.checked)}
                          aria-label={`选中：${s.title}`} style={{ alignSelf: "center" }} />}
      {showTime && <time>{hhmm(s.createdAt)}</time>}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {showTime && <span className="sug-time mono ink-3">{hhmm(s.createdAt)}</span>}
          <span className="pill info">{toolLabel(s.tool)}</span>
          <b style={{ fontWeight: 600 }}>{s.title}</b>
          {Number.isFinite(amount) && <span className="mono">{amount} 元</span>}
        </div>
        {s.evidence && <div className="ink-3" style={{ fontSize: 13, marginTop: 3 }}><q>{s.evidence}</q></div>}
      </div>
      <div className="sug-actions" style={{ display: "flex", gap: 6 }}>
        <button className="btn sm go" disabled={busy !== null} onClick={() => void act("accept")}>
          <Check aria-hidden />{busy === "accept" ? "建中" : "建"}
        </button>
        <button className="btn sm" disabled={busy !== null} onClick={() => void act("dismiss")}>
          <X aria-hidden />忽略
        </button>
      </div>
    </li>
  );
}

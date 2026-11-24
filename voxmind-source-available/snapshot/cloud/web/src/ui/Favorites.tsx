import { useRef, useState } from "react";
import { Check, FolderPlus, Star } from "lucide-react";
import { api } from "../api.ts";
import { useLoad, useToast } from "./kit.tsx";

/* 收藏：录音（一段）可以加星，也可以放进自己建的文件夹；一段可以同时在几个文件夹里。
 * 聊天里也能让 AI 整理：「把和张总相关的录音放进收藏里新建一个文件夹」。*/

export interface FavFolder { id: string; name: string; count: number; keywords: string[] }
export interface FavItem { sessionId: string; folderIds: string[]; favoritedAt: string }
export interface FavData<S> { folders: FavFolder[]; items: FavItem[]; sessions: S[] }

export function useFavorites<S>() {
  const toast = useToast();
  const data = useLoad(() => api.get<FavData<S>>("/v1/favorites"), [], 60_000);
  const items = data.data?.items ?? [];
  const has = (sessionId: string) => items.some((i) => i.sessionId === sessionId);
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    try { await fn(); if (done) toast(done); await data.reload(); }
    catch (e) { toast(e instanceof Error ? e.message : "操作失败", true); }
  };
  return {
    data: data.data, reload: data.reload, has,
    folderIdsOf: (sessionId: string) => items.find((i) => i.sessionId === sessionId)?.folderIds ?? [],
    toggleStar: (sessionId: string) => run(() => has(sessionId) ? api.del(`/v1/favorites/${sessionId}`) : api.put(`/v1/favorites/${sessionId}`, {}),
      has(sessionId) ? "已取消收藏" : "已收藏"),
    setInFolder: (folderId: string, sessionId: string, on: boolean) =>
      run(() => on ? api.put(`/v1/favorite-folders/${folderId}/items/${sessionId}`, {}) : api.del(`/v1/favorite-folders/${folderId}/items/${sessionId}`)),
    createFolder: async (name: string, sessionId?: string) => {
      await run(async () => {
        const { folder } = await api.post<{ folder: { id: string } }>("/v1/favorite-folders", { name });
        if (sessionId) await api.put(`/v1/favorite-folders/${folder.id}/items/${sessionId}`, {});
      }, `已建文件夹「${name}」`);
    },
    renameFolder: (id: string, name: string) => run(() => api.patch(`/v1/favorite-folders/${id}`, { name }), "已改名"),
    /** 自动归档关键词：空数组＝关掉。设了马上把以前的录音过一遍 */
    setKeywords: async (id: string, keywords: string[]) => {
      try {
        const r = await api.patch<{ added?: number }>(`/v1/favorite-folders/${id}`, { keywords });
        toast(keywords.length ? `已设自动归档，刚收进 ${r.added ?? 0} 段；以后提到这些词的录音会自动放进来` : "已关掉自动归档");
        await data.reload();
      } catch (e) { toast(e instanceof Error ? e.message : "设置失败", true); }
    },
    deleteFolder: (id: string) => run(() => api.del(`/v1/favorite-folders/${id}`), "文件夹已删除，里面的录音还在收藏里"),
  };
}
export type Favorites = ReturnType<typeof useFavorites<unknown>>;

export function StarButton({ on, onClick, size = "sm" }: { on: boolean; onClick: () => void; size?: "sm" | "md" }) {
  return (
    <button className={`btn ${size === "sm" ? "sm " : ""}icon flat`} onClick={(e) => { e.stopPropagation(); onClick(); }}
            aria-pressed={on} aria-label={on ? "取消收藏" : "收藏"} title={on ? "取消收藏" : "收藏这一段"}>
      <Star aria-hidden fill={on ? "currentColor" : "none"} style={{ color: on ? "var(--tier-ext, #d9a400)" : undefined }} />
    </button>
  );
}

/** 录音详情里：加星 + 放进哪些文件夹（可多选）+ 就地新建文件夹 */
export function FavoriteControl({ sessionId, fav }: { sessionId: string; fav: Favorites }) {
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const [name, setName] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  /* 弹框往哪边开：右边放得下就往右，不然往左（手机上按钮靠左，往左开会出屏） */
  const toggle = () => {
    const r = anchor.current?.getBoundingClientRect();
    if (r) setAlignRight(r.left + 240 > window.innerWidth);
    setOpen(!open);
  };
  const inFolders = fav.folderIdsOf(sessionId);
  return (
    <span style={{ position: "relative", display: "inline-flex", gap: 4, alignItems: "center" }}>
      <StarButton on={fav.has(sessionId)} onClick={() => void fav.toggleStar(sessionId)} size="md" />
      <button ref={anchor} className="btn sm" onClick={toggle} aria-expanded={open}>
        <FolderPlus aria-hidden />{inFolders.length ? `在 ${inFolders.length} 个文件夹` : "放进文件夹"}
      </button>
      {open && (
        <div className="sheet" role="dialog" aria-label="放进文件夹"
             style={{ position: "absolute", ...(alignRight ? { right: 0 } : { left: 0 }), top: "110%", zIndex: 20, minWidth: 220,
                      maxWidth: "calc(100vw - 32px)", padding: 10, display: "grid", gap: 6, boxShadow: "0 6px 24px rgba(0,0,0,.12)" }}>
          {(fav.data?.folders ?? []).map((f) => {
            const on = inFolders.includes(f.id);
            return (
              <button key={f.id} className="nav" onClick={() => void fav.setInFolder(f.id, sessionId, !on)}
                      style={{ display: "flex", gap: 8, alignItems: "center", borderRadius: 6, padding: "6px 8px" }}>
                <span style={{ width: 16 }}>{on && <Check size={15} aria-hidden />}</span>{f.name}
                <span className="ink-3" style={{ marginLeft: "auto", fontSize: 12 }}>{f.count}</span>
              </button>
            );
          })}
          {!fav.data?.folders.length && <span className="ink-3" style={{ fontSize: 13 }}>还没有文件夹，新建一个：</span>}
          <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) { void fav.createFolder(name.trim(), sessionId); setName(""); } }}
                style={{ display: "flex", gap: 6 }}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="新文件夹名" maxLength={40} aria-label="新文件夹名" />
            <button className="btn sm go" type="submit" disabled={!name.trim()}>建</button>
          </form>
        </div>
      )}
    </span>
  );
}

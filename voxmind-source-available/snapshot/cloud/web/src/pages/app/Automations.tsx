import { useState } from "react";
import { CalendarClock, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { api, type Me } from "../../api.ts";
import { stamp } from "../../format.ts";
import { LoadError, Modal, Skeleton, useLoad, useToast } from "../../ui/kit.tsx";
import { PageHead } from "../../ui/Shell.tsx";

/* 自动化：到点自己做一件事。
 * 时间都按北京时间。到点不再弹卡片问你——是你自己定的，直接做；做过什么在「任务中心」里查。
 * 也可以对着设备说「每天早上八点提醒我量体重」，那样建出来的会标上「说出来的」。*/

interface Schedule { kind: "daily" | "weekly" | "monthly" | "once"; time: string; weekday?: number; day?: number; date?: string }
interface Action { kind: "tool" | "daily_summary" | "expense_summary"; tool: string; args: Record<string, unknown> }
interface Automation {
  id: string; title: string; enabled: boolean; schedule: Schedule; action: Action;
  source: "web" | "voice" | "chat"; lastRunAt: string | null; lastStatus: string; nextRunAt: string; scheduleLabel: string;
}

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const DO_KINDS = [
  { value: "task", label: "建一个飞书任务", hint: "出现在飞书「任务 → 我负责的」里" },
  { value: "message", label: "给飞书发一条消息", hint: "发给你自己或某个群，需要填接收者 ID" },
  { value: "note", label: "记一条笔记", hint: "只存在 VoxMind 里，不发出去" },
  { value: "daily_summary", label: "写今天的小结", hint: "把当天的主题和待办汇成一页；填了接收者就发到飞书" },
  { value: "expense_summary", label: "汇总最近的消费", hint: "从记账的多维表格里按类别加总，发给你。不花模型钱" },
] as const;
type DoKind = (typeof DO_KINDS)[number]["value"];

/** 表单里的一条：把库里的结构摊平成好填的字段 */
interface Draft {
  id?: string; title: string; repeat: Schedule["kind"]; time: string; weekday: number; day: number; date: string;
  kind: DoKind; text: string; receiveId: string; days: number;
}

const EMPTY: Draft = { title: "", repeat: "daily", time: "08:00", weekday: 1, day: 1,
  date: new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10), kind: "task", text: "", receiveId: "", days: 7 };

function toDraft(a: Automation): Draft {
  const args = a.action.args ?? {};
  const kind: DoKind = a.action.kind === "daily_summary" ? "daily_summary"
    : a.action.kind === "expense_summary" ? "expense_summary"
    : a.action.tool === "feishu.message.send" ? "message" : a.action.tool === "note.create" ? "note" : "task";
  return {
    id: a.id, title: a.title, repeat: a.schedule.kind, time: a.schedule.time,
    weekday: a.schedule.weekday ?? 1, day: a.schedule.day ?? 1, date: a.schedule.date ?? EMPTY.date, kind,
    text: String(args.text ?? args.summary ?? args.content ?? ""), receiveId: String(args.receiveId ?? ""),
    days: Number(args.days ?? 7),
  };
}

function toBody(d: Draft) {
  const schedule: Schedule = { kind: d.repeat, time: d.time,
    ...(d.repeat === "weekly" ? { weekday: d.weekday } : {}),
    ...(d.repeat === "monthly" ? { day: d.day } : {}),
    ...(d.repeat === "once" ? { date: d.date } : {}) };
  const body = d.text || d.title;
  const action: Action =
    d.kind === "expense_summary" ? { kind: "expense_summary", tool: "",
      args: { days: d.days, ...(d.receiveId ? { receiveId: d.receiveId, receiveIdType: "open_id" } : {}) } }
    : d.kind === "daily_summary" ? { kind: "daily_summary", tool: "", args: d.receiveId ? { receiveId: d.receiveId, receiveIdType: "open_id" } : {} }
    : d.kind === "note" ? { kind: "tool", tool: "note.create", args: { title: d.title, content: body } }
    : d.kind === "message" ? { kind: "tool", tool: "feishu.message.send", args: { receiveId: d.receiveId, receiveIdType: "open_id", text: body } }
    : { kind: "tool", tool: "feishu.task.create", args: { summary: body, description: "" } };
  return { title: d.title.trim(), schedule, action };
}

export function Automations({ me, path }: { me: Me; path: string }) {
  const toast = useToast();
  const list = useLoad(() => api.get<{ automations: Automation[] }>("/v1/automations").then((r) => r.automations), [], 60_000);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    try { await fn(); if (ok) toast(ok); await list.reload(); }
    catch (e) { toast(e instanceof Error ? e.message : "操作失败", true); }
    finally { setBusy(null); }
  }

  async function save(d: Draft) {
    if (!d.title.trim()) { toast("先给它起个名字", true); return; }
    if (d.kind === "message" && !d.receiveId.trim()) { toast("发消息要填接收者 ID", true); return; }
    await act("save", async () => {
      if (d.id) await api.patch(`/v1/automations/${d.id}`, toBody(d));
      else await api.post("/v1/automations", toBody(d));
      setEditing(null);
    }, d.id ? "已保存" : "已建好，到点自己会做");
  }

  return (
    <>
      <PageHead title="自动化" me={me} path={path}>
        <button className="btn go" onClick={() => setEditing({ ...EMPTY })}><Plus aria-hidden />新建</button>
      </PageHead>
      <div className="work-body">
        <p className="ink-2" style={{ fontSize: 14, maxWidth: "66ch", margin: 0 }}>
          到点自己做一件事，时间按北京时间。到点不再问你——是你自己定的，直接做；做过什么在「任务中心」里查得到。
          也可以对着设备说「每天早上八点提醒我量体重」，或者说「不用每天提醒我量体重了」来停掉。
        </p>

        {list.error && !list.data && <LoadError error={list.error} onRetry={() => void list.reload()} />}
        {!list.data && !list.error && <div style={{ display: "grid", gap: 10 }}>{[0, 1].map((i) => <Skeleton key={i} h={72} />)}</div>}
        {list.data?.length === 0 && (
          <div className="sheet empty">
            <b>还没有自动化</b>
            比如：每天 21:30 写一份今天的小结、每周一 09:00 建一个"写周报"的飞书任务、每月 1 号提醒对账。
          </div>
        )}

        {list.data && list.data.length > 0 && (
          <section className="sheet" aria-label="自动化列表">
            <ol className="log">
              {list.data.map((a) => (
                <li key={a.id} style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <b style={{ fontWeight: 600, opacity: a.enabled ? 1 : 0.55 }}>{a.title}</b>
                      <span className="pill info"><CalendarClock aria-hidden size={12} /> {a.scheduleLabel}</span>
                      <span className="pill">{DO_KINDS.find((k) => k.value === toDraft(a).kind)?.label}</span>
                      {a.source === "voice" && <span className="pill">说出来的</span>}
                      {!a.enabled && <span className="pill">已停用</span>}
                    </div>
                    <div className="ink-3" style={{ fontSize: 13, marginTop: 4 }}>
                      {a.enabled ? `下一次 ${stamp(a.nextRunAt)}` : "停用中，打开开关后按时间继续"}
                      {a.lastRunAt && ` · 上次 ${stamp(a.lastRunAt)}${a.lastStatus ? `（${a.lastStatus}）` : ""}`}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <label className="switch-inline" title={a.enabled ? "停用" : "启用"}>
                      <input type="checkbox" checked={a.enabled} disabled={busy !== null}
                             onChange={(e) => void act(a.id, () => api.patch(`/v1/automations/${a.id}`, { enabled: e.target.checked }),
                               e.target.checked ? "已启用" : "已停用")} />
                    </label>
                    <button className="btn sm" disabled={busy !== null}
                            onClick={() => void act(`${a.id}:run`, () => api.post(`/v1/automations/${a.id}/run`), "已经跑了一次")}>
                      <Play aria-hidden />{busy === `${a.id}:run` ? "运行中" : "运行一次"}
                    </button>
                    <button className="btn sm icon flat" aria-label="编辑" onClick={() => setEditing(toDraft(a))}><Pencil aria-hidden /></button>
                    <button className="btn sm icon flat" aria-label="删除" disabled={busy !== null}
                            onClick={() => { if (confirm(`删除「${a.title}」？`)) void act(a.id, () => api.del(`/v1/automations/${a.id}`), "已删除"); }}>
                      <Trash2 aria-hidden />
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>

      {editing && (
        <Modal title={editing.id ? "改一条自动化" : "新建自动化"} onClose={() => setEditing(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="field">
              <label htmlFor="au-title">叫什么</label>
              <input id="au-title" type="text" value={editing.title} maxLength={80} placeholder="比如：提醒量体重"
                     onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
            </div>

            <div className="field">
              <label>什么时候</label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <select value={editing.repeat} aria-label="重复方式" style={{ width: "auto" }}
                        onChange={(e) => setEditing({ ...editing, repeat: e.target.value as Schedule["kind"] })}>
                  <option value="daily">每天</option>
                  <option value="weekly">每周</option>
                  <option value="monthly">每月</option>
                  <option value="once">只做一次</option>
                </select>
                {editing.repeat === "weekly" && (
                  <select value={editing.weekday} aria-label="星期几" style={{ width: "auto" }}
                          onChange={(e) => setEditing({ ...editing, weekday: Number(e.target.value) })}>
                    {WEEK.map((w, i) => <option key={w} value={i}>{w}</option>)}
                  </select>
                )}
                {editing.repeat === "monthly" && (
                  <select value={editing.day} aria-label="几号" style={{ width: "auto" }}
                          onChange={(e) => setEditing({ ...editing, day: Number(e.target.value) })}>
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d} 号</option>)}
                  </select>
                )}
                {editing.repeat === "once" && (
                  <input type="date" value={editing.date} aria-label="哪天" style={{ width: "auto" }}
                         onChange={(e) => setEditing({ ...editing, date: e.target.value })} />
                )}
                <input type="time" value={editing.time} aria-label="几点" style={{ width: "auto" }}
                       onChange={(e) => setEditing({ ...editing, time: e.target.value })} />
              </div>
              <span className="hint">北京时间。每月 29–31 号遇到没有那天的月份会跳过那个月。</span>
            </div>

            <div className="field">
              <label>做什么</label>
              <select value={editing.kind} aria-label="做什么" onChange={(e) => setEditing({ ...editing, kind: e.target.value as DoKind })}>
                {DO_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
              <span className="hint">{DO_KINDS.find((k) => k.value === editing.kind)?.hint}</span>
            </div>

            {editing.kind === "expense_summary" && (
              <div className="field">
                <label>汇总最近几天</label>
                <select value={editing.days} aria-label="汇总天数" style={{ width: "auto" }}
                        onChange={(e) => setEditing({ ...editing, days: Number(e.target.value) })}>
                  {[1, 7, 14, 30].map((d) => <option key={d} value={d}>{d} 天</option>)}
                </select>
                <span className="hint">按运行那一刻往前数。比如每周日 20:00 汇总 7 天，就是过去一周。</span>
              </div>
            )}
            {editing.kind !== "daily_summary" && editing.kind !== "expense_summary" && (
              <div className="field">
                <label htmlFor="au-text">内容</label>
                <input id="au-text" type="text" value={editing.text} maxLength={500} placeholder="不填就用上面的名字"
                       onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
              </div>
            )}
            {(editing.kind === "message" || editing.kind === "daily_summary" || editing.kind === "expense_summary") && (
              <div className="field">
                <label htmlFor="au-to">发给谁（飞书 open_id）</label>
                <input id="au-to" type="text" value={editing.receiveId} maxLength={200} placeholder="ou_xxx；小结不填就只生成不发"
                       onChange={(e) => setEditing({ ...editing, receiveId: e.target.value })} />
              </div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setEditing(null)}>取消</button>
              <button className="btn go" disabled={busy === "save"} onClick={() => void save(editing)}>
                {busy === "save" ? "保存中" : "保存"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

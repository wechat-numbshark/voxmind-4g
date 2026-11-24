import { useState, type FormEvent } from "react";
import { api, type Device, type Me as MeInfo, type Policy } from "../../api.ts";
import { ago, toolLabel } from "../../format.ts";
import { LoadError, Pill, Skeleton, useLoad, useToast } from "../../ui/kit.tsx";
import { PageHead } from "../../ui/Shell.tsx";
import { SettingsPanel, type SettingsGroup } from "./Settings.tsx";

const CONFIRM_LABEL = { always: "每次都先问我", explicit_only: "我明说的直接做，它猜的先问我", never: "直接做，不用问" } as const;
const TOOL_NOTE: Record<string, string> = {
  "note.create": "只记下来，不影响任何人",
  "feishu.task.create": "写进你自己的飞书待办",
  "feishu.calendar.create": "写进你自己的飞书日程",
  "feishu.doc.create": "在你的飞书云文档里新建一篇",
  "feishu.message.send": "会以你的名义发给别人",
  "webhook.call": "调用外部系统，对外可见",
  "homeassistant.service.call": "控制家里的实体设备",
  "automation.create": "说「每天…」时建一条定时规则，规则本身不对外",
  "automation.cancel": "说「不用每天…了」时停掉一条定时规则",
  "expense.record": "写进你飞书多维表格里的消费记录表",
};

type Group = SettingsGroup | "rules" | "account";
const GROUPS: { id: Group; label: string; note: string }[] = [
  { id: "screen", label: "设备屏幕与指示灯", note: "熄屏时间、自动亮屏、指示灯" },
  { id: "audio", label: "录音与回放", note: "识别档位、回放音量、保留期" },
  { id: "ai", label: "AI 助手", note: "拆主题、纪要、思维导图、聊天快捷问题" },
  { id: "expense", label: "记账", note: "写进飞书多维表格" },
  { id: "power", label: "开关机与唤醒", note: "唤醒词、定时开关机" },
  { id: "rules", label: "执行规则", note: "先不先问我、什么时候识别、办完弹不弹" },
  { id: "account", label: "账号与设备", note: "我的设备、密码" },
];

export function Me({ me, path }: { me: MeInfo; path: string }) {
  const [group, setGroup] = useState<Group>(() => {
    // 别的页面可以用 ?group=ai 直接打开某一组（聊天页的「改快捷问题」）
    const asked = new URLSearchParams(location.search).get("group") as Group | null;
    if (asked && GROUPS.some((g) => g.id === asked)) return asked;
    try { return (localStorage.getItem("voxmind:settings-group") as Group | null) ?? "screen"; } catch { return "screen"; }
  });
  const pick = (g: Group) => { setGroup(g); try { localStorage.setItem("voxmind:settings-group", g); } catch { /* 无痕模式 */ } };
  return (
    <>
      <PageHead title="我的" me={me} path={path} />
      <div className="work-body">
        <div className="split list">
          <nav className="sheet" aria-label="设置分类">
            <div className="sheet-head"><h2>设置</h2></div>
            <p className="hint" style={{ padding: "8px 18px 10px", margin: 0, borderBottom: "1px solid var(--rule)" }}>
              这里的设置都可以直接说：按住设备确认键说「熄屏改成 30 秒」「换成多巴胺主题」「发飞书消息每次先问我」，
              或者在「聊天」里打字。要不要先确认，按「执行规则」里「改设置」那一行来。
            </p>
            {GROUPS.map((g) => (
              <button key={g.id} className="nav" aria-current={group === g.id ? "page" : undefined} onClick={() => pick(g.id)}
                      style={{ borderRadius: 0, padding: "10px 18px", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                <span style={{ fontWeight: 600 }}>{g.label}</span>
                <span className="ink-3" style={{ fontSize: 13 }}>{g.note}</span>
              </button>
            ))}
          </nav>
          <div style={{ display: "flex", flexDirection: "column", gap: 22, minWidth: 0 }}>
            {group === "rules" ? <Policies onGoAi={() => pick("ai")} />
              : group === "account" ? <><MyDevices /><Account me={me} /></>
              : <SettingsPanel group={group} canSetLed={me.role === "admin"} />}
          </div>
        </div>
      </div>
    </>
  );
}

function Policies({ onGoAi }: { onGoAi: () => void }) {
  const toast = useToast();
  const policies = useLoad(() => api.get<{ policies: Policy[] }>("/v1/tool-policies").then((r) => r.policies), []);
  /* "跟着总设置"到底是什么，直接写出来——以前只写"跟随总开关"，没人知道总开关在哪、现在是什么 */
  const mode = useLoad(() => api.get<{ settings: { prefs: { ai: { intentMode: "auto" | "push_to_talk" } } } }>("/v1/settings")
    .then((r) => r.settings.prefs.ai.intentMode), []);
  const modeLabel = mode.data === "push_to_talk" ? "按住确认键才识别" : mode.data === "auto" ? "全自动识别" : "…";
  const [saving, setSaving] = useState<string | null>(null);

  async function change(p: Policy, patch: Partial<Policy>) {
    const next = { ...p, ...patch };
    setSaving(p.tool);
    try {
      await api.put(`/v1/tool-policies/${encodeURIComponent(p.tool)}`, {
        confirmation: next.confirmation, maxDraftAgeSec: next.maxDraftAgeSec, notifyDevice: next.notifyDevice,
        extract: next.extract });
      policies.setData((all) => (all ?? []).map((x) => x.tool === p.tool ? { ...next, configured: true } : x));
      toast(`${toolLabel(p.tool)}：从下一张单子起生效`);
    } catch (e) { toast(e instanceof Error ? e.message : "保存失败", true); }
    finally { setSaving(null); }
  }

  return (
    <section className="sheet" aria-labelledby="policy-title">
      <div className="sheet-head"><h2 id="policy-title">什么事要先问我</h2></div>
      <div className="sheet-body" style={{ paddingBottom: 6 }}>
        <dl className="ink-2" style={{ fontSize: 14, display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 14px", margin: 0 }}>
          <dt style={{ fontWeight: 700, color: "var(--ink)" }}>先不先问我</dt>
          <dd style={{ margin: 0 }}>
            「我明说的直接做」：你亲口下的命令（"帮我建个任务，明天十点给王总回电话"）直接办；
            它从聊天里猜出来的事，还是先弹一张卡片等你确认。确认在设备屏、网页、飞书上都行，一处确认其余同步。
          </dd>
          <dt style={{ fontWeight: 700, color: "var(--ink)" }}>什么时候识别</dt>
          <dd style={{ margin: 0 }}>
            「识别」就是从你说的话里找出要办的事。这里每类事可以单独设：
            「跟着总设置」——总设置在「AI 助手 → 什么时候识别要办的事」，<b>现在是「{modeLabel}」</b>
            <button type="button" className="btn ghost" onClick={onGoAi} style={{ marginLeft: 6, padding: "1px 8px", fontSize: 13 }}>去改</button>；
            「只在按住确认键时」——这类事只认你按着设备确认键说的话；「不识别这类」——这类事完全不帮你办。
          </dd>
          <dt style={{ fontWeight: 700, color: "var(--ink)" }}>办完弹到设备上</dt>
          <dd style={{ margin: 0 }}>
            直接办完的事，设备亮屏、振一下，把办了什么弹出来给你看；不勾就只在网页上看得到。
            要你确认的卡片、以及执行失败的，不管勾没勾都会弹。
          </dd>
        </dl>
      </div>
      {policies.error && !policies.data && <div className="sheet-body"><LoadError error={policies.error} onRetry={() => void policies.reload()} /></div>}
      {!policies.data && !policies.error && <div className="sheet-body" style={{ display: "grid", gap: 10 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={34} />)}</div>}
      {policies.data && (
        <div className="table-scroll">
          <table className="ledger stack rules">
            <thead><tr><th>动作</th><th>先不先问我</th><th>什么时候识别</th><th>办完弹到设备上</th></tr></thead>
            <tbody>
              {policies.data.map((p) => (
                <tr key={p.tool}>
                  <td className="span">
                    <b style={{ fontWeight: 600 }}>{toolLabel(p.tool)}</b>
                    <div className="ink-2" style={{ fontSize: 13, fontWeight: 500 }}>{TOOL_NOTE[p.tool] ?? p.tool}</div>
                  </td>
                  <td style={{ minWidth: 190, paddingTop: 8 }}>
                    <select value={p.confirmation} disabled={saving === p.tool} aria-label={`${toolLabel(p.tool)}的规则`}
                            onChange={(e) => void change(p, { confirmation: e.target.value as Policy["confirmation"] })}>
                      {Object.entries(CONFIRM_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </td>
                  <td style={{ minWidth: 150, paddingTop: 8 }}>
                    <select value={p.extract} disabled={saving === p.tool} aria-label={`什么时候识别${toolLabel(p.tool)}`}
                            onChange={(e) => void change(p, { extract: e.target.value as Policy["extract"] })}>
                      <option value="follow">跟着总设置（{modeLabel}）</option>
                      <option value="push_to_talk">只在按住确认键时</option>
                      <option value="off">不识别这类</option>
                    </select>
                  </td>
                  <td style={{ paddingTop: 8 }}>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14 }}>
                      <input type="checkbox" checked={p.notifyDevice} disabled={saving === p.tool}
                             onChange={(e) => void change(p, { notifyDevice: e.target.checked })} />
                      弹
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function MyDevices() {
  const devices = useLoad(() => api.get<{ devices: Device[] }>("/v1/devices").then((r) => r.devices), [], 30000);
  return (
    <section className="sheet" aria-labelledby="dev-title">
      <div className="sheet-head"><h2 id="dev-title">我的设备</h2></div>
      {devices.error && !devices.data && <div className="sheet-body"><LoadError error={devices.error} onRetry={() => void devices.reload()} /></div>}
      {!devices.data && !devices.error && <div className="sheet-body"><Skeleton h={48} /></div>}
      {devices.data?.length === 0 && (
        <div className="empty"><b>还没有登记的设备</b>设备由管理员发放。正在用旧共享密钥的设备照常录音上传，只是这里看不到它的电量和在线状态。</div>
      )}
      {devices.data && devices.data.length > 0 && (
        <dl className="readout" style={{ margin: 0, padding: "0 18px 6px", borderTop: 0 }}>
          {devices.data.map((d) => (
            <div key={d.id}>
              <dt>
                <b style={{ color: "var(--ink)", fontWeight: 600 }}>{d.name}</b>
                <div className="mono ink-2" style={{ fontSize: 12 }}>{d.id}</div>
              </dt>
              <dd className="txt">
                {d.status === "revoked" ? <Pill status="revoked" /> : (
                  <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {d.lastBatteryPct !== null && <span className="mono">{d.lastBatteryPct}%</span>}
                    {d.lastNetwork && <span className="ink-2">{d.lastNetwork}</span>}
                    <span className="ink-3">{ago(d.lastSeenAt)}</span>
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function Account({ me }: { me: MeInfo }) {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next.length < 10) { setError("新密码至少 10 位"); return; }
    setBusy(true); setError(null);
    try {
      await api.post("/v1/auth/password", { current, next });
      toast("密码已更新，请用新密码重新登录");
      window.dispatchEvent(new Event("voxmind:signed-out"));
    } catch (err) { setError(err instanceof Error ? err.message : "修改失败"); }
    finally { setBusy(false); }
  }

  return (
    <section className="sheet" aria-labelledby="acct-title">
      <div className="sheet-head"><h2 id="acct-title">账号</h2></div>
      <div className="sheet-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <dl className="readout" style={{ margin: 0 }}>
          <div><dt>名字</dt><dd className="txt">{me.user.displayName}</dd></div>
          <div><dt>邮箱</dt><dd className="txt">{me.user.email}</dd></div>
          <div><dt>角色</dt><dd className="txt">{me.role === "admin" ? "管理员" : "成员"}</dd></div>
        </dl>
        {me.via === "legacy-admin" ? (
          <p className="notice info">你是用运维密钥登录的，这个身份没有密码可改。</p>
        ) : (
          <form onSubmit={(e) => void submit(e)} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <h3>修改密码</h3>
            <div className="form-row">
              <div className="field"><label htmlFor="pw-cur">当前密码</label>
                <input id="pw-cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></div>
              <div className="field"><label htmlFor="pw-new">新密码</label>
                <input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
                <span className="hint">至少 10 位。改完所有设备上的登录都会退出。</span></div>
            </div>
            {error && <p className="error-text" role="alert">{error}</p>}
            <div><button className="btn" type="submit" disabled={busy || !current || !next}>{busy ? "正在修改" : "修改密码"}</button></div>
          </form>
        )}
      </div>
    </section>
  );
}

import { useEffect, useState, type FormEvent } from "react";
import { UserPlus } from "lucide-react";
import { api, type Me, type User, type UserRole } from "../../api.ts";
import { stamp } from "../../format.ts";
import { LoadError, Pill, Skeleton, useLoad, useToast } from "../../ui/kit.tsx";
import { PageHead } from "../../ui/Shell.tsx";

export function Users({ me, path }: { me: Me; path: string }) {
  const toast = useToast();
  const users = useLoad(() => api.get<{ users: User[] }>("/v1/users").then((r) => r.users), []);
  const [adding, setAdding] = useState(false);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [newPw, setNewPw] = useState("");

  async function patch(u: User, what: "role" | "status", value: string) {
    try {
      const r = await api.put<{ user: User }>(`/v1/users/${encodeURIComponent(u.id)}/${what}`, { [what]: value });
      users.setData((all) => (all ?? []).map((x) => x.id === u.id ? r.user : x));
      toast(what === "role" ? `${u.displayName} 现在是${value === "admin" ? "管理员" : "成员"}` : value === "disabled" ? `已停用 ${u.displayName}，其登录已全部失效` : `已恢复 ${u.displayName}`);
    } catch (e) { toast(e instanceof Error ? e.message : "操作失败", true); }
  }

  async function reset(u: User) {
    if (newPw.length < 10) { toast("新密码至少 10 位", true); return; }
    try {
      await api.put(`/v1/users/${encodeURIComponent(u.id)}/password`, { password: newPw });
      toast(`已重置 ${u.displayName} 的密码，TA 的所有登录已失效`);
      setResetFor(null); setNewPw("");
    } catch (e) { toast(e instanceof Error ? e.message : "重置失败", true); }
  }

  return (
    <>
      <PageHead title="用户" me={me} path={path}>
        <button className="btn go" onClick={() => setAdding((v) => !v)}><UserPlus aria-hidden />{adding ? "收起" : "新建用户"}</button>
      </PageHead>
      <div className="work-body">
        {adding && <NewUser onCreated={(u) => { users.setData((all) => [...(all ?? []), u]); setAdding(false); }} />}
        <section className="sheet">
          {users.error && !users.data && <div className="sheet-body"><LoadError error={users.error} onRetry={() => void users.reload()} /></div>}
          {!users.data && !users.error && <div className="sheet-body" style={{ display: "grid", gap: 10 }}>{[0, 1, 2].map((i) => <Skeleton key={i} h={30} />)}</div>}
          {users.data && (
            <div className="table-scroll">
              <table className="ledger stack">
                <thead><tr><th>用户</th><th>角色</th><th>档位</th><th>状态</th><th>创建于</th><th className="right">操作</th></tr></thead>
                <tbody>
                  {users.data.map((u) => {
                    const self = u.id === me.user.id;
                    return (
                      <tr key={u.id}>
                        <td className="span"><b style={{ fontWeight: 600 }}>{u.displayName}</b>{self && <span className="ink-2"> （你）</span>}
                          <div className="ink-2" style={{ fontSize: 13 }}>{u.email}</div></td>
                        <td style={{ minWidth: 110 }}>
                          <select value={u.role} disabled={self} aria-label={`${u.displayName}的角色`}
                                  onChange={(e) => void patch(u, "role", e.target.value as UserRole)}>
                            <option value="member">成员</option><option value="admin">管理员</option>
                          </select>
                        </td>
                        <td style={{ minWidth: 104 }}><TierSelect user={u} /></td>
                        <td><Pill status={u.status} /></td>
                        <td className="time hide-sm">{stamp(u.createdAt)}</td>
                        <td className="right span" style={{ paddingTop: 6 }}>
                          {resetFor === u.id ? (
                            <span style={{ display: "inline-flex", gap: 6 }}>
                              <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="新密码，至少 10 位"
                                     aria-label="新密码" autoComplete="new-password" style={{ width: 170, minHeight: 30 }} />
                              <button className="btn sm go" onClick={() => void reset(u)}>确定</button>
                              <button className="btn sm" onClick={() => { setResetFor(null); setNewPw(""); }}>取消</button>
                            </span>
                          ) : (
                            <span style={{ display: "inline-flex", gap: 6 }}>
                              <button className="btn sm" onClick={() => setResetFor(u.id)}>重置密码</button>
                              {!self && (u.status === "active"
                                ? <button className="btn sm no" onClick={() => void patch(u, "status", "disabled")}>停用</button>
                                : <button className="btn sm" onClick={() => void patch(u, "status", "active")}>恢复</button>)}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function NewUser({ onCreated }: { onCreated: (u: User) => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ displayName: "", email: "", password: "", role: "member" as UserRole });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form.displayName || !form.email) { setError("名字和邮箱都要填"); return; }
    if (form.password.length < 10) { setError("初始密码至少 10 位"); return; }
    setBusy(true); setError(null);
    try {
      const { user } = await api.post<{ user: User }>("/v1/users", form);
      toast(`已创建 ${user.displayName}。把邮箱和初始密码当面或私下交给 TA。`);
      onCreated(user);
    } catch (err) { setError(err instanceof Error ? err.message : "创建失败"); }
    finally { setBusy(false); }
  }

  return (
    <form className="sheet" onSubmit={(e) => void submit(e)} aria-labelledby="new-user-title">
      <div className="sheet-head"><h2 id="new-user-title">新建用户</h2></div>
      <div className="sheet-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="form-row">
          <div className="field"><label htmlFor="nu-name">名字</label><input id="nu-name" type="text" value={form.displayName} onChange={set("displayName")} placeholder="张伟" /></div>
          <div className="field"><label htmlFor="nu-email">邮箱</label><input id="nu-email" type="email" value={form.email} onChange={set("email")} placeholder="zhangwei@company.com" /></div>
          <div className="field"><label htmlFor="nu-pw">初始密码</label><input id="nu-pw" type="text" value={form.password} onChange={set("password")} autoComplete="off" /></div>
          <div className="field"><label htmlFor="nu-role">角色</label>
            <select id="nu-role" value={form.role} onChange={set("role")}><option value="member">成员</option><option value="admin">管理员</option></select></div>
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
        <div><button className="btn go" type="submit" disabled={busy}>{busy ? "正在创建" : "创建"}</button></div>
      </div>
    </form>
  );
}

/** 管理员直接给某个用户换档。设置接口按 userId 读写，成员自己在「我的」里也能改 */
function TierSelect({ user }: { user: User }) {
  const toast = useToast();
  const [tier, setTier] = useState<"high" | "economy" | null>(null);
  useEffect(() => {
    void api.get<{ settings: { tier: "high" | "economy" } }>(`/v1/settings?userId=${encodeURIComponent(user.id)}`)
      .then((r) => setTier(r.settings.tier)).catch(() => setTier(null));
  }, [user.id]);
  if (!tier) return <span className="ink-3">–</span>;
  return (
    <select value={tier} aria-label={`${user.displayName}的识别档位`}
            onChange={async (e) => {
              const next = e.target.value as "high" | "economy";
              try { await api.put("/v1/settings", { userId: user.id, tier: next }); setTier(next);
                toast(`${user.displayName} 改为${next === "high" ? "高质量" : "经济"}档`); }
              catch (err) { toast(err instanceof Error ? err.message : "修改失败", true); }
            }}>
      <option value="high">高质量</option><option value="economy">经济</option>
    </select>
  );
}

import { useState } from "react";
import { api, type AuditEntry, type Me, type User } from "../../api.ts";
import { stamp } from "../../format.ts";
import { LoadError, Skeleton, useLoad } from "../../ui/kit.tsx";
import { PageHead } from "../../ui/Shell.tsx";

const ACTIONS: Record<string, string> = {
  "auth.login": "登录", "auth.password_change": "修改自己的密码",
  "draft.confirm": "签放", "draft.cancel": "退回", "draft.revise": "修改单子",
  "policy.update": "改确认规则",
  "user.create": "新建用户", "user.role_change": "改角色", "user.status_change": "停用/恢复用户", "user.password_reset": "重置密码",
  "device.issue": "发放设备", "device.revoke": "吊销设备",
};

function describe(e: AuditEntry) {
  const d = e.detail as Record<string, unknown>;
  const bits: string[] = [];
  if (d.via) bits.push(d.via === "device" ? "在设备上" : "在网页上");
  if (typeof d.tool === "string") bits.push(d.tool);
  if (typeof d.title === "string") bits.push(`标题改为「${d.title}」`);
  if (typeof d.role === "string") bits.push(d.role === "admin" ? "→ 管理员" : "→ 成员");
  if (typeof d.status === "string") bits.push(d.status === "disabled" ? "→ 停用" : "→ 恢复");
  if (typeof d.confirmation === "string") bits.push(`→ ${d.confirmation}`);
  if (typeof d.email === "string") bits.push(d.email);
  return bits.join(" · ");
}

export function Audit({ me, path }: { me: Me; path: string }) {
  const [action, setAction] = useState("");
  const log = useLoad(() => api.get<{ entries: AuditEntry[] }>(`/v1/audit?limit=300${action ? `&action=${action}` : ""}`).then((r) => r.entries), [action], 20000);
  const users = useLoad(() => api.get<{ users: User[] }>("/v1/users").then((r) => r.users), []);
  const who = (e: AuditEntry) => e.actorType === "device" ? `设备 ${e.actorId}` : users.data?.find((u) => u.id === e.actorId)?.displayName ?? e.actorId;

  return (
    <>
      <PageHead title="审计" me={me} path={path}>
        <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="按操作筛选" style={{ width: 180 }}>
          <option value="">全部操作</option>
          {Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </PageHead>
      <div className="work-body">
        <section className="sheet">
          {log.error && !log.data && <div className="sheet-body"><LoadError error={log.error} onRetry={() => void log.reload()} /></div>}
          {!log.data && !log.error && <div className="sheet-body" style={{ display: "grid", gap: 10 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={26} />)}</div>}
          {log.data?.length === 0 && <div className="empty"><b>没有记录</b>签放、退回、改规则、管理用户和设备都会记在这里，只增不删。</div>}
          {log.data && log.data.length > 0 && (
            <div className="table-scroll">
              <table className="ledger stack">
                <thead><tr><th>时间</th><th>谁</th><th>做了什么</th><th>细节</th><th>来源 IP</th></tr></thead>
                <tbody>
                  {log.data.map((e) => (
                    <tr key={e.id}>
                      <td className="time">{stamp(e.at)}</td>
                      <td style={{ fontWeight: 500 }}>{who(e)}</td>
                      <td className="span"><b style={{ fontWeight: 600 }}>{ACTIONS[e.action] ?? e.action}</b></td>
                      <td className="ink-2 span" style={{ fontSize: 13, fontWeight: 500 }}>{describe(e)}</td>
                      <td className="mono ink-2 hide-sm">{e.ip || "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

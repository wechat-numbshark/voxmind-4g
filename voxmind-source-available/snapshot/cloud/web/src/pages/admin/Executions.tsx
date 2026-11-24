import { useState } from "react";
import { api, type ExecutionRow, type Me, type User } from "../../api.ts";
import { dayLabel, tierOfTool } from "../../format.ts";
import { LoadError, Skeleton, useLoad } from "../../ui/kit.tsx";
import { PageHead } from "../../ui/Shell.tsx";
import { Receipt } from "../../ui/Strip.tsx";

const FILTERS = [["all", "全部"], ["problem", "失败 / 未知"], ["succeeded", "成功"]] as const;

/* 回执架：每张签放过的单子执行后留一条，和用户架上的单子是同一种纸 */
export function Executions({ me, path }: { me: Me; path: string }) {
  const rows = useLoad(() => api.get<{ executions: ExecutionRow[] }>("/v1/admin/executions?limit=200").then((r) => r.executions), [], 15000);
  const users = useLoad(() => api.get<{ users: User[] }>("/v1/users").then((r) => r.users), []);
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const name = (id: string) => users.data?.find((u) => u.id === id)?.displayName ?? id;
  const shown = (rows.data ?? []).filter((r) => filter === "all" ? true
    : filter === "succeeded" ? r.status === "succeeded" : r.status === "failed" || r.status === "unknown");

  return (
    <>
      <PageHead title="执行记录" me={me} path={path}>
        <div className="seg" role="group" aria-label="筛选">
          {FILTERS.map(([v, l]) => <button key={v} aria-pressed={filter === v} onClick={() => setFilter(v)}>{l}</button>)}
        </div>
      </PageHead>
      <div className="work-body">
        <p className="ink-2" style={{ fontSize: 14, fontWeight: 500, padding: "0 4px", maxWidth: "68ch" }}>
          每张签放过的单子执行后都留一张回执。「结果未知」是服务重启时正在执行的，会用同一个幂等键重试，不会重复下单。
        </p>
        {rows.error && !rows.data && <LoadError error={rows.error} onRetry={() => void rows.reload()} />}
        <div className="bay">
          <div className="bay-head"><h2>回执 <span className="mono">{rows.data ? shown.length : "–"}</span></h2></div>
          {!rows.data && !rows.error && <div className="bay-stack">{[0, 1, 2].map((i) => <Skeleton key={i} h={72} />)}</div>}
          {rows.data && shown.length === 0 && (
            <div className="empty-bay"><p><b>{filter === "problem" ? "没有失败的执行" : "还没有回执"}</b>
              {filter === "problem" ? "所有签放的动作都顺利完成了。" : "用户签放第一张单子后，回执会出现在这里。"}</p></div>
          )}
          {shown.length > 0 && (
            <div className="bay-stack">
              {shown.map((r) => (
                <Receipt key={r.id} tier={tierOfTool(r.tool)} time={r.createdAt} date={dayLabel(r.createdAt)}
                         tool={r.tool} title={r.title} status={r.status}
                         who={`${name(r.userId)} · 经 ${r.provider}`} note={r.error ?? r.externalId} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

import { AlertTriangle } from "lucide-react";
import { api, type Me, type Overview as OverviewData } from "../../api.ts";
import { ago, bytes, hours } from "../../format.ts";
import { navigate } from "../../router.ts";
import { LoadError, RecLight, Skeleton, useLoad } from "../../ui/kit.tsx";
import { PageHead } from "../../ui/Shell.tsx";

function Status({ ready, text }: { ready: boolean; text: string }) {
  return <span className={`pill ${ready ? "ok" : "warn"}`}><i />{text}</span>;
}

export function Overview({ me, path }: { me: Me; path: string }) {
  const o = useLoad(() => api.get<OverviewData>("/v1/admin/overview"), [], 15000);
  const s = o.data?.stats;
  const svc = o.data?.services;

  return (
    <>
      <PageHead title="总览" me={me} path={path}><RecLight lastUploadAt={s?.lastUploadAt} /></PageHead>
      <div className="work-body">
        {o.error && !o.data && <LoadError error={o.error} onRetry={() => void o.reload()} />}
        {svc?.executionMode === "mock" && (
          <div className="notice" role="note">
            <AlertTriangle aria-hidden />
            <div>执行处于<b>模拟模式</b>：用户签放的动作会记录为「已执行」，但不会真的写进飞书或调用外部接口。
              连接器授权完成后，把 EXECUTION_MODE 改成 live 才会真正执行。</div>
          </div>
        )}
        {s && s.transcriptsFailed > 0 && (
          <div className="notice" role="alert">
            <AlertTriangle aria-hidden />
            <div><b className="mono">{s.transcriptsFailed}</b> 段转写失败。多半是语音识别服务的额度或网络问题，去服务器日志里搜「音频块转写失败」。</div>
          </div>
        )}
        <div className="split even">
          <section className="sheet" aria-labelledby="flow-title">
            <div className="sheet-head"><h2 id="flow-title">过去 24 小时</h2></div>
            <div className="sheet-body">
              {!s ? <div style={{ display: "grid", gap: 12 }}>{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} />)}</div> : (
                <dl className="readout" style={{ margin: 0 }}>
                  <div><dt>录到的时长</dt><dd>{hours(s.audioMs24h)}</dd></div>
                  <div><dt>上云音频块</dt><dd>{s.chunks24h.toLocaleString("zh-CN")}</dd></div>
                  <div><dt>最近一次上传</dt><dd className="txt">{ago(s.lastUploadAt)}</dd></div>
                  <div><dt>等待转写</dt><dd>{s.transcriptsQueued}</dd></div>
                  <div><dt>转写失败（累计）</dt><dd style={{ color: s.transcriptsFailed ? "var(--bad)" : undefined }}>{s.transcriptsFailed}</dd></div>
                  <div><dt>全部用户待签放</dt><dd>{s.draftsPending}</dd></div>
                  <div><dt>执行成功</dt><dd>{s.executions24h}</dd></div>
                  <div><dt>执行失败 / 结果未知（累计）</dt>
                    <dd style={{ color: s.executionsFailed ? "var(--bad)" : undefined }}>
                      {s.executionsFailed > 0
                        ? <button className="btn sm flat" style={{ color: "inherit", padding: 0 }} onClick={() => navigate("/admin/executions")}>{s.executionsFailed} · 查看</button>
                        : 0}
                    </dd></div>
                </dl>
              )}
            </div>
          </section>

          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            <section className="sheet" aria-labelledby="svc-title">
              <div className="sheet-head">
                <h2 id="svc-title">服务</h2>
                <div className="end"><button className="btn sm" onClick={() => navigate("/admin/connectors")}>连接器</button></div>
              </div>
              <div className="sheet-body">
                {!svc ? <div style={{ display: "grid", gap: 12 }}>{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} />)}</div> : (
                  <dl className="readout" style={{ margin: 0 }}>
                    <div><dt>语音识别</dt><dd className="txt"><span className="mono ink-2" style={{ marginRight: 8, fontSize: 12 }}>{svc.asr.ready ? svc.asr.model : ""}</span><Status ready={svc.asr.ready} text={svc.asr.ready ? "运行中" : "未配置"} /></dd></div>
                    <div><dt>意图模型</dt><dd className="txt"><span className="mono ink-2" style={{ marginRight: 8, fontSize: 12 }}>{svc.llm.ready ? svc.llm.model : ""}</span><Status ready={svc.llm.ready} text={svc.llm.ready ? "运行中" : "未配置"} /></dd></div>
                    <div><dt>飞书</dt><dd className="txt"><Status ready={svc.feishu.ready} text={svc.feishu.ready ? "已授权" : svc.feishu.appCreated ? "待授权" : "未连接"} /></dd></div>
                    <div><dt>Webhook</dt><dd className="txt"><Status ready={svc.webhook.ready} text={svc.webhook.ready ? "已配置" : "未配置"} /></dd></div>
                    <div><dt>Home Assistant</dt><dd className="txt"><Status ready={svc.homeAssistant.ready} text={svc.homeAssistant.ready ? "已配置" : "未配置"} /></dd></div>
                    <div><dt>执行模式</dt><dd className="txt"><Status ready={svc.executionMode === "live"} text={svc.executionMode === "live" ? "真实执行" : "模拟"} /></dd></div>
                  </dl>
                )}
              </div>
            </section>
            <section className="sheet" aria-labelledby="fleet-title">
              <div className="sheet-head"><h2 id="fleet-title">账号与设备</h2></div>
              <div className="sheet-body">
                {!s ? <Skeleton h={80} /> : (
                  <dl className="readout" style={{ margin: 0 }}>
                    <div><dt>用户</dt><dd><button className="btn sm flat" style={{ padding: 0 }} onClick={() => navigate("/admin/users")}>{s.users}</button></dd></div>
                    <div><dt>已登记设备 / 10 分钟内在线</dt><dd><button className="btn sm flat" style={{ padding: 0 }} onClick={() => navigate("/admin/devices")}>{s.devicesActive} / {s.devicesOnline}</button></dd></div>
                    <div><dt>音频占用</dt><dd>{bytes(s.audioBytesTotal)}</dd></div>
                  </dl>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </>
  );
}

import { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink } from "lucide-react";
import { api, type Me, type Overview } from "../../api.ts";
import { LoadError, Skeleton, useLoad, useToast } from "../../ui/kit.tsx";
import { PageHead } from "../../ui/Shell.tsx";

interface FeishuStatus { appCreated: boolean; authorized: boolean; scopes: string[]; redirectUri: string; redirectHint?: string | null }
interface Flow { status: string; verificationUrl: string; message: string }

const SCOPE_LABEL: Record<string, string> = {
  "task:task:write": "创建任务", "calendar:calendar": "读写日程", "calendar:calendar.event:create": "创建日程",
  "docx:document:create": "创建文档", "docx:document:write_only": "写入文档", "im:message": "发消息",
  "contact:user.base:readonly": "读取联系人", "offline_access": "长期授权",
};

export function Connectors({ me, path }: { me: Me; path: string }) {
  const toast = useToast();
  const feishu = useLoad(() => api.get<FeishuStatus>("/v1/integrations/feishu/status"), []);
  const overview = useLoad(() => api.get<Overview>("/v1/admin/overview"), []);
  const [flow, setFlow] = useState<Flow | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  async function createApp() {
    try {
      const started = await api.post<Flow>("/v1/integrations/feishu/registration/start");
      setFlow(started);
      if (started.verificationUrl) window.open(started.verificationUrl, "_blank", "noopener");
      timer.current = setInterval(async () => {
        try {
          const next = await api.get<Flow>("/v1/integrations/feishu/registration/status");
          setFlow(next);
          if (["created", "denied", "expired"].includes(next.status)) {
            if (timer.current) clearInterval(timer.current);
            void feishu.reload();
          }
        } catch { if (timer.current) clearInterval(timer.current); }
      }, 5000);
    } catch (e) { toast(e instanceof Error ? e.message : "发起失败", true); }
  }

  async function authorize() {
    try {
      const { url } = await api.get<{ url: string }>("/v1/integrations/feishu/authorize-url");
      window.open(url, "_blank", "noopener");
      toast("在新打开的飞书页面里同意授权，完成后回来刷新");
    } catch (e) { toast(e instanceof Error ? e.message : "拿不到授权链接", true); }
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); toast("已复制"); } catch { toast("浏览器不允许复制", true); }
  }

  const f = feishu.data;
  const svc = overview.data?.services;
  const step = !f ? 0 : f.authorized ? 3 : f.appCreated ? 2 : 1;

  return (
    <>
      <PageHead title="连接器" me={me} path={path} />
      <div className="work-body">
        <section className="sheet" aria-labelledby="fs-title">
          <div className="sheet-head">
            <h2 id="fs-title">飞书</h2>
            <div className="end">
              {f && <span className={`pill ${f.authorized ? "ok" : "warn"}`}><i />{f.authorized ? "已授权" : f.appCreated ? "待授权" : "未连接"}</span>}
            </div>
          </div>
          {feishu.error && !f && <div className="sheet-body"><LoadError error={feishu.error} onRetry={() => void feishu.reload()} /></div>}
          {!f && !feishu.error && <div className="sheet-body"><Skeleton h={120} /></div>}
          {f && (
            <div className="sheet-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <ol className="log" style={{ border: "1px solid var(--rule)", borderRadius: 8 }}>
                <li style={{ gridTemplateColumns: "28px 1fr auto" }}>
                  <span className="mono" style={{ color: step > 1 ? "var(--ok)" : "var(--ink)" }}>1</span>
                  <div><b>创建飞书应用</b><div className="ink-2" style={{ fontSize: 13 }}>
                    {step > 1 ? "已创建（或已在服务器配置里填好应用凭证）。" : "在飞书里一键创建应用并勾选权限。"}</div>
                    {flow && <div className="ink-2" style={{ fontSize: 13, marginTop: 4 }}>{flow.message}</div>}</div>
                  {step === 1 && <button className="btn sm go" onClick={() => void createApp()}>一键创建</button>}
                </li>
                <li style={{ gridTemplateColumns: "28px 1fr auto" }}>
                  <span className="mono" style={{ color: step > 2 ? "var(--ok)" : "var(--ink)" }}>2</span>
                  <div><b>在飞书后台登记回调地址</b>
                    <div className="ink-2" style={{ fontSize: 13 }}>应用「安全设置 → 重定向 URL」里加上这一条，否则授权会被飞书拒绝。</div>
                    <div className="key-reveal" style={{ marginTop: 8, borderColor: "var(--rule-strong)", fontSize: 13 }}>{f.redirectUri}</div>
                    {f.redirectHint && step === 2 && <div className="ink-3" style={{ fontSize: 12, marginTop: 4 }}>自动登记失败：{f.redirectHint}</div>}</div>
                  <button className="btn sm" onClick={() => void copy(f.redirectUri)}><Copy aria-hidden />复制</button>
                </li>
                <li style={{ gridTemplateColumns: "28px 1fr auto" }}>
                  <span className="mono" style={{ color: step > 2 ? "var(--ok)" : "var(--ink)" }}>3</span>
                  <div><b>授权你的飞书账号</b><div className="ink-2" style={{ fontSize: 13 }}>
                    {step > 2 ? "已授权。签放的任务、日程、文档会写进这个账号。" : "用要接收任务和日程的那个飞书账号登录并同意。"}</div></div>
                  {step >= 2 && <button className={`btn sm ${step === 2 ? "go" : ""}`} onClick={() => void authorize()}>
                    <ExternalLink aria-hidden />{step > 2 ? "重新授权" : "去授权"}</button>}
                </li>
              </ol>
              <div>
                <h3 style={{ marginBottom: 8 }}>申请的权限</h3>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {f.scopes.map((s) => <span key={s} className="pill" title={s}>{SCOPE_LABEL[s] ?? s}</span>)}
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="sheet" aria-labelledby="other-title">
          <div className="sheet-head"><h2 id="other-title">其他连接器与模型</h2></div>
          <div className="sheet-body">
            {!svc ? <Skeleton h={100} /> : (
              <dl className="readout" style={{ margin: 0 }}>
                <div><dt>语音识别</dt><dd className="txt">{svc.asr.ready ? <span className="mono">{svc.asr.provider} · {svc.asr.model}</span> : <span className="ink-3">未配置</span>}</dd></div>
                <div><dt>意图模型</dt><dd className="txt">{svc.llm.ready ? <span className="mono">{svc.llm.provider} · {svc.llm.model}</span> : <span className="ink-3">未配置</span>}</dd></div>
                <div><dt>Webhook 白名单</dt><dd className="txt">{svc.webhook.ready ? "已配置" : <span className="ink-3">未配置</span>}</dd></div>
                <div><dt>Home Assistant</dt><dd className="txt">{svc.homeAssistant.ready ? "已配置" : <span className="ink-3">未配置</span>}</dd></div>
              </dl>
            )}
            <p className="ink-3" style={{ fontSize: 13, marginTop: 12 }}>
              这些凭证只存在服务器的环境变量里，不经过浏览器。要更换请改服务器上的 .env 后重启服务。
            </p>
          </div>
        </section>
      </div>
    </>
  );
}

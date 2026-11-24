import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import type { Repository } from "../store/repository.js";
import { SecretBox } from "../security/secrets.js";

const REGISTRATION_URL = "https://accounts.feishu.cn/oauth/v1/app/registration";
const TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
/* 飞书已经把日历读写合并成 calendar:calendar，calendar:calendar:read 这个权限码不再提供：
 * 请求它会让授权页直接失败。2026-09-19 在开发者后台逐个核对过，下面这些都能开通。*/
const SCOPES = ["task:task:read", "task:task:write", "calendar:calendar", "calendar:calendar.event:create",
  "docx:document:create", "docx:document:write_only", "im:message", "contact:user.base:readonly", "offline_access",
  /* 以本人身份发消息：只有 im:message 已经不够，飞书会报 requires im:message.send_as_user（2026-10-08）。
   * 发给人名要先搜人、搜群，所以带上 contact:user:search 和 im:chat:read */
  "im:message.send_as_user", "contact:user:search", "im:chat:read"];

interface Binding { appId: string; appSecret: string; oauthState?: string; accessToken?: string; refreshToken?: string; accessExpiresAt?: number; refreshExpiresAt?: number }
interface Flow { deviceCode: string; verificationUrl: string; expiresAt: number; nextPollAt: number; interval: number; status: string; message: string }

export class FeishuOnboardingService {
  private readonly flows = new Map<string, Flow>();
  private redirectHint = "";
  constructor(private readonly repository: Repository, private readonly secrets: SecretBox, private readonly publicBaseUrl: string,
              private readonly configured?: { appId: string; appSecret: string }) {}

  private async form(data: Record<string, string>) {
    const response = await fetch(REGISTRATION_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data), signal: AbortSignal.timeout(20_000) });
    return await response.json() as Record<string, unknown>;
  }
  private publicFlow(flow?: Flow) { return flow ? { status: flow.status, verificationUrl: flow.status === "waiting" ? flow.verificationUrl : "", expiresIn: Math.max(0, Math.floor((flow.expiresAt-Date.now())/1000)), message: flow.message } : { status: "idle", verificationUrl: "", expiresIn: 0, message: "" }; }
  private async binding(userId: string) {
    const row = await this.repository.getIntegration(userId, "feishu");
    if (row) return this.secrets.decrypt<Binding>(row.encryptedConfig);
    /* 用户自己在飞书开发者后台建好的应用（.env 里的 LARK_APP_ID/SECRET）也要能用，
     * 不是只有走"一键创建"才行。第一次用到时落库，后续流程完全一致。*/
    if (this.configured?.appId && this.configured?.appSecret) {
      const binding: Binding = { appId: this.configured.appId, appSecret: this.configured.appSecret };
      await this.save(userId, binding);
      return binding;
    }
    return null;
  }

  private async tenantToken(binding: Binding) {
    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: binding.appId, app_secret: binding.appSecret }), signal: AbortSignal.timeout(20_000) });
    const data = await response.json() as { code?: number; msg?: string; tenant_access_token?: string };
    if (!response.ok || data.code !== 0 || !data.tenant_access_token) throw new Error(`飞书应用凭证无效：${data.msg ?? response.status}`);
    return data.tenant_access_token;
  }

  /** 把回调地址写进应用安全设置，并允许刷新令牌。已经配过会返回成功，可重复调用。*/
  private async configureRedirect(binding: Binding) {
    const token = await this.tenantToken(binding);
    const response = await fetch(`https://open.feishu.cn/open-apis/application/v7/applications/${binding.appId}/config`, {
      method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ security: { add: { redirect_urls: [`${this.publicBaseUrl}/v1/integrations/feishu/callback`] }, allow_refresh_token: true } }),
      signal: AbortSignal.timeout(20_000) });
    const data = await response.json() as { code?: number; msg?: string };
    if (!response.ok || data.code !== 0) throw new Error(`回调地址配置失败：${data.msg ?? response.status}`);
  }
  private async save(userId: string, binding: Binding) { await this.repository.upsertIntegration(userId, "feishu", this.secrets.encrypt(binding)); }

  async start(userId: string) {
    const data = await this.form({ action: "begin", archetype: "PersonalAgent", auth_method: "client_secret", request_user_info: "open_id" });
    if (typeof data.device_code !== "string" || typeof data.verification_uri_complete !== "string") throw new Error("飞书没有返回有效的一键创建链接");
    const addon = gzipSync(JSON.stringify({ preset: false, scopes: { tenant: ["application:application:patch"], user: SCOPES } })).toString("base64url");
    const url = new URL(data.verification_uri_complete); url.searchParams.set("from", "sdk"); url.searchParams.set("source", "voxmind");
    url.searchParams.set("tp", "sdk"); url.searchParams.set("name", "VoxMind 语音助手"); url.searchParams.set("desc", "把明确的语音指令安全地转成飞书任务、日程和云文档。"); url.searchParams.set("addons", addon); url.searchParams.set("createOnly", "true");
    const flow: Flow = { deviceCode: data.device_code, verificationUrl: url.toString(), expiresAt: Date.now()+Number(data.expires_in ?? 600)*1000, nextPollAt: 0, interval: Math.max(5,Number(data.interval ?? 5))*1000, status: "waiting", message: "请在飞书页面确认创建应用和权限。" };
    this.flows.set(userId, flow); return this.publicFlow(flow);
  }

  async poll(userId: string) {
    const flow = this.flows.get(userId); if (!flow) return this.publicFlow();
    if (Date.now() >= flow.expiresAt) { flow.status="expired"; flow.message="创建链接已过期，请重新发起。"; return this.publicFlow(flow); }
    if (flow.status !== "waiting" || Date.now() < flow.nextPollAt) return this.publicFlow(flow);
    const data = await this.form({ action: "poll", device_code: flow.deviceCode }); flow.nextPollAt=Date.now()+flow.interval;
    if (typeof data.client_id === "string" && typeof data.client_secret === "string") {
      const binding={appId:data.client_id,appSecret:data.client_secret}; await this.save(userId,binding);
      const tokenResponse=await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({app_id:binding.appId,app_secret:binding.appSecret}),signal:AbortSignal.timeout(20_000)});
      const tokenData=await tokenResponse.json() as {code?:number;msg?:string;tenant_access_token?:string};
      if (!tokenResponse.ok || tokenData.code!==0 || !tokenData.tenant_access_token) throw new Error(`自动配置应用失败：${tokenData.msg ?? tokenResponse.status}`);
      const configResponse=await fetch(`https://open.feishu.cn/open-apis/application/v7/applications/${binding.appId}/config`,{method:"PATCH",headers:{authorization:`Bearer ${tokenData.tenant_access_token}`,"content-type":"application/json"},body:JSON.stringify({security:{add:{redirect_urls:[`${this.publicBaseUrl}/v1/integrations/feishu/callback`]},allow_refresh_token:true}}),signal:AbortSignal.timeout(20_000)});
      const configData=await configResponse.json() as {code?:number;msg?:string};
      if (!configResponse.ok || configData.code!==0) throw new Error(`回调地址自动配置失败：${configData.msg ?? configResponse.status}`);
      flow.status="created"; flow.message="应用已创建并完成安全配置，请继续授权账号。"; return this.publicFlow(flow);
    }
    if (data.error === "slow_down") flow.interval += 5000;
    else if (data.error === "access_denied") { flow.status="denied"; flow.message="你已取消创建。"; }
    else if (data.error === "expired_token") { flow.status="expired"; flow.message="创建链接已过期。"; }
    return this.publicFlow(flow);
  }

  async authorizeUrl(userId: string) {
    const binding = await this.binding(userId);
    if (!binding) throw new Error("请先创建飞书应用，或在 .env 配置 LARK_APP_ID / LARK_APP_SECRET");
    /* 自己建的应用往往还没填回调地址，能自动配就自动配；应用没开
     * application:application:patch 权限时配不了，这时不该挡住授权——
     * 用户在开发者后台手动加一条回调地址同样可以走通。*/
    try {
      await this.configureRedirect(binding);
    } catch (error) {
      this.redirectHint = error instanceof Error ? error.message : String(error);
    }
    binding.oauthState=randomBytes(24).toString("base64url"); await this.save(userId,binding);
    const redirectUri=`${this.publicBaseUrl}/v1/integrations/feishu/callback`;
    const url=new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
    url.search=new URLSearchParams({client_id:binding.appId,response_type:"code",redirect_uri:redirectUri,scope:SCOPES.join(" "),state:binding.oauthState}).toString();
    return url.toString();
  }

  async callback(code: string, state: string) {
    const userId="owner"; const binding=await this.binding(userId);
    if (!binding?.oauthState || binding.oauthState!==state) throw new Error("授权状态校验失败，请重新发起");
    const redirectUri=`${this.publicBaseUrl}/v1/integrations/feishu/callback`;
    const response=await fetch(TOKEN_URL,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({grant_type:"authorization_code",client_id:binding.appId,client_secret:binding.appSecret,code,redirect_uri:redirectUri}),signal:AbortSignal.timeout(20_000)});
    const data=await response.json() as {code?:number;msg?:string;access_token?:string;refresh_token?:string;expires_in?:number;refresh_token_expires_in?:number};
    if (!response.ok || data.code!==0 || !data.access_token) throw new Error(`飞书授权失败：${data.msg ?? response.status}`);
    const now=Math.floor(Date.now()/1000); delete binding.oauthState; binding.accessToken=data.access_token;
    if (data.refresh_token) binding.refreshToken=data.refresh_token;
    binding.accessExpiresAt=now+(data.expires_in??7200); binding.refreshExpiresAt=now+(data.refresh_token_expires_in??2592000); await this.save(userId,binding);
  }

  async status(userId: string) {
    const binding = await this.binding(userId);
    /* 「已授权」要看刷新令牌还在不在有效期内，不能看 accessToken 存不存在：访问令牌只有 2 小时，
     * 存着也多半是过期的；而刷新令牌一过期就只能重新扫码。以前这里看的是 accessToken，
     * 结果 2026-10-24 授权实际已经断了 7 天，控制台还一路显示"已授权"。*/
    const now = Math.floor(Date.now()/1000); const refreshExpiresAt = binding?.refreshExpiresAt ?? 0;
    return { appCreated: Boolean(binding?.appId), authorized: Boolean(binding?.refreshToken) && refreshExpiresAt > now,
      scopes: SCOPES, ...(refreshExpiresAt ? { authorizedUntil: new Date(refreshExpiresAt*1000).toISOString() } : {}),
      redirectUri: `${this.publicBaseUrl}/v1/integrations/feishu/callback`, redirectHint: this.redirectHint };
  }
}

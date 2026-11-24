import { createHash } from "node:crypto";
import { z } from "zod";
import type { ActionDraft } from "../domain.js";
import type { SecretBox } from "../security/secrets.js";
import type { Repository } from "../store/repository.js";
import { pinyin } from "pinyin-pro";
import { NeedsChoiceError, type ToolExecutor, type ToolReceipt } from "./types.js";

/** 读音：去声调的拼音连在一起，字母小写，标点空格去掉。「AI自动化」→ aizidonghua；同音字读音一样 */
function sound(text:string){
  return pinyin(text.replace(/[\s\p{P}\p{S}]/gu,""),{toneType:"none",type:"array",nonZh:"consecutive",v:true}).join("").toLowerCase();
}

interface Binding { appId: string; appSecret: string; accessToken?: string; refreshToken?: string; accessExpiresAt?: number; refreshExpiresAt?: number;
  /** 授权本人的 open_id：建任务时要把他设成负责人，任务才会出现在飞书「任务 → 我负责的」里 */
  openId?: string }

export class FeishuUserExecutor implements ToolExecutor {
  private refreshInFlight: Promise<string> | null = null;

  /** baseUrl 只为测试留口子，线上一律是飞书开放平台 */
  constructor(private readonly repository: Repository, private readonly secrets: SecretBox,
              private readonly baseUrl = "https://open.feishu.cn") {}

  private async binding() {
    const row=await this.repository.getIntegration("owner","feishu");
    if (!row) throw new Error("飞书尚未在 Web 控制台完成授权");
    return this.secrets.decrypt<Binding>(row.encryptedConfig);
  }
  private async token() {
    const binding=await this.binding(); const now=Math.floor(Date.now()/1000);
    if (binding.accessToken && (binding.accessExpiresAt??0)>now+300) return binding.accessToken;
    return this.refresh(binding,now);
  }
  private async refresh(binding:Binding,now:number) {
    if (this.refreshInFlight) return this.refreshInFlight;
    if (!binding.refreshToken || (binding.refreshExpiresAt??0)<=now) throw new Error("飞书授权已过期，请在控制台重新授权");
    this.refreshInFlight=(async()=>{
      const response=await fetch(`${this.baseUrl}/open-apis/authen/v2/oauth/token`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({grant_type:"refresh_token",client_id:binding.appId,client_secret:binding.appSecret,refresh_token:binding.refreshToken}),signal:AbortSignal.timeout(20_000)});
      const data=await response.json() as {code?:number;msg?:string;access_token?:string;refresh_token?:string;expires_in?:number;refresh_token_expires_in?:number};
      if (!response.ok || data.code!==0 || !data.access_token) throw new Error(`飞书令牌刷新失败：${data.msg ?? response.status}`);
      binding.accessToken=data.access_token; binding.accessExpiresAt=now+(data.expires_in??7200);
      if(data.refresh_token)binding.refreshToken=data.refresh_token;if(data.refresh_token_expires_in)binding.refreshExpiresAt=now+data.refresh_token_expires_in;
      await this.repository.upsertIntegration("owner","feishu",this.secrets.encrypt(binding)); return data.access_token;
    })();
    try { return await this.refreshInFlight; } finally { this.refreshInFlight=null; }
  }

  /* 飞书的刷新令牌只有 7 天，而且一次性使用——每刷一次换发一个新的、重新给 7 天。
   * 只要在过期前刷到，这条链可以一直续下去（飞书的硬上限是授权满 365 天要重新授权）；
   * 一旦断了就只能让用户重新扫码。以前只在真要用飞书时才顺手刷，所以连续 7 天没发过
   * 飞书任务就必然断——2026-10-24 就是这么断的：10-10 授权、10-17 刷新令牌到期、
   * 10-24 两条任务全部失败，期间控制台还一直显示"已授权"。
   * 现在由后台巡检调用本方法，不管用不用飞书都保证续期。*/
  private static readonly RENEW_BEFORE_SEC = 3*24*3600;

  /** 返回 null = 还没授权过，没什么要续的。state=expired 时只能让用户重新授权。*/
  async keepAlive(): Promise<{state:"ok"|"renewed"|"expired";refreshExpiresAt:number}|null> {
    const row=await this.repository.getIntegration("owner","feishu");
    if (!row) return null;
    const binding=this.secrets.decrypt<Binding>(row.encryptedConfig);
    if (!binding.refreshToken) return null;
    const now=Math.floor(Date.now()/1000); const expiresAt=binding.refreshExpiresAt??0;
    if (expiresAt<=now) return { state:"expired", refreshExpiresAt:expiresAt };
    /* 不是每次都刷：每刷一次旧令牌立刻作废，万一刷新结果没落盘就等于把授权刷没了。
     * 剩不到 3 天才换，配合 6 小时一次的巡检，等于每 4 天换一次、过期前还有两次机会。*/
    if (expiresAt>now+FeishuUserExecutor.RENEW_BEFORE_SEC) return { state:"ok", refreshExpiresAt:expiresAt };
    await this.refresh(binding,now);
    return { state:"renewed", refreshExpiresAt:(await this.binding()).refreshExpiresAt??0 };
  }

  private async request(method:string,path:string,data?:Record<string,unknown>) {
    const response=await fetch(`${this.baseUrl}/open-apis${path}`,{method,headers:{authorization:`Bearer ${await this.token()}`,...(data?{"content-type":"application/json"}:{})},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(20_000)});
    const body=await response.json() as {code?:number;msg?:string;data?:Record<string,unknown>};
    /* 缺权限时飞书的原话是英文（requires xxx scope），换成能照着做的中文 */
    const scope=/requires ([\w.:]+) scope/.exec(body.msg??"")?.[1];
    /* 飞书平台限制：接口不能私聊外部（别的企业的）联系人，权限再全也不行（2026-10-08 实测） */
    if(/cross tenant p2p/.test(body.msg??""))throw new Error("对方是外部联系人，飞书不允许用接口私聊外部联系人。可以在飞书里建一个只有你们俩的群、群名就叫对方的名字，以后发消息会发到这个群");
    if(/operate external chats/.test(body.msg??""))throw new Error("这是外部群（有别的企业的人），飞书应用要先开通「对外共享」才能往外部群发消息：飞书开发者后台 → 应用发布 → 对外共享");
    if(scope)throw new Error(`飞书应用还没开通权限 ${scope}：到飞书开发者后台给应用开通（用户身份）并发布版本，再回「连接 → 飞书」点重新授权`);
    if(!response.ok||body.code!==0)throw new Error(`飞书请求失败：${body.msg ?? response.status}`);return body.data??{};
  }
  /* 建出来的任务必须有负责人。只写 summary 的话飞书照样返回成功、任务也真的存在，
   * 但它不在任何人的「我负责的」列表里，用户在飞书 App 里根本看不到——
   * 实测 20260919 建了好几条"成功"的任务，飞书里一条都找不到。*/
  private async assigneeOpenId(): Promise<string> {
    const cached = (await this.binding()).openId;
    if (cached) return cached;
    const info = await this.request("GET", "/authen/v1/user_info");
    const openId = String((info as { open_id?: unknown }).open_id ?? "");
    if (openId) {
      const fresh = await this.binding();          // token() 可能刚刷新过，重新读一份再存，别把新令牌写回旧的
      fresh.openId = openId;
      await this.repository.upsertIntegration("owner", "feishu", this.secrets.encrypt(fresh));
    }
    return openId;
  }

  /** 只读：列出多维表格某张表的字段名。「我的 → 记账」用它验证表 ID 和字段名对不对，不写任何数据 */
  async bitableFields(appToken:string,tableId:string):Promise<string[]>{
    const data=await this.request("GET",`/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields?page_size=100`);
    const items=(data.items as {field_name?:unknown}[]|undefined)??[];
    return items.map((f)=>String(f.field_name??"")).filter(Boolean);
  }

  /** 读一段时间内的消费记录，给「消费汇总」用。只读，不写。*/
  async expenseRecords(appToken:string,tableId:string,fields:{date:string;amount:string;category:string;note:string},
                       fromMs:number,toMs:number){
    const rows:{amount:number;category:string;note:string;at:number}[]=[];
    let pageToken:string|undefined;
    do{
      const path=`/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/search?page_size=200${pageToken?`&page_token=${pageToken}`:""}`;
      const data=await this.request("POST",path,{});
      for(const item of (data.items as {fields?:Record<string,unknown>}[]|undefined)??[]){
        const f=item.fields??{};
        const at=Number(f[fields.date]??0);
        if(!at||at<fromMs||at>=toMs)continue;
        const amount=Number(f[fields.amount]??0);
        if(!Number.isFinite(amount)||amount<=0)continue;
        /* 多维表格的文本字段可能是字符串，也可能是 [{text:"…"}] 这种富文本数组 */
        const plain=(v:unknown)=>Array.isArray(v)?v.map((x)=>typeof x==="object"&&x&&"text"in x?String((x as {text:unknown}).text):"").join(""):String(v??"");
        rows.push({amount,category:plain(f[fields.category])||"其他",note:plain(f[fields.note]),at});
      }
      pageToken=(data.has_more as boolean|undefined)?String(data.page_token??""):undefined;
    }while(pageToken);
    return rows;
  }

  /* 发消息给谁。语音里说的都是名字（「发消息给灰太狼」「发到AI自动化的这个群」），飞书只认 open_id / chat_id / 邮箱，
   * 以前名字原样塞进去，参数校验直接失败（2026-10-08）。名字按拼音比（语音常把字识别成同音字），找人和找群：
   *   1. 通讯录里读音相同的人、我所在的群里读音相同的群——只有一个就用它；有几个就交回去让人选
   *   2. 都没有：读音包含关系的群（「自动化」→「AI自动化」）同样处理
   *   3. 自动命名的群（「尼奥, 灰, 灰太狼」）：飞书用每个人在你这里的备注拼群名，外部联系人搜不到，
   *      但群里其余几个名字都能对上人的话，剩下那一个成员就是他
   * 都对不上就报错，说清楚——宁可不发，也不发错。*/
  private async resolveReceiver(raw:string,type:string):Promise<{id:string;type:string;label:string}>{
    /* 「AI自动化的这个群」→「AI自动化」：说群的时候总会带上"群"字 */
    const name=raw.trim().replace(/^(飞书)?群(聊)?[：:]?/,"").replace(/(的)?(这个|那个)?(飞书)?(群聊|群)$/,"").trim()||raw.trim();
    if(type==="open_id"&&name.startsWith("ou_"))return{id:name,type,label:name};
    if(type==="chat_id"&&name.startsWith("oc_"))return{id:name,type,label:name};
    if(type==="user_id"&&/^[A-Za-z0-9]+$/.test(name))return{id:name,type,label:name};
    if(name.includes("@"))return{id:name,type:"email",label:name};
    const key=sound(name);
    /* exactOnly：读音完全相同；否则搜索命中的都算（搜索也认备注名，「尼奥」能搜到真名「甘念麟」）*/
    const people=async(q:string,exactOnly:boolean)=>{
      const d=await this.request("GET",`/search/v1/user?query=${encodeURIComponent(q)}&page_size=20`);
      return ((d.users as {name?:string;open_id?:string}[]|undefined)??[])
        .filter((u)=>u.open_id&&(!exactOnly||sound(u.name??"")===sound(q))).map((u)=>({id:u.open_id!,name:u.name??""}));
    };
    const chats=await this.myChats(name);
    const cands:{id:string;type:string;label:string}[]=[];
    for(const p of await people(name,true))cands.push({id:p.id,type:"open_id",label:p.name});
    for(const c of chats.filter((c)=>sound(c.name)===key))cands.push({id:c.chat_id,type:"chat_id",label:`群「${c.name}」`});
    if(!cands.length&&key.length>=4)
      /* 自动命名的群（名字是成员拼起来的）不参与包含匹配：「灰太狼」该找人，不该落到「尼奥, 灰, 灰太狼」这个群 */
      for(const c of chats.filter((c)=>!/[,，、]/.test(c.name)&&(sound(c.name).includes(key)||(sound(c.name).length>=4&&key.includes(sound(c.name))))))
        cands.push({id:c.chat_id,type:"chat_id",label:`群「${c.name}」`});
    const uniq=[...new Map(cands.map((c)=>[c.id,c])).values()];
    if(uniq.length===1)return uniq[0]!;
    if(uniq.length>1)throw new NeedsChoiceError(`「${name}」对得上 ${uniq.length} 个，请选一个`,
      uniq.slice(0,4).map((c)=>({label:c.label,args:{receiveId:c.id,receiveIdType:c.type,receiveLabel:c.label}})));
    for(const chat of chats){
      const parts=chat.name.split(/[,，、]\s*/).map((x)=>x.trim()).filter(Boolean);
      if(!parts.some((p)=>sound(p)===key))continue;
      const m=await this.request("GET",`/im/v1/chats/${chat.chat_id}/members?member_id_type=open_id&page_size=50`);
      const members=((m.items as {member_id?:string;name?:string;tenant_key?:string}[]|undefined)??[]).filter((x)=>x.member_id);
      if(members.length!==parts.length)continue;
      const known=new Set<string>();let ok=true;
      for(const other of parts.filter((p)=>sound(p)!==key)){
        const hit=(await people(other,false)).filter((p)=>members.some((x)=>x.member_id===p.id));
        if(hit.length!==1){ok=false;break;}
        known.add(hit[0]!.id);
      }
      const rest=members.filter((x)=>!known.has(x.member_id!));
      if(ok&&rest.length===1){
        /* 外部联系人（别的企业）：飞书不许接口私聊（cross tenant p2p chat operate forbid），发到这个群 */
        const mine=new Set(members.filter((x)=>known.has(x.member_id!)).map((x)=>x.tenant_key));
        if(rest[0]!.tenant_key&&!mine.has(rest[0]!.tenant_key))
          return{id:chat.chat_id,type:"chat_id",label:`群「${chat.name}」（${name}是外部联系人，飞书不能私聊）`};
        return{id:rest[0]!.member_id!,type:"open_id",label:`${name}（飞书名「${rest[0]!.name??""}」）`};
      }
    }
    throw new Error(`飞书里没找到「${name}」这个人或群。可以说对方在飞书里的名字、群的全名，或者在网页上改收件人`);
  }

  /** 我所在的群：先用飞书搜索，再把最近的群全拉下来按读音比——同音字搜索是搜不到的 */
  private async myChats(query:string){
    const all=new Map<string,string>();
    const add=(items:unknown)=>{for(const c of (items as {name?:string;chat_id?:string}[]|undefined)??[])if(c.chat_id)all.set(c.chat_id,c.name??"");};
    add((await this.request("GET",`/im/v1/chats/search?query=${encodeURIComponent(query)}&page_size=20`)).items);
    let pageToken="";
    for(let page=0;page<5;page++){
      const d=await this.request("GET",`/im/v1/chats?page_size=100${pageToken?`&page_token=${pageToken}`:""}`);
      add(d.items);
      if(!d.has_more)break;
      pageToken=String(d.page_token??"");
    }
    return [...all].map(([chat_id,name])=>({chat_id,name}));
  }

  async execute(draft:ActionDraft):Promise<ToolReceipt>{
    const idem=createHash("sha256").update(draft.idempotencyKey).digest("hex").slice(0,50);
    if(draft.tool==="feishu.task.create"){
      const args=z.object({summary:z.string().min(1),description:z.string().default(""),dueTimestampMs:z.union([z.string(),z.number()]).optional(),allDay:z.boolean().default(false)}).parse(draft.args);
      const openId=await this.assigneeOpenId().catch(()=>"");
      const data=await this.request("POST","/task/v2/tasks?user_id_type=open_id",{summary:args.summary,description:args.description,client_token:idem,
        ...(openId?{members:[{id:openId,type:"user",role:"assignee"}]}:{}),
        ...(args.dueTimestampMs?{due:{timestamp:String(args.dueTimestampMs),is_all_day:args.allDay}}:{})});
      const task=data.task as Record<string,unknown>;return{provider:"feishu-user",externalId:String(task?.guid??""),result:task??{}};
    }
    if(draft.tool==="feishu.calendar.create"){
      const args=z.object({summary:z.string().min(1),startTimestamp:z.union([z.string(),z.number()]),endTimestamp:z.union([z.string(),z.number()]),description:z.string().default(""),timezone:z.string().default("Asia/Shanghai")}).parse(draft.args);
      const primary=await this.request("GET","/calendar/v4/calendars/primary");const calendars=primary.calendars as {calendar?:{calendar_id?:string}}[]|undefined;const calendarId=calendars?.[0]?.calendar?.calendar_id;if(!calendarId)throw new Error("无法获取飞书主日历");
      const data=await this.request("POST",`/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events?idempotency_key=${idem}`,{summary:args.summary,description:args.description,start_time:{timestamp:String(args.startTimestamp),timezone:args.timezone},end_time:{timestamp:String(args.endTimestamp),timezone:args.timezone}});
      const event=data.event as Record<string,unknown>;return{provider:"feishu-user",externalId:String(event?.event_id??""),result:event??{}};
    }
    if(draft.tool==="feishu.doc.create"){
      const args=z.object({title:z.string().min(1),folderToken:z.string().optional(),content:z.string().default("")}).parse(draft.args);
      const data=await this.request("POST","/docx/v1/documents",{title:args.title,...(args.folderToken?{folder_token:args.folderToken}:{})});const document=data.document as Record<string,unknown>;const id=String(document?.document_id??"");
      if(args.content&&id)await this.request("POST",`/docx/v1/documents/${id}/blocks/${id}/children`,{children:[{block_type:2,text:{elements:[{text_run:{content:args.content,text_element_style:{}}}],style:{}}}],index:0});
      return{provider:"feishu-user",externalId:id,result:{...document,url:`https://feishu.cn/docx/${id}`}};
    }
    /* 记一笔账：写进飞书多维表格的消费记录表。
     * 字段名可以在「我的 → 记账」里配，因为用户很可能已经有一张自己的表（不改人家的表结构）。*/
    if(draft.tool==="expense.record"){
      const args=z.object({appToken:z.string().min(1),tableId:z.string().min(1),
        amount:z.number(),category:z.string().default(""),note:z.string().default(""),
        /** 消费发生的时间（毫秒）；没说就是录音那一刻 */
        atMs:z.number().int(),
        fields:z.object({note:z.string(),dateText:z.string(),date:z.string(),amount:z.string(),category:z.string()}),
        notify:z.boolean().default(true)}).parse(draft.args);
      const bj=new Date(args.atMs+8*3600_000);
      const dayText=bj.toISOString().slice(0,10);
      const fields:Record<string,unknown>={[args.fields.note]:args.note||args.category||"消费",
        [args.fields.dateText]:dayText,[args.fields.date]:args.atMs,[args.fields.amount]:args.amount};
      if(args.category)fields[args.fields.category]=args.category;
      const data=await this.request("POST",`/bitable/v1/apps/${encodeURIComponent(args.appToken)}/tables/${encodeURIComponent(args.tableId)}/records`,{fields});
      const record=(data.record as Record<string,unknown>)??{};
      const url=`https://feishu.cn/base/${args.appToken}?table=${args.tableId}`;
      if(args.notify){
        /* 记完给自己发一条：手机上一眼就能确认记对没有，顺手点进表格 */
        const openId=await this.assigneeOpenId().catch(()=>"");
        if(openId)await this.request("POST","/im/v1/messages?receive_id_type=open_id",{receive_id:openId,msg_type:"text",
          content:JSON.stringify({text:`已记一笔：${args.amount} 元${args.category?`・${args.category}`:""}${args.note?`（${args.note}）`:""}\n${dayText}\n${url}`})}).catch(()=>undefined);
      }
      return{provider:"feishu-user",externalId:String(record.record_id??""),result:{...record,url,amount:args.amount,category:args.category}};
    }
    if(draft.tool==="feishu.message.send"){
      const args=z.object({receiveId:z.string().min(1),receiveIdType:z.string().default("name"),text:z.string().min(1)}).parse(draft.args);
      const to=await this.resolveReceiver(args.receiveId,args.receiveIdType);
      const data=await this.request("POST",`/im/v1/messages?receive_id_type=${to.type}`,{receive_id:to.id,msg_type:"text",content:JSON.stringify({text:args.text})});const message=data as Record<string,unknown>;return{provider:"feishu-user",externalId:String(message.message_id??""),result:{...message,sentTo:to.label}};
    }
    throw new Error(`尚未支持的飞书工具：${draft.tool}`);
  }
}

import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { api } from "../../api.ts";
import { LoadError, Skeleton, useLoad, useToast } from "../../ui/kit.tsx";
import { ThemePicker, type ThemeId } from "./ThemePicker.tsx";

/* 「我的」里的所有设置，按类分组。每组一张单子、自己一个保存按钮——
 * 改了 AI 开关不需要连带把定时开关机也重新提交一遍。*/

interface Schedule { enabled: boolean; offAt: string; onAt: string; mode: "hard" | "soft" }
type LedMode = "designed" | "dark_while_recording" | "off";
export interface Prefs {
  playbackGain: "clear" | "denoise" | "standard" | "loud" | "original";
  screenOffSec: number;
  screenWake: { onCard: boolean; onDone: boolean; onTap: boolean; doubleTapOff: boolean };
  deviceReceipts: "today" | "all";
  powerKey: "hard" | "soft";
  theme: ThemeId;
  reminders: { enabled: boolean; mode: "until_ack" | "auto_hide"; autoHideSec: number; vibrate: boolean; expireDays: 0 | 1 | 3 | 7 };
  audio: { quality: "smooth" | "standard" | "high"; chunkSec: 5 | 10 | 15 };
  vocabulary: string[];
  chatPrompts: string[];
  expense: { enabled: boolean; appToken: string; tableId: string;
    fields: { note: string; dateText: string; date: string; amount: string; category: string };
    categories: string[]; notifyFeishu: boolean };
  topicIntervalHours: number;
  ai: { topics: boolean; minutes: boolean; mindmap: boolean; scope: "topic" | "session"; chat: boolean;
        intentMode: "auto" | "push_to_talk"; daily: boolean; suggest: boolean; speakers: boolean };
}
export interface Settings {
  tier: "high" | "economy"; wakeWord: string; retentionDays: number; schedule: Schedule; ledMode: LedMode; prefs: Prefs;
}

export type SettingsGroup = "screen" | "audio" | "ai" | "expense" | "power";

const LED_OPTIONS: { value: LedMode; label: string; hint: string }[] = [
  { value: "designed", label: "按状态变色", hint: "录音红色呼吸，有待确认的事蓝色呼吸，离线缓存黄色慢闪，充电橙色呼吸。旁人一眼能看出它在录音。" },
  { value: "dark_while_recording", label: "录音时不亮", hint: "平时录音不亮灯，只在有待确认的事、离线、充电时亮。更低调，但旁人看不出它在录音。" },
  { value: "off", label: "全部关闭", hint: "指示灯一直不亮。状态只能看屏幕。" },
];
const SCREEN_OFF = [
  { sec: 5, label: "5 秒" }, { sec: 10, label: "10 秒" }, { sec: 20, label: "20 秒" }, { sec: 60, label: "1 分钟" }, { sec: 0, label: "不熄屏" },
];
const GAIN_OPTIONS = [
  { value: "clear", label: "清晰", hint: "推荐。不管离设备多远，都把人声拉到手机视频差不多的音量；拿东西、衣服蹭到机身这类突然的响声压下去，字和字之间的底噪也压低一点。" },
  { value: "denoise", label: "清晰+AI 降噪", hint: "在「清晰」的基础上再用 AI 模型（DeepFilterNet3）去掉空调、车流这类背景声。每段第一次播放要多等一两秒，之后就快了。偶尔会让人声有点发闷，觉得不自然就换回「清晰」。" },
  { value: "standard", label: "标准", hint: "回放和导出时放大 18dB。设备录得偏小，这一档听起来和正常说话差不多。" },
  { value: "loud", label: "更响", hint: "放大 26dB，适合对方离得远、声音很小的录音。很响的地方会被压住，不会爆音。" },
  { value: "original", label: "原声", hint: "不做任何处理，和设备录下的完全一样（会比较小声）。" },
] as const;

function Seg<T extends string | number>({ label, value, options, onChange, disabled }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean;
}) {
  return (
    <div className="seg" role="group" aria-label={label} style={{ alignSelf: "flex-start", flexWrap: "wrap" }}>
      {options.map((o) => (
        <button key={String(o.value)} aria-pressed={value === o.value} disabled={disabled} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

function Switch({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label htmlFor={id} style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--ink)", fontSize: 15, fontWeight: 600 }}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

const TITLES: Record<SettingsGroup, string> = {
  screen: "设备屏幕与指示灯", audio: "录音与回放", ai: "AI 助手", expense: "记账", power: "开关机与唤醒",
};

export function SettingsPanel({ group, canSetLed }: { group: SettingsGroup; canSetLed: boolean }) {
  const toast = useToast();
  const loaded = useLoad(() => api.get<{ settings: Settings }>("/v1/settings").then((r) => r.settings), []);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (loaded.data) setDraft(loaded.data); }, [loaded.data]);
  useEffect(() => { setError(null); if (loaded.data) setDraft(loaded.data); }, [group]);   // 切组丢掉没保存的改动
  /* 所有 Hook 都要放在下面的提前 return 之前：数据没到时先 return 了，到了又多调两个 Hook，
   * 两次渲染 Hook 数量对不上，React 直接崩（#310），「我的」整页白屏。*/
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; text: string } | null>(null);

  if (loaded.error && !draft) return <LoadError error={loaded.error} onRetry={() => void loaded.reload()} />;
  if (!draft) return <div className="sheet sheet-body"><Skeleton h={220} /></div>;

  const setPrefs = (patch: Partial<Prefs>) => setDraft({ ...draft, prefs: { ...draft.prefs, ...patch } });
  const setAi = (patch: Partial<Prefs["ai"]>) => setPrefs({ ai: { ...draft.prefs.ai, ...patch } });
  const setExpense = (patch: Partial<Prefs["expense"]>) => setPrefs({ expense: { ...draft.prefs.expense, ...patch } });
  /* 只读地列一遍表字段：先保存再查，查的是服务端存着的那份配置 */
  async function check() {
    setChecking(true); setCheckResult(null);
    try {
      if (draft) await api.put("/v1/settings", { prefs: { expense: draft.prefs.expense } });
      const r = await api.get<{ ok: boolean; fields: string[]; missing: string[] }>("/v1/expense/check");
      setCheckResult(r.ok
        ? { ok: true, text: `连上了，表里有 ${r.fields.length} 个字段，你填的都对得上` }
        : { ok: false, text: `表里没有这些字段：${r.missing.join("、")}。表里现有：${r.fields.join("、")}` });
    } catch (e) { setCheckResult({ ok: false, text: e instanceof Error ? e.message : "检查失败" }); }
    finally { setChecking(false); }
  }
  const sch = draft.schedule;
  const setSch = (patch: Partial<Schedule>) => setDraft({ ...draft, schedule: { ...sch, ...patch } });
  const half = /^(.+)\1$/.test(draft.wakeWord) ? draft.wakeWord.slice(0, draft.wakeWord.length / 2) : draft.wakeWord;
  const customOff = !SCREEN_OFF.some((o) => o.sec === draft.prefs.screenOffSec);

  async function save() {
    if (!draft) return;
    if (group === "power" && !/^[一-龥]{2,8}$/.test(draft.wakeWord)) { setError("唤醒词请用 2–8 个汉字"); return; }
    if (group === "power" && draft.schedule.enabled && draft.schedule.offAt === draft.schedule.onAt) { setError("关机和开机时间不能相同"); return; }
    setBusy(true); setError(null);
    const body: Record<string, unknown> =
      group === "screen" ? { prefs: { theme: draft.prefs.theme, screenOffSec: draft.prefs.screenOffSec, screenWake: draft.prefs.screenWake,
          deviceReceipts: draft.prefs.deviceReceipts, reminders: draft.prefs.reminders }, ...(canSetLed ? { ledMode: draft.ledMode } : {}) }
      : group === "audio" ? { tier: draft.tier, retentionDays: draft.retentionDays,
          prefs: { playbackGain: draft.prefs.playbackGain, audio: draft.prefs.audio, vocabulary: draft.prefs.vocabulary } }
      : group === "ai" ? { prefs: { topicIntervalHours: draft.prefs.topicIntervalHours, ai: draft.prefs.ai,
          chatPrompts: draft.prefs.chatPrompts.map((x) => x.trim()).filter(Boolean).slice(0, 8) } }
      : group === "expense" ? { prefs: { expense: draft.prefs.expense } }
      : { wakeWord: draft.wakeWord, schedule: draft.schedule, prefs: { powerKey: draft.prefs.powerKey } };
    try {
      await api.put("/v1/settings", body);
      const themeChanged = group === "screen" && loaded.data && draft.prefs.theme !== loaded.data.prefs.theme;
      toast(themeChanged ? "已保存。设备几秒内就会换上新主题"
        : group === "screen" || group === "power" ? "已保存。设备下一次心跳（1 分钟内）会同步" : "已保存");
      void loaded.reload();
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); }
    finally { setBusy(false); }
  }

  return (
    <section className="sheet" aria-labelledby="set-title">
      <div className="sheet-head">
        <h2 id="set-title">{TITLES[group]}</h2>
        <div className="end"><button className="btn go" onClick={() => void save()} disabled={busy}>{busy ? "保存中" : "保存"}</button></div>
      </div>
      <div className="sheet-body" style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        {group === "screen" && (
          <>
            <div className="field">
              <label>屏幕主题</label>
              <ThemePicker value={draft.prefs.theme} onChange={(v) => setPrefs({ theme: v })} />
              <span className="hint">
                选好点「保存」，设备几秒内就换上，不用重启、不打断录音。推过去的只是一份配色和形状（不到 1KB），
                设备只留当前这一套，换了就覆盖。
              </span>
            </div>
            <div className="field">
              <label id="off-label">多久不碰就熄屏</label>
              <Seg label="熄屏时间" value={customOff ? -1 : draft.prefs.screenOffSec}
                   options={[...SCREEN_OFF.map((o) => ({ value: o.sec, label: o.label })), { value: -1, label: "自定义" }]}
                   onChange={(v) => setPrefs({ screenOffSec: v === -1 ? 30 : v })} />
              {customOff && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                  <input type="number" min={1} max={3600} value={draft.prefs.screenOffSec} style={{ maxWidth: 120 }}
                         aria-label="熄屏秒数" onChange={(e) => setPrefs({ screenOffSec: Math.max(1, Math.min(3600, Number(e.target.value) || 1)) })} />
                  <span className="ink-2">秒</span>
                </div>
              )}
              <span className="hint">
                熄屏只关背光，录音照常。点一下屏幕、按任意键、或者有新的事要你确认时会自动亮（开关在下面）。
                屏幕是整机最耗电的部件之一，熄得越快越省电。亮度在设备上调：从屏幕顶部往下拉。
              </span>
            </div>
            <div className="field">
              <label>什么时候自动亮屏</label>
              <Switch id="wake-card" checked={draft.prefs.screenWake.onCard}
                      onChange={(v) => setPrefs({ screenWake: { ...draft.prefs.screenWake, onCard: v } })}>有事要我确认时亮屏</Switch>
              <span className="hint">设备听到需要你拍板的事，会震动并插一张卡片。关掉的话只振动，屏幕保持黑的。</span>
              <Switch id="wake-tap" checked={draft.prefs.screenWake.onTap}
                      onChange={(v) => setPrefs({ screenWake: { ...draft.prefs.screenWake, onTap: v } })}>点一下屏幕亮屏</Switch>
              <span className="hint">
                这一下只负责点亮，不会误按到卡片。关掉则只有按键能亮：熄屏时触摸芯片整个睡下，放口袋里不会被衣服蹭亮。
                开着本身几乎不费电，费电的是被蹭亮。
              </span>
              <Switch id="dtap-off" checked={draft.prefs.screenWake.doubleTapOff}
                      onChange={(v) => setPrefs({ screenWake: { ...draft.prefs.screenWake, doubleTapOff: v } })}>双击屏幕熄屏</Switch>
              <span className="hint">亮着时快速点两下屏幕空白处，立刻熄屏，不用等。点在卡片按钮上不算。</span>
              <Switch id="wake-done" checked={draft.prefs.screenWake.onDone}
                      onChange={(v) => setPrefs({ screenWake: { ...draft.prefs.screenWake, onDone: v } })}>事情办完时弹出来</Switch>
              <span className="hint">
                明确说出口的指令（按「执行规则」不用先问的那些）是直接办的。打开这个，办完设备亮屏、振一下，
                把办了什么、你当时的原话弹出来，点一下屏幕关掉；关掉则只在首页列表里悄悄多一条。
                哪类事办完要弹，在「执行规则」最右一列单独勾。
              </span>
            </div>
            <div className="field">
              <label>首页「已执行」显示哪些</label>
              <Seg label="首页回执范围" value={draft.prefs.deviceReceipts}
                   options={[{ value: "today" as const, label: "只看今天" }, { value: "all" as const, label: "累积" }]}
                   onChange={(v) => setPrefs({ deviceReceipts: v })} />
              <span className="hint">
                {draft.prefs.deviceReceipts === "today"
                  ? "只显示今天零点以后办完的事，第二天自动清空。"
                  : "没在设备上划掉的都留着，显示最近 4 条。想清掉哪条，在设备上把它往旁边划走。"}
              </span>
            </div>
            <div className="field">
              <Switch id="rem-on" checked={draft.prefs.reminders.enabled}
                      onChange={(v) => setPrefs({ reminders: { ...draft.prefs.reminders, enabled: v } })}>任务到点时提醒我</Switch>
              <span className="hint">
                说"明天给张总打电话"建的飞书任务，到了截止时间会在设备屏上弹一张卡。
                没说几点时按规矩算：上午 → 12:00，下午 → 18:00，其余 → 21:00。
                飞书自己也会提醒，但那要掏手机；这张卡是直接弹在你身上的设备上。
              </span>
              {draft.prefs.reminders.enabled && (
                <>
                  <div style={{ marginTop: 8 }}>
                    <Seg label="提醒怎么收起来" value={draft.prefs.reminders.mode}
                         options={[{ value: "until_ack" as const, label: "一直留着直到我按确认" },
                                   { value: "auto_hide" as const, label: "过几秒自动消失" }]}
                         onChange={(v) => setPrefs({ reminders: { ...draft.prefs.reminders, mode: v } })} />
                  </div>
                  {draft.prefs.reminders.mode === "auto_hide" && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                      <span className="ink-2">显示</span>
                      <select value={draft.prefs.reminders.autoHideSec} aria-label="自动消失秒数" style={{ width: "auto" }}
                              onChange={(e) => setPrefs({ reminders: { ...draft.prefs.reminders, autoHideSec: Number(e.target.value) } })}>
                        {[5, 10, 15, 30, 60].map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                      <span className="ink-2">秒后自动收起（也算你收到了）</span>
                    </div>
                  )}
                  {draft.prefs.reminders.mode === "until_ack" && (
                    <div style={{ marginTop: 8 }}>
                      <Seg label="一直没确认的提醒" value={draft.prefs.reminders.expireDays}
                           options={[{ value: 0 as const, label: "一直弹直到我确认" }, { value: 1 as const, label: "1 天后不再弹" },
                                     { value: 3 as const, label: "3 天后不再弹" }, { value: 7 as const, label: "7 天后不再弹" }]}
                           onChange={(v) => setPrefs({ reminders: { ...draft.prefs.reminders, expireDays: v } })} />
                      <span className="hint">
                        积压的旧提醒卡片上会写"（5 天前）"。选了几天后不再弹，过期的就静静留在网页的提醒列表里，不会再占设备屏幕。
                      </span>
                    </div>
                  )}
                  <div style={{ marginTop: 8 }}>
                    <Switch id="rem-vib" checked={draft.prefs.reminders.vibrate}
                            onChange={(v) => setPrefs({ reminders: { ...draft.prefs.reminders, vibrate: v } })}>弹出时震动</Switch>
                  </div>
                </>
              )}
            </div>
            <div className="field">
              <label id="led-label">指示灯</label>
              <Seg label="指示灯" value={draft.ledMode} disabled={!canSetLed}
                   options={LED_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} onChange={(v) => setDraft({ ...draft, ledMode: v })} />
              <span className="hint">
                {LED_OPTIONS.find((o) => o.value === draft.ledMode)?.hint}
                {!canSetLed && " 指示灯由管理员统一设置。"}
              </span>
            </div>
          </>
        )}

        {group === "audio" && (
          <>
            <div className="field">
              <label>录音音质</label>
              <Seg label="音质" value={draft.prefs.audio.quality}
                   options={[{ value: "smooth" as const, label: "流畅" }, { value: "standard" as const, label: "标准" }, { value: "high" as const, label: "高" }]}
                   onChange={(v) => setPrefs({ audio: { ...draft.prefs.audio, quality: v } })} />
              <span className="hint">
                {draft.prefs.audio.quality === "smooth"
                  ? "16 kbps：流量最少。安静环境下转写基本无差，嘈杂环境会差一些。"
                  : draft.prefs.audio.quality === "high"
                    ? "32 kbps、高编码复杂度：录音时设备主频要翻倍，更费电，流量多三成。转写准确率实测和标准档没有差别。"
                    : "24 kbps、省电编码：默认档。黑屏录音时设备只跑最低主频。"}
                下一块录音就生效，不用重启设备。
              </span>
            </div>
            <div className="field">
              <label htmlFor="vocab">专业术语词库</label>
              <textarea id="vocab" rows={3} value={draft.prefs.vocabulary.join("，")} maxLength={2000}
                        placeholder="人名、产品名、行业词，逗号分隔。比如：张伟，VoxMind，ML307C，多维表格"
                        onChange={(e) => setPrefs({ vocabulary: e.target.value.split(/[，,\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 100) })}
                        style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--rule-strong)",
                                 font: "inherit", fontSize: 15, resize: "vertical" }} />
              <span className="hint">
                识别时会把这些词当提示，人名、产品名、行业术语才不会被听成别的字（"沃克斯麦"→VoxMind）。
                最多 100 个，每次识别取前 60 个。留空就是不加提示。
              </span>
            </div>
            <div className="field">
              <label>每块录多少秒</label>
              <Seg label="块长" value={draft.prefs.audio.chunkSec}
                   options={[{ value: 5 as const, label: "5 秒" }, { value: 10 as const, label: "10 秒" }, { value: 15 as const, label: "15 秒" }]}
                   onChange={(v) => setPrefs({ audio: { ...draft.prefs.audio, chunkSec: v } })} />
              <span className="hint">
                每块不管多长都要花掉约 1.2 KB 的固定开销（请求头、响应头、TCP）。5 秒一块时这部分占了音频本身的两成；
                改成 15 秒能省下约三分之二的这部分流量，代价是转写晚 10 秒出来、掉电时最多丢 15 秒而不是 5 秒。
                为了不把时间轴算错，下一次开机（或暂停后继续）才生效。
              </span>
            </div>
            <div className="field">
              <label>识别档位</label>
              <Seg label="识别档位" value={draft.tier} options={[{ value: "high", label: "高质量" }, { value: "economy", label: "经济" }]}
                   onChange={(v) => setDraft({ ...draft, tier: v })} />
              <span className="hint">
                {draft.tier === "high"
                  ? "云端千问语音识别 + 更强的意图模型，判断最准。"
                  : "意图判断改用便宜 5 倍的模型；服务器升级后识别也改在本地跑，成本再降一截。明确说出的指令照样能识别，含糊的推测会少一些。"}
              </span>
            </div>
            <div className="field">
              <label>回放音量</label>
              <Seg label="回放声音" value={draft.prefs.playbackGain}
                   options={GAIN_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} onChange={(v) => setPrefs({ playbackGain: v })} />
              <span className="hint">{GAIN_OPTIONS.find((o) => o.value === draft.prefs.playbackGain)?.hint} 只影响网页回放和导出，服务器上的原始录音不变。</span>
            </div>
            <div className="field">
              <label htmlFor="retention">录音保留期</label>
              <select id="retention" value={draft.retentionDays} style={{ maxWidth: 220 }}
                      onChange={(e) => setDraft({ ...draft, retentionDays: Number(e.target.value) })}>
                <option value={0}>一直保留</option>
                {[7, 30, 90, 180, 365].map((d) => <option key={d} value={d}>{d} 天</option>)}
              </select>
              <span className="hint">
                {draft.retentionDays === 0
                  ? "录音和转写会一直留着，直到你自己删。"
                  : `超过 ${draft.retentionDays} 天的录音和转写会自动删除，每 6 小时清理一次。收藏的录音一直保留；已经生成的动作记录也不会被删掉。`}
              </span>
            </div>
          </>
        )}

        {group === "ai" && (
          <>
            <p className="ink-2" style={{ fontSize: 14, fontWeight: 500, maxWidth: "64ch" }}>
              下面这些都会调用大模型、按用量计费。关掉的只是"自动做"；在录音页里手动点「生成」随时都可以。
            </p>
            <MyCosts />
            <div className="field">
              <Switch id="ai-topics" checked={draft.prefs.ai.topics} onChange={(v) => setAi({ topics: v })}>自动拆主题</Switch>
              <span className="hint">把一次开机录下的内容按话题切开，比如上午拜访客户 A、午饭、下午拜访客户 B。关机后拆一次；一直开着就每隔一段时间拆一次。</span>
              {draft.prefs.ai.topics && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                  <span className="ink-2">一直开机时，每</span>
                  <select value={draft.prefs.topicIntervalHours} aria-label="拆主题间隔（小时）" style={{ width: "auto" }}
                          onChange={(e) => setPrefs({ topicIntervalHours: Number(e.target.value) })}>
                    {[1, 2, 3, 4, 6, 8, 12, 24].map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                  <span className="ink-2">小时拆一次</span>
                </div>
              )}
            </div>
            <div className="field">
              <Switch id="ai-minutes" checked={draft.prefs.ai.minutes} onChange={(v) => setAi({ minutes: v })}>自动生成会议纪要</Switch>
              <span className="hint">要点、结论、待办、谁说了什么。</span>
            </div>
            <div className="field">
              <Switch id="ai-speakers" checked={draft.prefs.ai.speakers} onChange={(v) => setAi({ speakers: v })}>
                纪要里分清谁说的
              </Switch>
              <span className="hint">
                生成会议纪要前，先把这一段整体做一次带说话人分离的转写，纪要里就会写清是谁说的、谁负责。
                代价：这一段音频会被按秒再转一次（多一份转写钱），生成也会慢一两分钟。结果会存下来，
                重新生成纪要不再重复收费。关掉就是现在这样——内容全在，只是不分人。
              </span>
            </div>
            <div className="field">
              <Switch id="ai-mindmap" checked={draft.prefs.ai.mindmap} onChange={(v) => setAi({ mindmap: v })}>自动生成思维导图</Switch>
              <span className="hint">把一段内容的主题和分支画成一张图。</span>
            </div>
            {(draft.prefs.ai.minutes || draft.prefs.ai.mindmap) && (
              <div className="field">
                <label>纪要和导图按什么生成</label>
                <Seg label="生成范围" value={draft.prefs.ai.scope}
                     options={[{ value: "topic", label: "每个主题一份" }, { value: "session", label: "每次录音一份" }]}
                     onChange={(v) => setAi({ scope: v })} />
                <span className="hint">
                  {draft.prefs.ai.scope === "topic"
                    ? "每拆出一个主题就生成一份，适合一天见好几拨人。需要先打开「自动拆主题」。"
                    : "一次开机录下的内容合成一份，适合每次开机只做一件事。"}
                </span>
              </div>
            )}
            <div className="field">
              <label>什么时候识别要办的事（总设置）</label>
              <Seg label="识别时机" value={draft.prefs.ai.intentMode}
                   options={[{ value: "auto" as const, label: "全自动识别" }, { value: "push_to_talk" as const, label: "按住确认键才识别" }]}
                   onChange={(v) => setAi({ intentMode: v })} />
              <span className="hint">
                {draft.prefs.ai.intentMode === "auto"
                  ? "所有说话都过一遍模型，听到「明天十点给王总回电话」就生成动作卡片。省事，但闲聊也会被分析，花的钱多一些。"
                  : "录音照常一直录，不会中断；只有按住设备上的确认键说的那几句会拿去抽任务（松手后再多算 8 秒）。误建任务最少。"}
              </span>
            </div>
            <div className="field">
              <Switch id="ai-suggest" checked={draft.prefs.ai.suggest} onChange={(v) => setAi({ suggest: v })}>
                找出「说过但没让我办」的事
              </Switch>
              <span className="hint">
                拆主题时顺手扫一遍那一段：像是要办的事、要记的账会列在主题卡片、「今天」页和任务中心的「建议」里，
                点一下才真的建，它不会擅自动手。设成「按住确认键说的才分析」时特别有用——忘了按也有人兜底。
                一个主题只问一次便宜模型，整段里连钱数、时间词都没有就直接跳过，不花钱。
              </span>
            </div>
            <div className="field">
              <Switch id="ai-daily" checked={draft.prefs.ai.daily} onChange={(v) => setAi({ daily: v })}>每晚写一份每日小结</Switch>
              <span className="hint">晚上 21:30 以后，把今天的主题、纪要里的待办、办了和没办的事汇成一页，放在「今天」页。
                只用已经拆好的主题和概要，不重新读一遍全天原文，一天一般几分钱。
                想换时间、或者写完直接发到飞书，去「自动化」里建一条「写今天的小结」；
                两边都开也不会多花钱——当天已经写过就直接拿来用。</span>
            </div>
            <div className="field">
              <Switch id="ai-chat" checked={draft.prefs.ai.chat} onChange={(v) => setAi({ chat: v })}>AI 聊天</Switch>
              <span className="hint">在「聊天」里用文字问录音里的事，或者让它导出、建飞书任务。
                要不要先问你，和「执行规则」里的设置一致。</span>
            </div>
            <div className="field">
              <label htmlFor="chat-prompts">聊天快捷问题</label>
              <textarea id="chat-prompts" rows={5} maxLength={600} value={draft.prefs.chatPrompts.join("\n")}
                        onChange={(e) => setPrefs({ chatPrompts: e.target.value.split("\n").slice(0, 8) })} />
              <span className="hint">一行一个，最多 8 个、每个 60 字以内。打开「聊天」时显示成按钮，点一下就问。
                放你最常问的，比如「这周和李总聊了什么？」「今天记了哪些账？」。</span>
            </div>
          </>
        )}

        {group === "expense" && (
          <>
            <div className="field">
              <Switch id="ex-on" checked={draft.prefs.expense.enabled}
                      onChange={(v) => setExpense({ enabled: v })}>说「花了多少」就记一笔账</Switch>
              <span className="hint">
                听到"午饭花了 68""打车 25 块"这种，写进你飞书多维表格里的消费记录表。
                按住确认键说「记账，午饭花了 68」最准；开着全自动时，闲聊里提到花钱也会被记下来。
                想只在按住时记，到「执行规则」里把「记一笔账」设成"只在按住时"。
              </span>
            </div>
            <div className="field">
              <label htmlFor="ex-app">多维表格 app_token</label>
              <input id="ex-app" type="text" value={draft.prefs.expense.appToken} maxLength={100} placeholder="表格链接里 /base/ 后面那一串"
                     onChange={(e) => setExpense({ appToken: e.target.value.trim() })} />
              <label htmlFor="ex-table" style={{ marginTop: 8 }}>数据表 table_id</label>
              <input id="ex-table" type="text" value={draft.prefs.expense.tableId} maxLength={100} placeholder="链接里 ?table= 后面那一串"
                     onChange={(e) => setExpense({ tableId: e.target.value.trim() })} />
              <span className="hint">
                在飞书里打开你的消费记录表，地址长这样：feishu.cn/base/<b>app_token</b>?table=<b>table_id</b>，把两段分别填进来。
                用的是你自己的飞书授权，所以只能写你有权限的表。
              </span>
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                <button className="btn sm" disabled={checking} onClick={() => void check()}>{checking ? "检查中" : "测试连接"}</button>
                {checkResult && <span className={checkResult.ok ? "ink-2" : "error-text"} style={{ fontSize: 13 }}>{checkResult.text}</span>}
              </div>
            </div>
            <div className="field">
              <label>表里的字段名</label>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
                {([["amount", "金额"], ["category", "类别"], ["note", "备注"], ["date", "日期"], ["dateText", "日期文本"]] as const).map(([key, label]) => (
                  <label key={key} style={{ fontSize: 13, color: "var(--ink-2)" }}>
                    {label}
                    <input type="text" value={draft.prefs.expense.fields[key]} maxLength={40} aria-label={`${label}字段名`}
                           onChange={(e) => setExpense({ fields: { ...draft.prefs.expense.fields, [key]: e.target.value } })} />
                  </label>
                ))}
              </div>
              <span className="hint">按你表里的真实列名填，我们不会去改你的表结构。</span>
            </div>
            <div className="field">
              <label htmlFor="ex-cats">类别（逗号分隔）</label>
              <input id="ex-cats" type="text" value={draft.prefs.expense.categories.join("，")} maxLength={300}
                     onChange={(e) => setExpense({ categories: e.target.value.split(/[，,]/).map((x) => x.trim()).filter(Boolean).slice(0, 30) })} />
              <span className="hint">要和表里「类别」那一列的选项对得上。模型给出别的类别时，一律记成"其他"。</span>
            </div>
            <div className="field">
              <Switch id="ex-notify" checked={draft.prefs.expense.notifyFeishu}
                      onChange={(v) => setExpense({ notifyFeishu: v })}>记完给我发一条飞书消息</Switch>
              <span className="hint">写进表之后，飞书上收到"已记一笔：68 元・餐饮（午饭）"，带表格链接，手机上一眼能核对。</span>
            </div>
          </>
        )}

        {group === "power" && (
          <>
            <div className="field">
              <label>长按录音键</label>
              <Seg label="长按录音键" value={draft.prefs.powerKey}
                   options={[{ value: "hard" as const, label: "真关机" }, { value: "soft" as const, label: "软关机" }]}
                   onChange={(v) => setPrefs({ powerKey: v })} />
              <span className="hint">
                {draft.prefs.powerKey === "hard"
                  ? "最省电：麦克风、4G、屏幕全部断电，屏幕全黑。再长按录音键开机。"
                  : "不录音、不上传，但麦克风一直开着，随时能说「唤醒词，开机」。软关机状态下再长按一次就是真关机。"}
              </span>
              {draft.prefs.powerKey === "soft" && (
                <div className="notice" role="note">
                  <AlertTriangle aria-hidden />
                  <div><b>软关机很耗电。</b>为了能听见唤醒词，处理器和麦克风一直在工作，放一晚会明显掉电。只是想关掉不用，选「真关机」。</div>
                </div>
              )}
            </div>
            <div className="field">
              <label htmlFor="wake">唤醒词</label>
              <input id="wake" type="text" value={draft.wakeWord} maxLength={8} style={{ maxWidth: 220 }}
                     onChange={(e) => setDraft({ ...draft, wakeWord: e.target.value.trim() })} />
              <span className="hint">
                用法：「{draft.wakeWord}，关机」「{draft.wakeWord}，开机」。叫两声更稳，但识别到一声「{half}」就算。
                目前唤醒词只管开机和关机，其他话照常实时分析。
              </span>
            </div>
            <div className="field">
              <Switch id="sch-on" checked={sch.enabled} onChange={(v) => setSch({ enabled: v })}>定时开关机</Switch>
              {sch.enabled && (
                <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 6 }}>
                  <div className="form-row" style={{ maxWidth: 420 }}>
                    <div className="field"><label htmlFor="off-at">每天关机</label>
                      <input id="off-at" type="time" value={sch.offAt} onChange={(e) => setSch({ offAt: e.target.value })} /></div>
                    <div className="field"><label htmlFor="on-at">每天开机</label>
                      <input id="on-at" type="time" value={sch.onAt} onChange={(e) => setSch({ onAt: e.target.value })} /></div>
                  </div>
                  <div className="field">
                    <label>到点怎么关</label>
                    <Seg label="关机方式" value={sch.mode} options={[{ value: "hard", label: "真关机" }, { value: "soft", label: "软关机" }]}
                         onChange={(v) => setSch({ mode: v })} />
                    <span className="hint">
                      {sch.mode === "hard"
                        ? "最省电：麦克风、4G、屏幕全断电，到开机时间自动开机。关机期间只能长按录音键开机。开机时间可能早几分钟（板子上没有精准计时晶振，宁早勿晚）。"
                        : "关机期间不录音、不上传，但麦克风开着，随时能说「唤醒词，开机」。"}
                    </span>
                  </div>
                  {sch.mode === "soft" && (
                    <div className="notice" role="note">
                      <AlertTriangle aria-hidden />
                      <div><b>软关机很耗电。</b>为了能听见「{half}，开机」，关机期间处理器和麦克风一直在工作，耗电比真关机高很多，
                        一整晚下来会明显掉电。只是想省电和保护隐私的话，选「真关机」。</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>
    </section>
  );
}

/* 每个功能花了多少：关哪个开关省多少，一眼看得出来 */
const FEATURE_LABEL: Record<string, string> = {
  asr: "语音转文字", intent: "从说话里抽任务", topics: "拆主题", minutes: "会议纪要", mindmap: "思维导图",
  chat: "AI 聊天", search: "按意思搜索", daily: "每日小结", other: "其他（早期记录）",
};
interface CostRow { feature: string; today: number; week: number; month: number; calls: number }

function MyCosts() {
  const costs = useLoad(() => api.get<{ features: CostRow[] }>("/v1/my-costs").then((r) => r.features), []);
  if (costs.error) return null;
  if (!costs.data) return <Skeleton h={120} />;
  if (!costs.data.length) return null;
  const yuan = (v: number) => `¥${v.toFixed(v > 0 && v < 1 ? 3 : 2)}`;
  const sum = (k: "today" | "week" | "month") => costs.data!.reduce((n, r) => n + r[k], 0);
  return (
    <div className="table-scroll">
      <table className="ledger">
        <thead><tr><th>花在哪</th><th className="right">今天</th><th className="right">近 7 天</th><th className="right">近 30 天</th></tr></thead>
        <tbody>
          {costs.data.map((r) => (
            <tr key={r.feature}><td>{FEATURE_LABEL[r.feature] ?? r.feature}</td>
              <td className="right mono">{yuan(r.today)}</td><td className="right mono">{yuan(r.week)}</td><td className="right mono">{yuan(r.month)}</td></tr>
          ))}
          <tr><td><b>合计</b></td><td className="right mono"><b>{yuan(sum("today"))}</b></td>
            <td className="right mono"><b>{yuan(sum("week"))}</b></td><td className="right mono"><b>{yuan(sum("month"))}</b></td></tr>
        </tbody>
      </table>
    </div>
  );
}

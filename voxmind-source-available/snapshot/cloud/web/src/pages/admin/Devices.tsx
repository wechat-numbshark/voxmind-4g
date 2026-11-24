import { useRef, useState, type FormEvent } from "react";
import { Ban, Copy, KeyRound, Plus, Trash2, Upload } from "lucide-react";
import { api, type Device, type FirmwareRelease, type FirmwareRollout, type Me, type User } from "../../api.ts";
import { ago, bytes, hhmm, stamp } from "../../format.ts";
import { LoadError, Skeleton, useLoad, useToast } from "../../ui/kit.tsx";
import { PageHead } from "../../ui/Shell.tsx";

export function Devices({ me, path }: { me: Me; path: string }) {
  const toast = useToast();
  const devices = useLoad(() => api.get<{ devices: Device[] }>("/v1/devices").then((r) => r.devices), [], 30000);
  const users = useLoad(() => api.get<{ users: User[] }>("/v1/users").then((r) => r.users), []);
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<{ device: Device; key: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  /* 固件列表和设备一起轮询：正在升级的时候，进度就是靠这个动的 */
  const firmware = useLoad(() => api.get<{ releases: FirmwareRelease[] }>("/v1/admin/firmware").then((r) => r.releases), [], 15000);
  const owner = (id: string) => users.data?.find((u) => u.id === id)?.displayName ?? id;

  async function revoke(d: Device) {
    try {
      const r = await api.post<{ device: Device }>(`/v1/devices/${encodeURIComponent(d.id)}/revoke`);
      devices.setData((all) => (all ?? []).map((x) => x.id === d.id ? r.device : x));
      toast(`${d.name} 的密钥已吊销，它从现在起无法上传或接收卡片`);
    } catch (e) { toast(e instanceof Error ? e.message : "吊销失败", true); }
    finally { setConfirmRevoke(null); }
  }

  return (
    <>
      <PageHead title="设备" me={me} path={path}>
        <button className="btn go" onClick={() => { setIssuing((v) => !v); setIssued(null); }}><Plus aria-hidden />{issuing ? "收起" : "发放设备"}</button>
      </PageHead>
      <div className="work-body">
        {issued && <IssuedKey issued={issued} onDone={() => setIssued(null)} />}
        {issuing && !issued && users.data && (
          <IssueForm users={users.data} onIssued={(r) => { setIssued(r); setIssuing(false); devices.setData((all) => [...(all ?? []), r.device]); }} />
        )}
        {devices.error && !devices.data && <LoadError error={devices.error} onRetry={() => void devices.reload()} />}
        <div className="bay">
          <div className="bay-head"><h2>设备 <span className="mono">{devices.data ? devices.data.length : "–"}</span></h2></div>
          {!devices.data && !devices.error && <div className="bay-stack">{[0, 1].map((i) => <Skeleton key={i} h={72} />)}</div>}
          {devices.data?.length === 0 && (
            <div className="empty-bay"><p><b>还没有登记的设备</b>
              现在的实板用的是部署时的共享密钥，照常上传。给每台设备发一把自己的密钥后，丢了可以单独吊销，这里也能看到电量和在线状态。</p></div>
          )}
          {devices.data && devices.data.length > 0 && (
            <div className="bay-stack">
              {devices.data.map((d) => {
                const online = d.status === "active" && d.lastSeenAt !== null && Date.now() - Date.parse(d.lastSeenAt) < 600_000;
                const state = d.status === "revoked" ? "吊销" : online ? "在线" : "离线";
                return (
                  /* 设备单用中性灰卡槽：卡槽颜色只表示风险等级，设备没有风险等级 */
                  <article key={d.id} className={`strip ${d.status === "revoked" ? "done" : "neutral"}`}>
                    <div className="grip" aria-hidden>{state}</div>
                    <div className="paper">
                      <div className="cell when">
                        <span className="t">{d.lastSeenAt ? hhmm(d.lastSeenAt) : "––:––"}</span>
                        <span className="src">{ago(d.lastSeenAt)}</span>
                      </div>
                      <div className="cell what">
                        <div className="head"><span className="tool">{owner(d.userId)}</span><div className="title">{d.name}</div></div>
                        <div className="detail mono" style={{ fontSize: 13 }}>
                          {d.id} · 密钥 {d.keyPrefix}…{d.firmware ? ` · 固件 ${d.firmware}` : ""}
                        </div>
                        <OtaLine device={d} />
                      </div>
                      <div className="cell sign">
                        <span className="clock" style={{ fontSize: 17 }}>
                          {d.lastBatteryPct === null ? "–" : `${d.lastCharging ? "⚡" : ""}${d.lastBatteryPct}%`}
                          <small>{d.lastNetwork ?? "网络未知"}</small>
                        </span>
                        <div className="sign-row">
                          {d.status === "revoked" ? <span className="verdict bad"><Ban aria-hidden />已吊销</span>
                            : confirmRevoke === d.id ? (
                              <>
                                <button className="btn sm" onClick={() => setConfirmRevoke(null)}>取消</button>
                                <button className="btn sm no" onClick={() => void revoke(d)}>确认吊销</button>
                              </>
                            ) : <button className="btn sm no" onClick={() => setConfirmRevoke(d.id)}>吊销</button>}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
        <Firmware releases={firmware.data} devices={devices.data ?? []}
                  onChanged={() => { void firmware.reload(); void devices.reload(); }} />
        {confirmRevoke && <p className="ink-2" style={{ fontSize: 13, fontWeight: 500, padding: "0 4px" }}>吊销后这台设备立刻无法上传或接收卡片，不能恢复，只能重新发放。</p>}
      </div>
    </>
  );
}

function IssueForm({ users, onIssued }: { users: User[]; onIssued: (r: { device: Device; key: string }) => void }) {
  const [form, setForm] = useState({ id: "", name: "", userId: users[0]?.id ?? "owner" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form.id || !form.name) { setError("设备编号和名字都要填"); return; }
    setBusy(true); setError(null);
    try { onIssued(await api.post<{ device: Device; key: string }>("/v1/devices", form)); }
    catch (err) { setError(err instanceof Error ? err.message : "发放失败"); }
    finally { setBusy(false); }
  }

  return (
    <form className="sheet" onSubmit={(e) => void submit(e)} aria-labelledby="issue-title">
      <div className="sheet-head"><h2 id="issue-title">发放设备</h2></div>
      <div className="sheet-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="form-row">
          <div className="field"><label htmlFor="dv-id">设备编号</label>
            <input id="dv-id" type="text" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value.trim() })} placeholder="demo-voxmind-not-a-real-device-2" />
            <span className="hint">和固件里的 DEVICE_ID 一致</span></div>
          <div className="field"><label htmlFor="dv-name">名字</label>
            <input id="dv-name" type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="张伟的录音器" /></div>
          <div className="field"><label htmlFor="dv-user">归属用户</label>
            <select id="dv-user" value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
              {users.filter((u) => u.status === "active").map((u) => <option key={u.id} value={u.id}>{u.displayName}（{u.email}）</option>)}
            </select></div>
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
        <div><button className="btn go" type="submit" disabled={busy}><KeyRound aria-hidden />{busy ? "正在生成" : "生成密钥"}</button></div>
      </div>
    </form>
  );
}

/** 明文密钥只有这一次。页面上反复提醒，并直接给出能粘进串口的那一行。 */
function IssuedKey({ issued, onDone }: { issued: { device: Device; key: string }; onDone: () => void }) {
  const toast = useToast();
  const line = `setup\t${issued.key}`;
  async function copy(text: string, what: string) {
    try { await navigator.clipboard.writeText(text); toast(`已复制${what}`); }
    catch { toast("浏览器不允许复制，请手动选中", true); }
  }
  return (
    <section className="strip" data-tier="ext" aria-labelledby="key-title">
      <div className="grip" aria-hidden>密钥</div>
      <div className="paper" style={{ gridTemplateColumns: "1fr" }}>
        <div className="cell" style={{ display: "flex", flexDirection: "column", gap: 12, padding: 18 }}>
          <div>
            <h2 id="key-title">{issued.device.name} 的密钥</h2>
            <p className="ink-2" style={{ fontSize: 14, marginTop: 4 }}>
              只显示这一次。服务器只存了它的哈希，关掉这里就再也找不回来——丢了只能吊销重发。
            </p>
          </div>
          <div className="key-reveal">{issued.key}</div>
          <p className="ink-2" style={{ fontSize: 14 }}>
            写入设备：USB 连上设备，打开 115200 波特率串口，粘贴下面这一行并回车，设备会保存并重启。
          </p>
          <div className="key-reveal" style={{ borderColor: "var(--rule-strong)" }}>setup⇥{issued.key}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => void copy(issued.key, "密钥")}><Copy aria-hidden />复制密钥</button>
            <button className="btn" onClick={() => void copy(line, "串口配置行")}><Copy aria-hidden />复制串口配置行</button>
            <button className="btn go" onClick={onDone}>我已经写入设备</button>
          </div>
        </div>
      </div>
    </section>
  );
}

const OTA_LABEL: Record<Device["otaState"], string> = {
  idle: "", offered: "已下发，等设备来取", downloading: "下载中", verifying: "校验中",
  rebooting: "重启中", done: "已升级", failed: "升级失败",
};

/** 升级到哪一步了。idle 时什么都不画——绝大多数时候设备就是在正常录音。 */
function OtaLine({ device }: { device: Device }) {
  if (device.otaState === "idle") return null;
  const bad = device.otaState === "failed";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, fontSize: 13, fontWeight: 600 }}>
      <span className={bad ? "verdict bad" : "pill"}>{OTA_LABEL[device.otaState]}</span>
      {!bad && device.otaState !== "done" && (
        <span aria-hidden style={{ flex: "0 1 140px", height: 6, borderRadius: 3, background: "var(--paper-2)", overflow: "hidden" }}>
          <span style={{ display: "block", width: `${device.otaProgressPct}%`, height: "100%", background: "var(--act)" }} />
        </span>
      )}
      <span className="ink-2">{bad ? device.otaError ?? "原因不明" : `${device.otaProgressPct}%`} · {ago(device.otaUpdatedAt)}</span>
    </div>
  );
}

const ROLLOUT_LABEL: Record<FirmwareRollout, string> = { none: "没在推", all: "推给全部设备", devices: "只推给指定设备" };

/* 固件与远程升级。
 * 版本号是从镜像里读出来的，不让人填——界面写一个版本、实际刷进另一个，是最坏的一种错。
 * 推送默认关着：传上来只是放在这里，要谁升是另一次明确的操作。*/
function Firmware({ releases, devices, onChanged }: { releases: FirmwareRelease[] | null; devices: Device[]; onChanged: () => void }) {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    try {
      const r = await api.upload<{ release: FirmwareRelease }>(`/v1/admin/firmware?notes=${encodeURIComponent(file.name)}`, file);
      toast(`已收下 ${r.release.version}（${bytes(r.release.byteLength)}），还没推给任何设备`);
      onChanged();
    } catch (e) { toast(e instanceof Error ? e.message : "上传失败", true); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ""; }
  }

  async function setRollout(release: FirmwareRelease, rollout: FirmwareRollout, deviceIds: string[] = []) {
    setBusy(true);
    try {
      await api.patch(`/v1/admin/firmware/${release.id}`, { rollout, deviceIds });
      toast(rollout === "none" ? `${release.version} 已停止推送`
        : rollout === "all" ? `${release.version} 开始推给全部设备`
        : `${release.version} 开始推给 ${deviceIds.length} 台设备`);
      setPicking(null); setPicked([]);
      onChanged();
    } catch (e) { toast(e instanceof Error ? e.message : "改推送范围失败", true); }
    finally { setBusy(false); }
  }

  async function remove(release: FirmwareRelease) {
    setBusy(true);
    try { await api.del(`/v1/admin/firmware/${release.id}`); toast(`已删除 ${release.version}`); onChanged(); }
    catch (e) { toast(e instanceof Error ? e.message : "删除失败", true); }
    finally { setBusy(false); setConfirmDelete(null); }
  }

  return (
    <div className="bay">
      <div className="bay-head">
        <h2>固件 <span className="mono">{releases ? releases.length : "–"}</span></h2>
        <input ref={fileInput} type="file" accept=".bin" hidden
               onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        <button className="btn go" disabled={busy} onClick={() => fileInput.current?.click()}>
          <Upload aria-hidden />{busy ? "处理中" : "上传固件"}
        </button>
      </div>
      {!releases && <div className="bay-stack">{[0, 1].map((i) => <Skeleton key={i} h={72} />)}</div>}
      {releases?.length === 0 && (
        <div className="empty-bay"><p><b>还没有上传过固件</b>
          传 <span className="mono">build/voxmind.bin</span>。版本号、编译时间和 IDF 版本都从镜像里读，不用填。
          传上来默认谁都不推，要升级是另一次明确的操作。设备走双分区升级，刷坏了会自动回滚到上一版。</p></div>
      )}
      {releases && releases.length > 0 && (
        <div className="bay-stack">
          {releases.map((r) => {
            const targets = r.rollout === "all" ? devices.filter((d) => d.status === "active")
              : devices.filter((d) => r.rolloutDeviceIds.includes(d.id));
            const upgraded = targets.filter((d) => d.firmware === r.version).length;
            return (
              <article key={r.id} className={`strip ${r.rollout === "none" ? "neutral" : ""}`} data-tier={r.rollout === "none" ? undefined : "phy"}>
                <div className="grip" aria-hidden>{r.rollout === "none" ? "在库" : "推送"}</div>
                <div className="paper">
                  <div className="cell when">
                    <span className="t">{hhmm(r.uploadedAt)}</span>
                    <span className="src">{stamp(r.uploadedAt).split(" ")[0]}</span>
                  </div>
                  <div className="cell what">
                    <div className="head"><span className="tool">{ROLLOUT_LABEL[r.rollout]}</span>
                      <div className="title mono">{r.version}</div></div>
                    <div className="detail mono" style={{ fontSize: 13 }}>
                      {bytes(r.byteLength)} · {r.idfVersion} · 编译于 {r.builtAt} · sha256 {r.sha256.slice(0, 12)}…
                    </div>
                    {r.rollout !== "none" && (
                      <div className="detail" style={{ fontSize: 13, fontWeight: 600 }}>
                        {targets.length ? `${upgraded}/${targets.length} 台已经在这一版` : "没有匹配的在用设备"}
                      </div>
                    )}
                    {picking === r.id && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                        <span className="ink-2" style={{ fontSize: 13, fontWeight: 600 }}>先挑一台试，确认没问题再推全部：</span>
                        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                          {devices.filter((d) => d.status === "active").map((d) => (
                            <label key={d.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>
                              <input type="checkbox" checked={picked.includes(d.id)}
                                     onChange={(e) => setPicked((all) => e.target.checked ? [...all, d.id] : all.filter((x) => x !== d.id))} />
                              {d.name}<span className="ink-2 mono">{d.firmware ?? "版本未知"}</span>
                            </label>
                          ))}
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button className="btn sm go" disabled={busy || !picked.length}
                                  onClick={() => void setRollout(r, "devices", picked)}>推给选中的 {picked.length} 台</button>
                          <button className="btn sm" onClick={() => { setPicking(null); setPicked([]); }}>取消</button>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="cell sign">
                    <div className="sign-row" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
                      {r.rollout === "none" ? (
                        <>
                          <button className="btn sm" disabled={busy}
                                  onClick={() => { setPicking(picking === r.id ? null : r.id); setPicked(r.rolloutDeviceIds); }}>挑设备推</button>
                          <button className="btn sm go" disabled={busy} onClick={() => void setRollout(r, "all")}>推给全部</button>
                          {confirmDelete === r.id ? (
                            <>
                              <button className="btn sm no" disabled={busy} onClick={() => void remove(r)}>确认删除</button>
                              <button className="btn sm" onClick={() => setConfirmDelete(null)}>取消</button>
                            </>
                          ) : <button className="btn sm no" disabled={busy} onClick={() => setConfirmDelete(r.id)}><Trash2 aria-hidden />删除</button>}
                        </>
                      ) : (
                        <>
                          {r.rollout === "devices" && <button className="btn sm go" disabled={busy} onClick={() => void setRollout(r, "all")}>扩到全部</button>}
                          <button className="btn sm no" disabled={busy} onClick={() => void setRollout(r, "none")}>停止推送</button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <p className="ink-2" style={{ fontSize: 13, fontWeight: 500, padding: "0 4px" }}>
        设备每次心跳（约 1 分钟）问一次有没有新版本，用 4G 下载后写进另一个分区，校验通过才重启。
        新版本起不来，bootloader 会自动退回上一版，所以最坏情况是设备停在旧固件上，不会变砖。
      </p>
    </div>
  );
}

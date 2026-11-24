import type { ReactNode } from "react";
import { AudioLines, CalendarClock, Star, ClipboardList, Gauge, Layers, ListChecks, LogOut, Plug, ScrollText, Search, Smartphone, UserRound, Users, Wallet, MessageSquare } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api, type Me } from "../api.ts";
import { navigate } from "../router.ts";
import { BrandMark, useLoad } from "./kit.tsx";
import { ago } from "../format.ts";
import type { Device } from "../api.ts";

interface NavItem { path: string; label: string; icon: LucideIcon; mobile?: boolean }

export const APP_NAV: NavItem[] = [
  { path: "/app", label: "今天", icon: Layers, mobile: true },
  { path: "/app/tasks", label: "任务中心", icon: ClipboardList, mobile: true },
  { path: "/app/recordings", label: "录音", icon: AudioLines, mobile: true },
  { path: "/app/favorites", label: "收藏", icon: Star, mobile: true },
  { path: "/app/search", label: "搜索", icon: Search, mobile: true },
  { path: "/app/automations", label: "自动化", icon: CalendarClock },
  { path: "/app/chat", label: "聊天", icon: MessageSquare, mobile: true },
  { path: "/app/me", label: "我的", icon: UserRound, mobile: true },
];

export const ADMIN_NAV: NavItem[] = [
  { path: "/admin", label: "总览", icon: Gauge, mobile: true },
  { path: "/admin/users", label: "用户", icon: Users, mobile: true },
  { path: "/admin/devices", label: "设备", icon: Smartphone, mobile: true },
  { path: "/admin/costs", label: "成本", icon: Wallet, mobile: true },
  { path: "/admin/executions", label: "执行记录", icon: ListChecks },
  { path: "/admin/connectors", label: "连接器", icon: Plug, mobile: true },
  { path: "/admin/audit", label: "审计", icon: ScrollText, mobile: true },
];

function isCurrent(itemPath: string, path: string, root: string) {
  return itemPath === root ? path === root || path === `${root}/` : path.startsWith(itemPath);
}

export function Shell({ me, path, pending, children }: { me: Me; path: string; pending: number; children: ReactNode }) {
  const admin = path.startsWith("/admin");
  const root = admin ? "/admin" : "/app";
  const items = admin ? ADMIN_NAV : APP_NAV;

  async function signOut() {
    await api.post("/v1/auth/logout").catch(() => {});
    window.dispatchEvent(new Event("voxmind:signed-out"));
  }

  return (
    <div className="shell">
      <nav className="rail" aria-label="主导航">
        <div className="brand"><BrandMark /><b>VoxMind</b></div>
        {me.role === "admin" && (
          <div className="rail-switch" role="group" aria-label="切换工作区">
            <button aria-pressed={!admin} onClick={() => navigate("/app")}>我的工作台</button>
            <button aria-pressed={admin} onClick={() => navigate("/admin")}>管理</button>
          </div>
        )}
        {items.map((item) => (
          <button key={item.path} className="nav" aria-current={isCurrent(item.path, path, root) ? "page" : undefined}
                  onClick={() => navigate(item.path)}>
            <item.icon aria-hidden />{item.label}
            {item.path === "/app" && pending > 0 && <span className="count">{pending}</span>}
          </button>
        ))}
        <div className="rail-foot">
          <div className="who"><b>{me.user.displayName}</b><span>{me.user.email}</span></div>
          <button className="btn sm" onClick={() => void signOut()}><LogOut aria-hidden />退出登录</button>
        </div>
      </nav>

      <div className="work">{!admin && <DeviceBanner />}{children}</div>

      <nav className="tabbar" aria-label="主导航">
        {items.filter((i) => i.mobile).map((item) => (
          <button key={item.path} className="tab" aria-current={isCurrent(item.path, path, root) ? "page" : undefined}
                  onClick={() => navigate(item.path)}>
            <item.icon aria-hidden />{item.label}
            {item.path === "/app" && pending > 0 && <span className="count">{pending}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}

/** 每页顶部：标题 + 右侧操作。管理员在手机上没有侧栏，工作区切换放这里。 */
export function PageHead({ title, children, me, path }: { title: ReactNode; children?: ReactNode; me?: Me; path?: string }) {
  const admin = path?.startsWith("/admin");
  return (
    <header className="work-head">
      <h1>{title}</h1>
      <div className="end">
        {children}
        {me?.role === "admin" && (
          <button className="btn sm mobile-only" onClick={() => navigate(admin ? "/app" : "/admin")}>
            {admin ? "我的工作台" : "管理"}
          </button>
        )}
      </div>
    </header>
  );
}

/* 设备出状况时挂在每页顶上：15 分钟没心跳（正在下载固件时除外，那几分钟本来就不心跳），
 * 或者新固件升完没回来被自动停推。录音都在设备 SD 卡里，所以话要说清楚"不会丢"。*/
const OFFLINE_MS = 15 * 60_000;
function DeviceBanner() {
  const devices = useLoad(() => api.get<{ devices: Device[] }>("/v1/devices").then((r) => r.devices), [], 60_000);
  const notes: string[] = [];
  for (const d of devices.data ?? []) {
    if (d.status !== "active") continue;
    const busy = ["downloading", "verifying", "offered"].includes(d.otaState);
    const lastSeen = d.lastSeenAt ? Date.parse(d.lastSeenAt) : 0;
    // 三天都没见过的多半是收起来不用的机器，不天天提醒
    if (!busy && lastSeen && Date.now() - lastSeen > OFFLINE_MS && Date.now() - lastSeen < 3 * 86_400_000)
      notes.push(`「${d.name}」联不上网了（最后一次联网：${ago(d.lastSeenAt)}）。录音照常存在设备里，联网后自动补传；一直不恢复可以长按录音键重启。`);
    if (d.otaState === "failed" && d.otaError && d.otaUpdatedAt && Date.now() - Date.parse(d.otaUpdatedAt) < 86_400_000)
      notes.push(`「${d.name}」固件升级没成功：${d.otaError}`);
  }
  if (!notes.length) return null;
  return (
    <div role="status" style={{ padding: "12px 24px 0" }}>
      {notes.map((n) => <div key={n} className="notice" style={{ marginBottom: 8 }}>{n}</div>)}
    </div>
  );
}

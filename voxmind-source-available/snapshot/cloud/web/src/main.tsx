import { lazy, StrictMode, Suspense, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";
import { api, type Me } from "./api.ts";
import { navigate, usePath } from "./router.ts";
import { Skeleton, ToastHost } from "./ui/kit.tsx";
import { Shell } from "./ui/Shell.tsx";
import { Login } from "./pages/Login.tsx";
import { Today } from "./pages/app/Today.tsx";
/* 除了「今天」和登录，其余页面点到才下载。
 * 打包从一个 386KB 的大块拆成十几个小块：首屏少下 60% 左右，4G 上打开明显快。*/
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const named = <K extends string>(key: K, load: () => Promise<Record<K, React.ComponentType<any>>>) =>
  lazy(async () => {
    try { return { default: (await load())[key] }; }
    catch (error) { reloadForNewVersion(); throw error; }
  });

/* 网页开着的时候服务器上线了新版本：旧页面再去要旧的分块文件（文件名带哈希），服务器上已经没有了，
 * 报「Failed to fetch dynamically imported module」整页白屏（2026-10-05 打开「管理」时遇到）。
 * 这时刷新一次就换成新版本。30 秒内只自动刷一次，真是网络断了也不会无限刷。*/
function reloadForNewVersion() {
  try {
    const last = Number(sessionStorage.getItem("voxmind:reloaded-at") ?? 0);
    if (Date.now() - last < 30_000) return;
    sessionStorage.setItem("voxmind:reloaded-at", String(Date.now()));
  } catch { /* 无痕模式拿不到 sessionStorage：照样刷一次 */ }
  location.reload();
}
window.addEventListener("vite:preloadError", (event) => { event.preventDefault(); reloadForNewVersion(); });
const Recordings = named("Recordings", () => import("./pages/app/Recordings.tsx"));
const FavoritesPage = named("Favorites", () => import("./pages/app/Recordings.tsx"));
const Tasks = named("Tasks", () => import("./pages/app/Tasks.tsx"));
const Automations = named("Automations", () => import("./pages/app/Automations.tsx"));
const Search = named("Search", () => import("./pages/app/Search.tsx"));
const Chat = named("Chat", () => import("./pages/app/Chat.tsx"));
const MePage = named("Me", () => import("./pages/app/Me.tsx"));
const Overview = named("Overview", () => import("./pages/admin/Overview.tsx"));
const Users = named("Users", () => import("./pages/admin/Users.tsx"));
const Devices = named("Devices", () => import("./pages/admin/Devices.tsx"));
const Executions = named("Executions", () => import("./pages/admin/Executions.tsx"));
const Connectors = named("Connectors", () => import("./pages/admin/Connectors.tsx"));
const Audit = named("Audit", () => import("./pages/admin/Audit.tsx"));
const Costs = named("Costs", () => import("./pages/admin/Costs.tsx"));

function App() {
  const path = usePath();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [pending, setPending] = useState(0);

  const loadMe = useCallback(async () => {
    try { setMe(await api.get<Me>("/v1/auth/me")); }
    catch { setMe(null); }
  }, []);

  useEffect(() => { void loadMe(); }, [loadMe]);
  useEffect(() => {
    const out = () => setMe(null);
    window.addEventListener("voxmind:signed-out", out);
    return () => window.removeEventListener("voxmind:signed-out", out);
  }, []);

  // 待签放数量挂在导航上；不在「今天」页时也要知道有没有新单子
  useEffect(() => {
    if (!me) return;
    const poll = async () => {
      if (document.hidden) return;
      try { setPending((await api.get<{ drafts: unknown[] }>("/v1/action-drafts?status=pending")).drafts.length); } catch { /* 下一轮再说 */ }
    };
    void poll();
    const t = setInterval(poll, 15000);
    return () => clearInterval(t);
  }, [me]);

  // 路径兜底：非管理员进 /admin 退回工作台；根路径去工作台
  useEffect(() => {
    if (!me) return;
    if (path === "/" || path === "/login") navigate("/app");
    else if (path.startsWith("/admin") && me.role !== "admin") navigate("/app");
  }, [me, path]);

  if (me === undefined) {
    return <div className="login"><div className="login-card"><Skeleton h={180} /></div></div>;
  }
  if (me === null) return <Login onSignedIn={() => { void loadMe(); navigate("/app"); }} />;

  const props = { me, path };
  let page;
  switch (path.replace(/\/$/, "") || "/app") {
    case "/app/recordings": page = <Recordings {...props} />; break;
    case "/app/favorites": page = <FavoritesPage {...props} />; break;
    case "/app/tasks": page = <Tasks {...props} />; break;
    case "/app/automations": page = <Automations {...props} />; break;
    case "/app/search": page = <Search {...props} />; break;
    case "/app/chat": page = <Chat {...props} />; break;
    case "/app/me": page = <MePage {...props} />; break;
    case "/admin": page = <Overview {...props} />; break;
    case "/admin/users": page = <Users {...props} />; break;
    case "/admin/devices": page = <Devices {...props} />; break;
    case "/admin/executions": page = <Executions {...props} />; break;
    case "/admin/connectors": page = <Connectors {...props} />; break;
    case "/admin/audit": page = <Audit {...props} />; break;
    case "/admin/costs": page = <Costs {...props} />; break;
    default: page = <Today {...props} onPendingChange={setPending} />;
  }
  return (
    <Shell me={me} path={path} pending={pending}>
      <Suspense fallback={<div className="work-body"><Skeleton h={120} /></div>}>{page}</Suspense>
    </Shell>
  );
}

/* 装成手机桌面应用：离线时壳能起来，静态资源走缓存。
 * 接口一律不缓存——录音和任务随时在变，看到旧数据比看不到更糟。*/
if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><ToastHost><App /></ToastHost></StrictMode>,
);

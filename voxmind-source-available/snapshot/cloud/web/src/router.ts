import { useEffect, useState } from "react";

/* 就几个页面，不值得引一个路由库。用 history API，地址栏就是真实路径，
 * 刷新、收藏、分享链接都能落回同一页；服务端把 /app/* /admin/* 都回落到 index.html。*/
export function navigate(path: string) {
  if (path === location.pathname) return;
  history.pushState(null, "", path);
  window.dispatchEvent(new Event("voxmind:navigate"));
  window.scrollTo(0, 0);
}

export function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    window.addEventListener("popstate", update);
    window.addEventListener("voxmind:navigate", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("voxmind:navigate", update);
    };
  }, []);
  return path;
}

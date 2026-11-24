/* 离线壳：只缓存打包产物，不碰任何录音和接口数据。
 *
 * 为什么不缓存接口：录音、任务、转写都是随时在变的东西，缓存旧数据比看不到更糟；
 * 而且它们是隐私数据，不该留在设备的缓存里。断网时打开就显示"连不上"，但至少壳能起来。*/
const SHELL = "voxmind-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(["/app", "/icon.svg", "/manifest.webmanifest"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/v1/")) return;                      // 接口一律走网络
  if (url.pathname.startsWith("/assets/")) {
    // 带哈希的静态资源：内容一变名字就变，可以放心先用缓存
    event.respondWith(caches.match(event.request).then((hit) => hit ?? fetch(event.request).then((res) => {
      const copy = res.clone();
      void caches.open(SHELL).then((cache) => cache.put(event.request, copy));
      return res;
    })));
    return;
  }
  // 页面：先走网络，断网时用缓存里的壳兜底
  event.respondWith(fetch(event.request).catch(() => caches.match("/app").then((hit) => hit ?? Response.error())));
});

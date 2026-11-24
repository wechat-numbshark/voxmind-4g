/* 会话 cookie 的读写。只为这一个用途，手写十几行比引一个依赖划算。
 *
 * 三个属性都不是可选项：
 *   HttpOnly —— 页面脚本读不到，XSS 偷不走会话（现在管理密钥存在 localStorage，
 *               正是这个问题）；
 *   SameSite=Lax —— 挡掉跨站 CSRF，同时不影响从飞书点链接跳回来；
 *   Secure —— 只在 HTTPS 上发。本地 http 调试时要关掉，否则浏览器直接丢弃。
 */
export const SESSION_COOKIE = "voxmind_session";

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    if (key) out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function serializeSessionCookie(token: string, maxAgeSec: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return serializeSessionCookie("", 0, secure);
}

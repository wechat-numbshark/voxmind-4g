import { createHmac, timingSafeEqual } from "node:crypto";

/* 一次性音频取用凭证。
 *
 * 分角色转写（说话人分离）的接口只接受"公网能下载的 URL"，不能直接把音频 POST 上去。
 * 所以要给出一条临时地址。这条地址本身就是凭证，因此：
 * - 带签名，改一个字节就失效；
 * - 30 分钟过期；
 * - 只指向具体的一段（会话 + 起止毫秒），拿到它也翻不到别的录音。
 *
 * 这是为了用云端分离能力必须付出的代价，写在这里是为了让下一个读代码的人知道它的边界。*/

const TTL_MS = 30 * 60_000;

interface ClipClaim { sessionId: string; fromMs: number; toMs: number; expiresAt: number }

const b64u = (buffer: Buffer) => buffer.toString("base64url");

function sign(secret: string, body: string) {
  return b64u(createHmac("sha256", secret).update(body).digest());
}

export function signClipToken(secret: string, claim: Omit<ClipClaim, "expiresAt">, now = Date.now()) {
  const body = b64u(Buffer.from(JSON.stringify({ ...claim, expiresAt: now + TTL_MS })));
  return `${body}.${sign(secret, body)}`;
}

/** 验不过就返回 null：签名不对、过期、格式不对都一样对待，不告诉调用方是哪一种 */
export function verifyClipToken(secret: string, token: string, now = Date.now()): ClipClaim | null {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = sign(secret, body);
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claim = JSON.parse(Buffer.from(body, "base64url").toString()) as ClipClaim;
    if (typeof claim.sessionId !== "string" || typeof claim.fromMs !== "number"
        || typeof claim.toMs !== "number" || typeof claim.expiresAt !== "number") return null;
    return claim.expiresAt > now ? claim : null;
  } catch {
    return null;
  }
}

import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Principal } from "../identity/types.js";
import type { IdentityService } from "../services/identity.js";
import { parseCookies, SESSION_COOKIE } from "./cookie.js";

/* 鉴权中间件。
 *
 * 在这之前，全站只有两把共享密钥，userId 从 URL 查询参数取——带上管理密钥
 * 加个 ?userId=别人 就能读写别人的录音。现在身份一律从这里解析出来挂到
 * request.principal 上，路由只能用它，不能再信 query。
 *
 * 两把老密钥仍然认，但只作为兼容路径：实板固件和现有脚本不用同一天全改完。
 */

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const clientIp = (request: FastifyRequest) => String(request.ip ?? "");

export function deviceAuth(identity: IdentityService) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const key = String(request.headers["x-device-key"] ?? "");
    const principal = await identity.resolveDevice(key);
    if (!principal) return reply.code(401).send({ error: "设备鉴权失败" });
    request.principal = principal;
  };
}

/** 已登录即可（管理员和普通成员都行）。数据范围由 request.principal.userId 决定。 */
export function userAuth(identity: IdentityService, legacyAdminKey: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = await resolve(identity, legacyAdminKey, request);
    if (!principal) return reply.code(401).send({ error: "请先登录" });
    request.principal = principal;
  };
}

/** 只有管理员。用户管理、设备发放、连接器配置、审计日志走这个。 */
export function adminAuth(identity: IdentityService, legacyAdminKey: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = await resolve(identity, legacyAdminKey, request);
    if (!principal) return reply.code(401).send({ error: "请先登录" });
    if (principal.role !== "admin") return reply.code(403).send({ error: "需要管理员权限" });
    request.principal = principal;
  };
}

async function resolve(identity: IdentityService, legacyAdminKey: string, request: FastifyRequest) {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (token) {
    const principal = await identity.resolveSession(token);
    if (principal) return principal;
  }
  /* 兼容路径：部署脚本和 curl 还在用 Bearer ADMIN_API_KEY。它拿到的是完整
   * 管理员权限，所以只应该留给运维，不要再发给浏览器。*/
  const header = String(request.headers.authorization ?? "");
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (bearer && legacyAdminKey && safeEqual(bearer, legacyAdminKey)) {
    return { kind: "legacy-admin", userId: "owner", role: "admin" } satisfies Principal;
  }
  return null;
}

export { clientIp };

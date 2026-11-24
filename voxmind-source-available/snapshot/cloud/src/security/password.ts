import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, k: number) => Promise<Buffer>;

/* scrypt 用 Node 内置的就够，不引第三方。用默认参数（N=16384, r=8, p=1），
 * 单次约几十毫秒——慢到让在线撞库没意义，又不至于把登录拖住。
 * 哈希串里带了方案名，以后要调参数可以按前缀平滑迁移。*/
const KEY_LEN = 32;
const SALT_LEN = 16;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scrypt(plain, salt, KEY_LEN);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64url");
  const actual = await scrypt(plain, Buffer.from(saltB64, "base64url"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** 口令强度下限。不做花式规则——长度是唯一真正有用的那一条。 */
export function passwordProblem(plain: string): string | null {
  if (plain.length < 10) return "密码至少 10 位";
  if (plain.length > 200) return "密码太长";
  return null;
}

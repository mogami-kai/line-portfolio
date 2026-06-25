// ============================================================
// 管理セッション（署名付きクッキー / 依存ゼロ・node:crypto のみ）
//
//   LINE Login で本人確認した「承認済み ADMIN」だけにセッションを発行する。
//   クッキー値 = base64url(payload) + "." + base64url(HMAC-SHA256(payload, SESSION_SECRET))
//     payload(JSON) = { lineUserId, role, exp(=epoch秒) }
//
//   - signSession   : payload → クッキー文字列（署名付き）
//   - verifySession  : クッキー文字列 → payload（改竄/期限切れは null）
//   - readSession    : Cookie ヘッダ全体 → demen_session を取り出して verify
//   - sessionCookieHeader / clearSessionCookieHeader : Set-Cookie 文字列を生成
//
//   ※ ステートレス（DB を引かない）。失効が必要になったら exp を短くするか、
//     SESSION_SECRET をローテーションする運用とする。
//   ※ Edge(middleware) でも Node ランタイムでも動くよう node:crypto に限定。
// ============================================================

import crypto from "node:crypto";

/** セッションクッキー名（httpOnly / Secure / SameSite=Lax で発行）。 */
export const SESSION_COOKIE = "demen_session";

/** LINE Login の CSRF 用 state クッキー名（login で発行・callback で照合）。 */
export const OAUTH_STATE_COOKIE = "demen_oauth_state";

/** 既定の有効期間（秒）。7 日。 */
export const DEFAULT_SESSION_TTL_SEC = 60 * 60 * 24 * 7;

/** クッキーに載せる最小ペイロード。 */
export interface SessionPayload {
  /** LINE userId（本人）。 */
  lineUserId: string;
  /** ロール（基本 "ADMIN"）。将来の拡張用に保持。 */
  role: string;
  /** 失効時刻（UNIX epoch 秒）。 */
  exp: number;
}

function getSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "SESSION_SECRET is not set or too short (16文字未満)。`openssl rand -hex 32` 等で32文字以上のランダム値を設定してください。",
    );
  }
  return s;
}

// base64url（パディング無し）。Buffer 経由で実装。
function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecodeToString(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64").toString("utf8");
}

function hmac(payloadB64: string, secret: string): string {
  return b64urlEncode(
    crypto.createHmac("sha256", secret).update(payloadB64).digest(),
  );
}

/** タイミング安全な文字列比較（長さ不一致は即 false）。 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * payload に署名してクッキー値文字列を返す。
 * exp 未指定なら now + DEFAULT_SESSION_TTL_SEC。
 */
export function signSession(
  input: { lineUserId: string; role: string; exp?: number },
  ttlSec: number = DEFAULT_SESSION_TTL_SEC,
): string {
  const secret = getSecret();
  const exp =
    input.exp ?? Math.floor(Date.now() / 1000) + Math.max(60, ttlSec);
  const payload: SessionPayload = {
    lineUserId: input.lineUserId,
    role: input.role,
    exp,
  };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = hmac(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

/**
 * クッキー値を検証して payload を返す。
 * 署名不一致・形式不正・期限切れ・SECRET 未設定はすべて null。
 */
export function verifySession(value: string | undefined | null): SessionPayload | null {
  if (!value) return null;
  let secret: string;
  try {
    secret = getSecret();
  } catch {
    return null;
  }
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!payloadB64 || !sig) return null;

  const expected = hmac(payloadB64, secret);
  if (!safeEqual(sig, expected)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(b64urlDecodeToString(payloadB64)) as SessionPayload;
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload.lineUserId !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null; // 失効
  return payload;
}

/** Cookie ヘッダ（"a=1; b=2"）から指定クッキーの値を取り出す。 */
export function parseCookie(
  cookieHeader: string | null | undefined,
  name: string = SESSION_COOKIE,
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Cookie ヘッダ全体から demen_session を取り出して検証する。 */
export function readSession(
  cookieHeader: string | null | undefined,
): SessionPayload | null {
  return verifySession(parseCookie(cookieHeader, SESSION_COOKIE));
}

/** Set-Cookie 文字列（httpOnly / Secure / SameSite=Lax / Path=/）。 */
export function sessionCookieHeader(
  value: string,
  ttlSec: number = DEFAULT_SESSION_TTL_SEC,
): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttlSec}${secure}`;
}

/** ログアウト用に即時失効させる Set-Cookie 文字列。 */
export function clearSessionCookieHeader(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

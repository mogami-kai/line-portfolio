// ============================================================
// Next.js Middleware — 管理画面 / 管理 API のルート保護
//
//   対象（matcher 参照）:
//     - /admin/:path*               … 管理ダッシュボード（HTML）
//     - /api/invoices/:path*        … 請求書 export/generate（管理専用）
//     - /api/admin/:path*           … マスタ変更・ユーザー承認（管理専用）
//
//   demen_session（署名付きクッキー）を検証し、未ログイン/失効/改竄なら:
//     - ページ → /admin?error=login へ 302（/admin 自身は素通しでログイン画面表示）
//     - API    → 401 JSON
//
//   ★ Edge ランタイム互換のため Web Crypto（crypto.subtle）で HMAC 検証する。
//     署名仕様は src/lib/session.ts（node:crypto 実装）と完全一致:
//       value = base64url(payload) + "." + base64url(HMAC-SHA256(payload, SECRET))
//   ※ middleware は「第一防衛線」。各ハンドラ/ページ側も getAdminContext() で
//     DB 上の承認済み ADMIN を再確認する（多層防御）。
// ============================================================

import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "demen_session";

// base64url(no padding) → ArrayBuffer
function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Web Crypto で署名検証し、payload を返す（失敗時 null）。 */
async function verifySessionEdge(
  value: string | undefined,
  secret: string | undefined,
): Promise<{ lineUserId: string; role: string; exp: number } | null> {
  if (!value || !secret) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!payloadB64 || !sig) return null;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payloadB64),
    );
    const expected = bytesToB64url(mac);
    if (!timingSafeEqualStr(sig, expected)) return null;

    const json = new TextDecoder().decode(b64urlToBytes(payloadB64));
    const payload = JSON.parse(json) as {
      lineUserId?: string;
      role?: string;
      exp?: number;
    };
    if (
      !payload ||
      typeof payload.lineUserId !== "string" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return {
      lineUserId: payload.lineUserId,
      role: payload.role ?? "",
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const raw = req.cookies.get(SESSION_COOKIE)?.value;
  const payload = await verifySessionEdge(raw, process.env.SESSION_SECRET);

  if (payload) {
    // セッション OK。ハンドラ/ページ側で ADMIN を最終確認する。
    return NextResponse.next();
  }

  // ── 未認証 ──
  if (isApiPath(pathname)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized", message: "管理者ログインが必要です。" },
      { status: 401 },
    );
  }

  // ページ（/admin 配下）。/admin 自体はログイン画面を出すので素通し、
  // それ以外（/admin/invoices 等）はログイン画面へ集約。
  if (pathname === "/admin") {
    return NextResponse.next();
  }
  const url = req.nextUrl.clone();
  url.pathname = "/admin";
  url.search = "?error=login";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/admin/:path*",
    "/api/invoices/:path*",
    "/api/admin/:path*",
  ],
};

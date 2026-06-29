// ============================================================
// GET /api/auth/line/callback — LINE Login コールバック
//
//   フロー:
//     1) state を demen_oauth_state クッキーと照合（CSRF 対策）。
//     2) code → access_token（exchangeCode）。
//     3) access_token → プロフィール（lineUserId）。
//     4) lineUserId を解決。既存の承認済み ADMIN はそのまま、未登録は自動作成
//        （オープンアクセス: 自社ADMIN・承認済み）してログインさせる。
//          OK   → demen_session（署名付き）を発行して /admin へ 302。
//          NG   → /admin?error=forbidden（PARTNER 等へ降格済み）へ 302。
//
//   ※ オープンアクセス: 未登録ユーザーはここで自動作成して通す。管理者に
//     PARTNER 等へ降格された既存ユーザーは ADMIN でないため弾く。
// ============================================================

import { NextResponse } from "next/server";
import { getProfile, exchangeCode } from "@/lib/line.js";
import { findApprovedAdminByLineUserId, resolveUser } from "@/lib/auth.js";
import {
  signSession,
  sessionCookieHeader,
  parseCookie,
  OAUTH_STATE_COOKIE,
} from "@/lib/session.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirectToAdmin(req: Request, query = ""): URL {
  const u = new URL(req.url);
  return new URL(`/admin${query}`, `${u.protocol}//${u.host}`);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  // ユーザーが LINE 側で拒否した等。
  if (errorParam) {
    return NextResponse.redirect(redirectToAdmin(req, "?error=denied"), 302);
  }

  // ── 1) state 照合（CSRF） ──
  const cookieState = parseCookie(
    req.headers.get("cookie"),
    OAUTH_STATE_COOKIE,
  );
  if (!code || !state || !cookieState || state !== cookieState) {
    const res = NextResponse.redirect(redirectToAdmin(req, "?error=state"), 302);
    // 使い終わった state は破棄。
    res.headers.append(
      "Set-Cookie",
      `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
    return res;
  }

  // ── 2) code → token ──
  const token = await exchangeCode(code);
  if (!token) {
    return NextResponse.redirect(redirectToAdmin(req, "?error=token"), 302);
  }

  // ── 3) token → profile ──
  let lineUserId = "";
  let displayName = "";
  try {
    const profile = await getProfile(token.accessToken);
    lineUserId = profile.userId;
    displayName = profile.displayName;
  } catch {
    return NextResponse.redirect(redirectToAdmin(req, "?error=profile"), 302);
  }
  if (!lineUserId) {
    return NextResponse.redirect(redirectToAdmin(req, "?error=profile"), 302);
  }

  // ── 4) ログインユーザーの解決（オープンアクセス）──
  //   既存の承認済み ADMIN はそのまま通す。未登録なら自動作成（自社ADMIN・承認済み）して
  //   ログインさせる。ただし管理者に「協力会社(PARTNER)」等へ降格された既存ユーザーは
  //   ADMIN ではないのでセッションを発行しない（管理画面は ADMIN のみ）。
  let sessionUser = await findApprovedAdminByLineUserId(lineUserId);
  if (!sessionUser) {
    const resolved = await resolveUser(lineUserId, displayName);
    if (
      resolved &&
      resolved.user.role === "ADMIN" &&
      resolved.user.approved &&
      resolved.user.status === "ACTIVE"
    ) {
      sessionUser = resolved;
    }
  }
  if (!sessionUser) {
    // 権限なし（管理者に制限されたユーザー）。セッションは発行しない。
    const res = NextResponse.redirect(
      redirectToAdmin(req, "?error=forbidden"),
      302,
    );
    res.headers.append(
      "Set-Cookie",
      `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
    return res;
  }

  // ── 成功: 署名付きセッションを発行 ──
  let cookie: string;
  try {
    const value = signSession({
      lineUserId: sessionUser.user.lineUserId,
      role: sessionUser.user.role,
    });
    cookie = sessionCookieHeader(value);
  } catch {
    // SESSION_SECRET 未設定など。
    return NextResponse.redirect(redirectToAdmin(req, "?error=session"), 302);
  }

  const res = NextResponse.redirect(redirectToAdmin(req), 302);
  res.headers.append("Set-Cookie", cookie);
  res.headers.append(
    "Set-Cookie",
    `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
  return res;
}

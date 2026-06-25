// ============================================================
// GET /api/auth/line/login — 管理ログイン開始（LINE Login へリダイレクト）
//
//   1) CSRF 用の state を生成し、httpOnly クッキー（demen_oauth_state）に保存。
//   2) LINE 認可エンドポイントへ 302。
//   コールバックは /api/auth/line/callback（ADMIN_LOGIN_REDIRECT_URL と一致させる）。
// ============================================================

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { buildLoginUrl } from "@/lib/line.js";
import { OAUTH_STATE_COOKIE } from "@/lib/session.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let url: string;
  const state = crypto.randomBytes(16).toString("hex");
  const nonce = crypto.randomBytes(16).toString("hex");
  try {
    url = buildLoginUrl(state, nonce);
  } catch (e) {
    // LINE Login の env 未設定など。
    return NextResponse.json(
      {
        ok: false,
        error: "login_not_configured",
        message:
          e instanceof Error
            ? e.message
            : "LINE Login が設定されていません（環境変数を確認）。",
      },
      { status: 500 },
    );
  }

  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const res = NextResponse.redirect(url, { status: 302 });
  res.headers.append(
    "Set-Cookie",
    `${OAUTH_STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
  );
  return res;
}

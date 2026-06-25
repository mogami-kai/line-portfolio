// ============================================================
// POST /api/auth/logout — 管理セッションの破棄
//   demen_session を Max-Age=0 で失効させ、/admin へ 302。
//   （GET も同様に許可し、リンク/フォームどちらからでもログアウト可能に。）
// ============================================================

import { NextResponse } from "next/server";
import { clearSessionCookieHeader } from "@/lib/session.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function logout(req: Request): NextResponse {
  const u = new URL(req.url);
  const res = NextResponse.redirect(
    new URL("/admin", `${u.protocol}//${u.host}`),
    302,
  );
  res.headers.append("Set-Cookie", clearSessionCookieHeader());
  return res;
}

export async function POST(req: Request) {
  return logout(req);
}

export async function GET(req: Request) {
  return logout(req);
}

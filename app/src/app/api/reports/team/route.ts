// ============================================================
// GET /api/reports/team?date=yyyy-MM-dd — みんなの出面（LIFF の「みんな」タブ）
//
//   認証は POST /api/reports と同じ（Bearer = LIFF アクセストークン・承認済みのみ）。
//   自分の所属組織の、その日の出面と「出面に名前がない職人」を返す（@/lib/teamDay）。
//   ★ 見える範囲は所属組織のみ（自社⇔協力会社の出面は互いに見えない）。
//   date 省略時は今日（JST）。
// ============================================================

import { NextResponse } from "next/server";
import {
  bearerToken,
  requireApproved,
  resolveUserFromAccessToken,
} from "@/lib/auth.js";
import { jstTodayDate } from "@/lib/invoiceDates.js";
import { loadTeamDay } from "@/lib/teamDay.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status });
}

export async function GET(req: Request) {
  const token = bearerToken(req.headers.get("authorization"));
  if (!token) return json(401, { ok: false, error: "missing access token" });

  const resolved = await resolveUserFromAccessToken(token);
  if (!resolved) return json(401, { ok: false, error: "invalid access token" });

  try {
    requireApproved(resolved);
  } catch {
    return json(403, {
      ok: false,
      error: "not_approved",
      message: "アカウントが未承認です。管理者の承認をお待ちください。",
    });
  }

  const raw = new URL(req.url).searchParams.get("date") ?? "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? raw
    : jstTodayDate().toISOString().slice(0, 10);
  if (Number.isNaN(new Date(`${date}T00:00:00.000Z`).getTime())) {
    return json(400, { ok: false, error: "invalid_date", message: "日付が正しくありません。" });
  }

  const day = await loadTeamDay(resolved.org.id, date);
  return json(200, { ok: true, ...day });
}

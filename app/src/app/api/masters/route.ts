// ============================================================
// GET /api/masters — LIFF フォームの選択肢を返す
//
//   Authorization: Bearer <LIFF access token> → User+Org 解決。
//   返却:
//     - clients : 取引先（active）。v3 で現場は自由入力化したため sites は返さない。
//     - workers : 呼び出しユーザーの org に属する職人（active）
//   ※ 取引先は全社共通マスタ。職人は org スコープ（自社/協力会社で分離）。
//   未承認ユーザーは 403（フォームを使わせない）。
// ============================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db.js";
import {
  bearerToken,
  requireApproved,
  resolveUserFromAccessToken,
} from "@/lib/auth.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const token = bearerToken(req.headers.get("authorization"));
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "missing access token" },
      { status: 401 },
    );
  }

  const resolved = await resolveUserFromAccessToken(token);
  if (!resolved) {
    return NextResponse.json(
      { ok: false, error: "invalid access token" },
      { status: 401 },
    );
  }

  try {
    requireApproved(resolved);
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "not_approved",
        message: "アカウントが未承認です。管理者の承認をお待ちください。",
      },
      { status: 403 },
    );
  }

  const { org, user } = resolved;

  const [clients, workers] = await Promise.all([
    // 取引先（請求先）は全社共通マスタ。有効なもののみ。
    // v3: 現場は LIFF 側で自由入力（Report.siteName）になったため、
    // 現場ピッカー用の sites サブ取得は廃止（payload 縮小）。
    prisma.client.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
      },
    }),
    // 職人は org スコープ（自社は自社、協力会社はその会社のみ）＋active のみ。
    prisma.worker.findMany({
      where: { active: true, orgId: org.id },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  return NextResponse.json({
    ok: true,
    me: { displayName: user.displayName, role: user.role, orgName: org.name },
    clients,
    workers,
  });
}

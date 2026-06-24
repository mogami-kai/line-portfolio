// ============================================================
// GET /api/masters — LIFF フォームの選択肢を返す
//
//   Authorization: Bearer <LIFF access token> → User+Org 解決。
//   返却:
//     - clients : 取引先（active）＋紐づく現場（sites）
//     - workers : 呼び出しユーザーの org に属する職人（active）
//   ※ 取引先・現場は全社共通マスタ。職人は org スコープ。
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
    prisma.client.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        sites: {
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        },
      },
    }),
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

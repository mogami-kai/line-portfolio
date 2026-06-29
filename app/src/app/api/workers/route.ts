// ============================================================
// POST /api/workers — 職人の自己追加（LIFF）
//
// フロー:
//   1) Authorization: Bearer <LIFF access token> → User+Org 解決
//   2) 未承認なら 403（出面 API と同じガード）
//   3) zod でボディ { name } を検証（非空・最大長）
//   4) 呼び出しユーザーの org に同名 active の職人があればそれを返す
//      （重複作成しない＝名寄せの最小実装）。無ければ新規作成
//      （active:true / aliases:[] / orgId=ユーザーの org.id）。
//   5) { id, name } を返す
//
// ※ 職人は org スコープ（自社は自社、協力会社はその会社のみ）。
//    認証は api/reports・api/masters と同じ resolveUserFromAccessToken 系を流用。
// ============================================================

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db.js";
import {
  bearerToken,
  requireApproved,
  resolveUserFromAccessToken,
} from "@/lib/auth.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── 入力スキーマ ──
// 職人名は前後空白を除去し非空・現実的上限まで。空白のみの入力は弾く。
const bodySchema = z.object({
  name: z.string().trim().min(1, "name required").max(100),
});

type Body = z.infer<typeof bodySchema>;

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status });
}

export async function POST(req: Request) {
  // ── 1) 認証（LIFF アクセストークン）──
  const token = bearerToken(req.headers.get("authorization"));
  if (!token) {
    return json(401, { ok: false, error: "missing access token" });
  }

  const resolved = await resolveUserFromAccessToken(token);
  if (!resolved) {
    return json(401, { ok: false, error: "invalid access token" });
  }

  // ── 2) 承認チェック ──
  try {
    requireApproved(resolved);
  } catch {
    return json(403, {
      ok: false,
      error: "not_approved",
      message: "アカウントが未承認です。管理者の承認をお待ちください。",
    });
  }

  const { org } = resolved;

  // ── 3) ボディ検証（zod）──
  let body: Body;
  try {
    const raw = await req.json();
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return json(400, {
        ok: false,
        error: "invalid_body",
        issues: parsed.error.flatten(),
      });
    }
    body = parsed.data;
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }

  const name = body.name;

  // ── 4) 既存（同 org・同名・active）があればそれを返す。無ければ作成（重複作成しない）──
  // Worker に (orgId,name) の一意制約は無い（本番データに既存重複があり得るため migration を避ける）。
  // 代わりに Postgres の advisory xact lock で「同 org・同名」の同時追加を直列化し、
  // スマホの再送・二重タップでも同名職人が増えないようにする（pgbouncer 互換）。
  const lockKey = `worker:${org.id}:${name}`;
  const result = await prisma.$transaction(async (tx) => {
    // このトランザクション内だけ有効なロック（commit/rollback で自動解放）。
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    const existing = await tx.worker.findFirst({
      where: { orgId: org.id, name, active: true },
      select: { id: true, name: true },
    });
    if (existing) return existing;
    // 新規作成（org スコープ）。永続化されるので以後の masters にも出る。
    return tx.worker.create({
      data: { name, active: true, aliases: [], orgId: org.id },
      select: { id: true, name: true },
    });
  });

  return json(200, { id: result.id, name: result.name });
}

// ============================================================
// 出面の削除申請（LIFF マイページ）
//   POST   /api/reports/[id]/delete-request … 申請する
//   DELETE /api/reports/[id]/delete-request … 申請を取り下げる
//
//   本人（createdById = 自分）の出面のみ。申請はフラグを立てるだけで、
//   実際の削除は管理者が /admin の「削除申請」から承認して初めて行われる
//   （承認時に LINE グループへ取消の訂正投稿も流れる）。
//   認証は POST /api/reports と同じ（Bearer = LIFF アクセストークン）。
// ============================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db.js";
import {
  bearerToken,
  requireApproved,
  resolveUserFromAccessToken,
} from "@/lib/auth.js";
import { reportLabel, writeAuditLog } from "@/lib/audit.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status });
}

async function handle(
  req: Request,
  params: Promise<{ id: string }>,
  mode: "request" | "withdraw",
) {
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

  const { user } = resolved;
  const { id } = await params;

  const rep = await prisma.report.findUnique({
    where: { id },
    select: {
      createdById: true,
      workDate: true,
      siteName: true,
      deleteRequestedAt: true,
      client: { select: { name: true } },
    },
  });
  if (!rep) {
    return json(404, {
      ok: false,
      error: "not_found",
      message: "出面が見つかりません（すでに削除された可能性があります）。",
    });
  }
  // 本人の出面のみ（他人の出面には申請できない）。
  if (rep.createdById !== user.id) {
    return json(403, {
      ok: false,
      error: "forbidden",
      message: "自分が入力した出面のみ削除申請できます。",
    });
  }

  if (mode === "request") {
    // すでに申請済みなら何もしない（冪等）。
    if (rep.deleteRequestedAt === null) {
      await prisma.report.update({
        where: { id },
        data: { deleteRequestedAt: new Date(), deleteRequestedBy: user.id },
      });
      await writeAuditLog({
        actorId: user.id,
        actorName: user.displayName,
        action: "REPORT_DELETE_REQUEST",
        reportId: id,
        summary: `${reportLabel(rep.workDate, rep.client.name, rep.siteName)} の削除を申請`,
      });
    }
    return json(200, { ok: true, deleteRequested: true });
  }

  // withdraw: 未申請なら何もしない（冪等）。
  if (rep.deleteRequestedAt !== null) {
    await prisma.report.update({
      where: { id },
      data: { deleteRequestedAt: null, deleteRequestedBy: null },
    });
    await writeAuditLog({
      actorId: user.id,
      actorName: user.displayName,
      action: "REPORT_DELETE_WITHDRAW",
      reportId: id,
      summary: `${reportLabel(rep.workDate, rep.client.name, rep.siteName)} の削除申請を取り下げ`,
    });
  }
  return json(200, { ok: true, deleteRequested: false });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(req, params, "request");
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(req, params, "withdraw");
}

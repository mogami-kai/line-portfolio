// ============================================================
// GET /api/reports/mine — 自分が提出した出面の一覧（LIFF マイページ用）
//
//   認証は POST /api/reports と同じ（Bearer = LIFF アクセストークン）。
//   createdById = 自分 の Report を新しい順に返す（直近300件）。
//   人工は resolveManDays で集計と同じ流儀に揃える。月別の合計は
//   クライアント側（マイページ）で行う（1リクエスト・転送最小）。
// ============================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db.js";
import {
  bearerToken,
  requireApproved,
  resolveUserFromAccessToken,
} from "@/lib/auth.js";
import { resolveManDays, type Shift } from "@/lib/calc.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHIFT_LABEL: Record<Shift, string> = {
  DAY: "日勤",
  HALF: "半日",
  NIGHT: "夜勤",
};

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

  const { user } = resolved;

  const rows = await prisma.report.findMany({
    where: { createdById: user.id },
    orderBy: [{ workDate: "desc" }, { createdAt: "desc" }],
    take: 300,
    select: {
      id: true,
      workDate: true,
      status: true,
      postedToGroup: true,
      siteName: true,
      deleteRequestedAt: true,
      client: { select: { name: true } },
      site: { select: { name: true } },
      entries: {
        select: {
          shift: true,
          manDays: true,
          otHours: true,
          worker: { select: { name: true } },
        },
      },
      expenses: { select: { kind: true, amount: true } },
    },
  });

  const reports = rows.map((r) => {
    let manDays = 0;
    let nightManDays = 0;
    let otHours = 0;
    const workerTokens: string[] = [];
    for (const e of r.entries) {
      const md = resolveManDays(e.shift as Shift, e.manDays);
      manDays += md;
      if (e.shift === "NIGHT") nightManDays += md;
      otHours += Number(e.otHours) || 0;
      const notes: string[] = [];
      if (e.shift !== "DAY") notes.push(SHIFT_LABEL[e.shift as Shift]);
      if (Number(e.otHours) > 0) notes.push(`残${e.otHours}h`);
      const name = e.worker?.name ?? "(不明)";
      workerTokens.push(notes.length ? `${name}（${notes.join("・")}）` : name);
    }
    return {
      id: r.id,
      workDate: r.workDate.toISOString().slice(0, 10),
      clientName: r.client.name,
      siteName: r.siteName?.trim() || r.site?.name || "",
      status: r.status,
      postedToGroup: r.postedToGroup,
      deleteRequested: r.deleteRequestedAt !== null,
      manDays,
      nightManDays,
      otHours,
      workers: workerTokens.join("　"),
      expensesLabel: r.expenses
        .map((x) => `${x.kind}${Number(x.amount).toLocaleString("ja-JP")}円`)
        .join("・"),
    };
  });

  return json(200, { ok: true, reports });
}

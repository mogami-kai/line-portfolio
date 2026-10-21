// ============================================================
// GET /api/cron/notify-retry
//   管理者への出面通知に失敗した出面（notified=false）の自動再通知。
//   外部スケジューラ（GitHub Actions）が毎時叩く（入金確認リマインドと同じワークフロー）。
//   認証: Authorization: Bearer <CRON_SECRET>（env と一致）。
//   本処理は retryUnnotifiedReports に一元化（対象の絞り込み・二重送信防止・上限での打ち切り）。
// ============================================================

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { retryUnnotifiedReports } from "@/lib/notify.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "cron_secret_unset" },
      { status: 500 },
    );
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 401 });
  }

  try {
    const result = await retryUnnotifiedReports();
    if (result.sent > 0) revalidatePath("/admin");
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[cron/notify-retry] failed", e);
    return NextResponse.json(
      { ok: false, error: "retry_failed" },
      { status: 500 },
    );
  }
}

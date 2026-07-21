// ============================================================
// GET /api/cron/due-reminders
//   入金確認リマインドの実行口。外部スケジューラ（GitHub Actions）が毎時叩く。
//   認証: Authorization: Bearer <CRON_SECRET>（env と一致）。
//   本処理は runDueReminder に一元化（設定時刻・二重送信・宛先解決を含む）。
// ============================================================

import { NextResponse } from "next/server";
import { runDueReminder } from "@/lib/dueReminder.js";

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
    const result = await runDueReminder();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[cron/due-reminders] failed", e);
    return NextResponse.json(
      { ok: false, error: "reminder_failed" },
      { status: 500 },
    );
  }
}

// ============================================================
// POST /api/invoices/generate
//   請求書を作成/再作成して、その場で xlsx を返す（ローディング付きボタン用）。
//   body: { clientId, ym }（ym="YYYY-MM"）。
//   ガード: getAdminContext()（管理者のみ・セッションクッキー）。
//   フロー: generateInvoice → loadInvoiceForExport → toXlsx → xlsx を添付で返す。
// ============================================================

import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth.js";
import { generateInvoice } from "@/lib/invoiceService.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const admin = await getAdminContext();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let clientId = "";
  let ym = "";
  try {
    const body = await req.json();
    clientId = String(body?.clientId ?? "");
    ym = String(body?.ym ?? "");
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!clientId || !/^\d{4}-\d{2}$/.test(ym)) {
    return NextResponse.json({ ok: false, error: "bad_input" }, { status: 400 });
  }

  // 作成/再作成（既存があれば明細を作り直す）。作成結果の id だけを返す。
  //   ダウンロードは GET /api/invoices/[id]/export?format=xlsx に委ねる。
  //   理由: iOS Safari は fetch→blob→a.download のプログラム的ダウンロードが不安定で
  //   ファイルが保存されないことがある。確実な「添付レスポンスへの遷移(GET)」で落とす。
  try {
    const inv = await generateInvoice(clientId, ym);
    return NextResponse.json({ ok: true, id: inv.id, invoiceNo: inv.invoiceNo });
  } catch (e) {
    console.error("[invoices/generate] generateInvoice failed", e);
    return NextResponse.json({ ok: false, error: "generate_failed" }, { status: 500 });
  }
}

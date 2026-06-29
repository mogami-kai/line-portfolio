// ============================================================
// POST /api/invoices/generate
//   請求書を作成/再作成して、その場で xlsx を返す（ローディング付きボタン用）。
//   body: { clientId, ym }（ym="YYYY-MM"）。
//   ガード: getAdminContext()（管理者のみ・セッションクッキー）。
//   フロー: generateInvoice → loadInvoiceForExport → toXlsx → xlsx を添付で返す。
// ============================================================

import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth.js";
import { toXlsx } from "@/lib/invoice.js";
import { generateInvoice, loadInvoiceForExport } from "@/lib/invoiceService.js";

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

  // 作成/再作成（既存があれば明細を作り直す）。
  let invoiceId: string;
  try {
    const inv = await generateInvoice(clientId, ym);
    invoiceId = inv.id;
  } catch (e) {
    console.error("[invoices/generate] generateInvoice failed", e);
    return NextResponse.json({ ok: false, error: "generate_failed" }, { status: 500 });
  }

  const data = await loadInvoiceForExport(invoiceId);
  if (!data) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const wb = toXlsx({
    invoiceNo: data.invoiceNo,
    issueDate: data.issueDate,
    yearMonth: data.yearMonth,
    client: data.client,
    honorific: data.honorific,
    address: data.address,
    issuer: data.issuer,
    lines: data.lines,
    taxRate: data.taxRate,
  });
  const buffer = await wb.xlsx.writeBuffer();
  const bytes = new Uint8Array(buffer);
  const safeNo = data.invoiceNo.replace(/[^\w.-]/g, "_");
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="invoice_${safeNo}.xlsx"`,
      "X-Invoice-No": safeNo,
      "Cache-Control": "no-store",
    },
  });
}

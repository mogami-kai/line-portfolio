// ============================================================
// GET /api/invoices/[id]/export?format=csv|xlsx
//
//   既存 Invoice をスナップショットから出力する。
//     - csv  : @/lib/invoice.toCSV（明細フラット・会計/freee 取込用）
//     - xlsx : @/lib/invoice.toXlsx → workbook.xlsx.writeBuffer()（exceljs）
//   Next 15 の dynamic route なので params は Promise。
//   ガード: getAdminContext()（管理者のみ）。
// ============================================================

import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth.js";
import { toCSV, toXlsx } from "@/lib/invoice.js";
import { loadInvoiceForExport } from "@/lib/invoiceService.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await getAdminContext();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const url = new URL(req.url);
  const format = (url.searchParams.get("format") ?? "csv").toLowerCase();

  const data = await loadInvoiceForExport(id);
  if (!data) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const safeNo = data.invoiceNo.replace(/[^\w.-]/g, "_");

  if (format === "xlsx") {
    const wb = toXlsx({
      invoiceNo: data.invoiceNo,
      issueDate: data.issueDate,
      client: data.client,
      honorific: data.honorific,
      address: data.address,
      issuer: data.issuer,
      lines: data.lines,
      taxRate: data.taxRate,
    });
    // exceljs writeBuffer() は Node の Buffer を返す（Buffer は Uint8Array =
    // 有効な BodyInit）。Uint8Array へ正規化して転送を安定させる。
    const buffer = await wb.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer);
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="invoice_${safeNo}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  }

  // 既定: CSV（UTF-8 BOM 付き＝Excel 文字化け対策）。
  const csv = toCSV(
    {
      invoiceNo: data.invoiceNo,
      issueDate: data.issueDate,
      client: data.client,
    },
    data.lines,
  );
  const withBom = "﻿" + csv;
  return new NextResponse(withBom, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="invoice_${safeNo}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

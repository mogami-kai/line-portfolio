// ============================================================
// 請求書サービス（DB ↔ @/lib/invoice の橋渡し）
//
//   - buildClientInvoiceLines: 取引先×月の Report から InvoiceLine[] を生成
//        現場別の RateCard（siteId 優先 → 取引先既定）を解決して単価を当てる。
//   - generateInvoice        : Invoice + InvoiceLine をスナップショット保存（upsert）。
//   - loadInvoiceForExport   : 既存 Invoice を CSV/xlsx 出力用の形に読み出す。
//   金額・明細ロジックは @/lib/invoice（buildInvoiceLines/summarize/toCSV/toXlsx）に一元化。
// ============================================================

import { prisma } from "./db.js";
import { shiftManDays, type Shift } from "./calc.js";
import {
  buildClientLines,
  summarize,
  type InvoiceLine,
} from "./invoice.js";
import { monthRange } from "./aggregate.js";

/**
 * 取引先×月の Report → InvoiceLine[]。
 * 取引先ごとに合算（現場の内訳なし）：委託料＝合計人工×単価、残業＝合計時間×残業単価、
 * 立替経費＝種別ごと（対象外）、請負＝LumpContract。単価は取引先既定（管理者がマスタ入力）。
 */
export async function buildClientInvoiceLines(
  clientId: string,
  yearMonth: string,
  taxRate: number,
): Promise<InvoiceLine[]> {
  const { from, to } = monthRange(yearMonth);

  const reports = await prisma.report.findMany({
    where: { clientId, workDate: { gte: from, lt: to } },
    include: {
      entries: { select: { shift: true, manDays: true, otHours: true } },
      expenses: { select: { kind: true, amount: true, billable: true } },
    },
  });

  // 取引先ごとに合算。
  let manDays = 0;
  let otHours = 0;
  const expByKind = new Map<string, number>();
  for (const r of reports) {
    for (const e of r.entries) {
      manDays +=
        Number(e.manDays) > 0 ? Number(e.manDays) : shiftManDays(e.shift as Shift);
      otHours += Number(e.otHours) || 0;
    }
    for (const x of r.expenses) {
      if (!x.billable) continue; // 請求対象の立替のみ。
      expByKind.set(x.kind, (expByKind.get(x.kind) ?? 0) + Number(x.amount || 0));
    }
  }
  const expenses = Array.from(expByKind.entries()).map(([kind, amount]) => ({
    kind,
    amount,
  }));

  // 請負（UKEOI）契約金額を LumpContract から取り込む（その月・ACTIVE）。
  const lumps = await prisma.lumpContract.findMany({
    where: { clientId, yearMonth, status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
    select: { name: true, amount: true },
  });
  const lumpItems = lumps.map((l) => ({ name: l.name, amount: l.amount }));

  if (
    manDays === 0 &&
    otHours === 0 &&
    lumpItems.length === 0 &&
    expenses.length === 0
  ) {
    return [];
  }

  // 単価（取引先既定・JOYO・月末時点）。管理者がマスタに入れた値。無ければ0。
  const unitPrice = (await resolveDefaultRate(clientId, to)) ?? 0;

  return buildClientLines(
    { manDays, otHours, expenses, lumpItems },
    { unitPrice, taxRate },
  );
}

/** 取引先の既定単価（JOYO・siteId=null・effectiveFrom<=on の最新）。 */
async function resolveDefaultRate(
  clientId: string,
  on: Date,
): Promise<number | null> {
  const card = await prisma.rateCard.findFirst({
    where: { clientId, siteId: null, contractType: "JOYO", effectiveFrom: { lte: on } },
    orderBy: { effectiveFrom: "desc" },
    select: { unitPrice: true },
  });
  return card ? card.unitPrice : null;
}

/** "YYYY-MM" の連番から請求書番号 "YYYY-NNN" を採番（その月の通番）。 */
async function nextInvoiceNo(yearMonth: string): Promise<string> {
  const [y] = yearMonth.split("-");
  const countThisYear = await prisma.invoice.count({
    where: { yearMonth: { startsWith: `${y}-` } },
  });
  const seq = String(countThisYear + 1).padStart(3, "0");
  return `${y}-${seq}`;
}

/**
 * 取引先×月の請求書を生成（スナップショット保存）。
 * 既存（clientId+yearMonth ユニーク）があれば明細を作り直して上書き。
 * issueDate = 月末（末締め＝支払期限）。
 */
export async function generateInvoice(
  clientId: string,
  yearMonth: string,
): Promise<{ id: string; invoiceNo: string }> {
  const setting = await prisma.invoiceSetting.findFirst();
  const taxRate = setting?.taxRate ?? 0.1;

  const lines = await buildClientInvoiceLines(clientId, yearMonth, taxRate);

  const { to } = monthRange(yearMonth);
  // 月末日 = 翌月1日(UTC) の前日。
  const issueDate = new Date(to.getTime() - 24 * 60 * 60 * 1000);

  const existing = await prisma.invoice.findUnique({
    where: { clientId_yearMonth: { clientId, yearMonth } },
  });

  if (existing) {
    // 明細を作り直す（発行前の下書き更新を想定）。
    await prisma.invoiceLine.deleteMany({ where: { invoiceId: existing.id } });
    await prisma.invoice.update({
      where: { id: existing.id },
      data: {
        issueDate,
        lines: {
          create: lines.map((l) => ({
            sortNo: l.sortNo,
            itemName: l.itemName,
            qty: l.qty,
            unitLabel: l.unitLabel,
            unitPrice: l.unitPrice,
            amount: l.amount,
            taxRate: l.taxRate,
          })),
        },
      },
    });
    return { id: existing.id, invoiceNo: existing.invoiceNo };
  }

  const invoiceNo = await nextInvoiceNo(yearMonth);
  const created = await prisma.invoice.create({
    data: {
      clientId,
      yearMonth,
      invoiceNo,
      issueDate,
      status: "DRAFT",
      lines: {
        create: lines.map((l) => ({
          sortNo: l.sortNo,
          itemName: l.itemName,
          qty: l.qty,
          unitLabel: l.unitLabel,
          unitPrice: l.unitPrice,
          amount: l.amount,
          taxRate: l.taxRate,
        })),
      },
    },
  });
  return { id: created.id, invoiceNo: created.invoiceNo };
}

/** 既存 Invoice を出力用に読み出す（CSV/xlsx 共通）。 */
export async function loadInvoiceForExport(invoiceId: string) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      client: { select: { name: true, address: true, honorific: true } },
      lines: { orderBy: { sortNo: "asc" } },
    },
  });
  if (!invoice) return null;

  const setting = await prisma.invoiceSetting.findFirst();
  const taxRate = setting?.taxRate ?? 0.1;

  const lines: InvoiceLine[] = invoice.lines.map((l) => ({
    sortNo: l.sortNo,
    itemName: l.itemName,
    qty: l.qty,
    unitLabel: l.unitLabel,
    unitPrice: l.unitPrice,
    amount: l.amount,
    taxRate: l.taxRate,
  }));

  const issueDateStr = `${invoice.issueDate.getUTCFullYear()}/${String(
    invoice.issueDate.getUTCMonth() + 1,
  ).padStart(2, "0")}/${String(invoice.issueDate.getUTCDate()).padStart(2, "0")}`;

  return {
    invoiceNo: invoice.invoiceNo,
    issueDate: issueDateStr,
    yearMonth: invoice.yearMonth,
    client: invoice.client.name,
    honorific: invoice.client.honorific ?? "御中",
    address: invoice.client.address ?? undefined,
    lines,
    summary: summarize(lines, taxRate),
    taxRate,
    issuer: setting
      ? {
          issuerName: setting.issuerName,
          address: setting.address ?? undefined,
          tel: setting.tel ?? undefined,
          email: setting.email ?? undefined,
          regNumber: setting.regNumber ?? undefined,
          bankInfo: setting.bankInfo ?? undefined,
          taxRate: setting.taxRate,
          contactName: setting.contactName ?? undefined,
        }
      : undefined,
  };
}

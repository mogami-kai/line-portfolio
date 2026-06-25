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
  aggregateForInvoice,
  buildInvoiceLines,
  summarize,
  type InvoiceLine,
  type ReportLike,
} from "./invoice.js";
import { monthRange } from "./aggregate.js";

/** 取引先×月の Report → InvoiceLine[]（現場別 RateCard 解決込み）。 */
export async function buildClientInvoiceLines(
  clientId: string,
  yearMonth: string,
  taxRate: number,
): Promise<InvoiceLine[]> {
  const { from, to } = monthRange(yearMonth);

  const reports = await prisma.report.findMany({
    where: { clientId, workDate: { gte: from, lt: to } },
    include: {
      client: { select: { name: true } },
      site: { select: { id: true, name: true } },
      entries: { select: { shift: true, manDays: true, otHours: true } },
      expenses: { select: { amount: true, billable: true } },
    },
  });

  // 集計入力（ReportLike）へ展開。現場名 → siteId の対応も併せて保持。
  const siteNameToId = new Map<string, string | null>();
  const likes: ReportLike[] = [];

  for (const r of reports) {
    const siteName = r.site?.name ?? "(現場未設定)";
    if (!siteNameToId.has(siteName)) {
      siteNameToId.set(siteName, r.site?.id ?? null);
    }

    let manDays = 0;
    let otHours = 0;
    for (const e of r.entries) {
      const md =
        Number(e.manDays) > 0
          ? Number(e.manDays)
          : shiftManDays(e.shift as Shift);
      manDays += md;
      otHours += Number(e.otHours) || 0;
    }

    // 請求対象の立替経費のみ加算。
    const billableExpense = r.expenses
      .filter((x) => x.billable)
      .reduce((a, x) => a + Number(x.amount || 0), 0);

    likes.push({
      client: r.client.name,
      site: siteName,
      manDays,
      otHours,
      contractType: r.contractType,
      // 請負（UKEOI）金額は Report ではなく LumpContract（後述）から取り込むため、
      // ここでは 0。立替経費のみ計上する。
      lump: 0,
      expense: billableExpense,
    });
  }

  const agg = aggregateForInvoice(likes);
  // 1 取引先のみ対象。aggregateForInvoice は client 名キーなので最初の値を取る。
  let clientName = Object.keys(agg)[0];

  // ── 請負（UKEOI）契約金額を LumpContract から取り込む ──
  //   その月（yearMonth）・ACTIVE の契約を取引先ごとに集める。
  //   常用が無く請負だけの月でも明細を出せるよう、agg が空でも合成する。
  const lumps = await prisma.lumpContract.findMany({
    where: { clientId, yearMonth, status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
    select: { name: true, amount: true },
  });

  if (lumps.length > 0 && !clientName) {
    // 常用ゼロ・請負のみ。取引先名を引いて agg を用意する。
    const c = await prisma.client.findUnique({
      where: { id: clientId },
      select: { name: true },
    });
    if (c) {
      clientName = c.name;
      agg[clientName] = { sites: {}, lump: 0, expense: 0 };
    }
  }

  if (!clientName) return [];
  const clientAgg = agg[clientName];
  if (lumps.length > 0) {
    clientAgg.lumpItems = lumps.map((l) => ({ name: l.name, amount: l.amount }));
  }

  // 現場別単価を事前解決（siteId 優先 → 取引先既定）。
  const onDate = to; // 月末時点の単価で確定。
  const rateCache = new Map<string, number>();
  for (const siteName of Object.keys(clientAgg.sites)) {
    const siteId = siteNameToId.get(siteName) ?? null;
    const unit = await resolveRate(clientId, siteId, "JOYO", onDate);
    rateCache.set(siteName, unit ?? 0);
  }
  const rateFor = (siteName: string): number | null =>
    rateCache.get(siteName) ?? 0;

  return buildInvoiceLines(clientAgg, { rateFor, taxRate });
}

/** RateCard 解決（現場 → 取引先既定）。aggregate.rateLookup と同等。 */
async function resolveRate(
  clientId: string,
  siteId: string | null,
  contractType: "JOYO" | "UKEOI",
  on: Date,
): Promise<number | null> {
  if (siteId) {
    const siteRate = await prisma.rateCard.findFirst({
      where: { clientId, siteId, contractType, effectiveFrom: { lte: on } },
      orderBy: { effectiveFrom: "desc" },
    });
    if (siteRate) return siteRate.unitPrice;
  }
  const def = await prisma.rateCard.findFirst({
    where: { clientId, siteId: null, contractType, effectiveFrom: { lte: on } },
    orderBy: { effectiveFrom: "desc" },
  });
  return def ? def.unitPrice : null;
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
      client: { select: { name: true, address: true } },
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

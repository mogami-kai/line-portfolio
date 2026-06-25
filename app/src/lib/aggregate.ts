// ============================================================
// 月次集計（管理ダッシュボード / 請求書プレビュー共通）
//
//   Prisma の Report を読み、@/lib/invoice の集計ユーティリティと
//   @/lib/calc の金額計算を再利用して「取引先×現場の人工・残業・概算金額」を作る。
//   ロジックは calc / invoice に一元化し、ここでは DB → 集計入力の橋渡しのみ行う。
// ============================================================

import { prisma } from "./db.js";
import { shiftManDays, type Shift } from "./calc.js";
import {
  aggregateForInvoice,
  buildInvoiceLines,
  summarize,
  type ClientAgg,
  type InvoiceLine,
  type ReportLike,
} from "./invoice.js";
import type { OrgKind } from "@prisma/client";

/** "2026-06" → [from, toExclusive)（UTC 月境界）。 */
export function monthRange(yearMonth: string): { from: Date; to: Date } {
  const [y, m] = yearMonth.split("-").map((v) => parseInt(v, 10));
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const to = new Date(Date.UTC(y, m, 1, 0, 0, 0));
  return { from, to };
}

/** 当月の "YYYY-MM"。 */
export function currentYearMonth(ref: Date = new Date()): string {
  const y = ref.getFullYear();
  const m = String(ref.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** RateCard ルックアップ: 取引先×現場×種別の最新有効単価（無ければ取引先既定）。 */
export async function rateLookup(
  clientId: string,
  siteId: string | null,
  contractType: "JOYO" | "UKEOI",
  on: Date,
): Promise<number | null> {
  // 現場指定があれば現場優先、無ければ取引先既定（siteId=null）。
  const siteRate = siteId
    ? await prisma.rateCard.findFirst({
        where: {
          clientId,
          siteId,
          contractType,
          effectiveFrom: { lte: on },
        },
        orderBy: { effectiveFrom: "desc" },
      })
    : null;
  if (siteRate) return siteRate.unitPrice;

  const defaultRate = await prisma.rateCard.findFirst({
    where: {
      clientId,
      siteId: null,
      contractType,
      effectiveFrom: { lte: on },
    },
    orderBy: { effectiveFrom: "desc" },
  });
  return defaultRate ? defaultRate.unitPrice : null;
}

export interface ReportRowForAgg {
  clientId: string;
  clientName: string;
  siteName: string;
  contractType: "JOYO" | "UKEOI";
  source: OrgKind;
  manDays: number;
  otHours: number;
}

/**
 * 指定月の Report を ReportLike（集計入力）に展開する。
 * オプションで source（SELF/PARTNER）で絞り込み。
 * entries の manDays は保存値を優先し、未設定（0/falsy）のときのみ shift から補完。
 */
export async function loadMonthRows(
  yearMonth: string,
  opts?: { source?: OrgKind },
): Promise<ReportRowForAgg[]> {
  const { from, to } = monthRange(yearMonth);
  const reports = await prisma.report.findMany({
    where: {
      workDate: { gte: from, lt: to },
      ...(opts?.source ? { source: opts.source } : {}),
    },
    include: {
      client: { select: { id: true, name: true } },
      site: { select: { name: true } },
      entries: { select: { shift: true, manDays: true, otHours: true } },
    },
  });

  const rows: ReportRowForAgg[] = [];
  for (const r of reports) {
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
    rows.push({
      clientId: r.client.id,
      clientName: r.client.name,
      siteName: r.site?.name ?? "(現場未設定)",
      contractType: r.contractType,
      source: r.source,
      manDays,
      otHours,
    });
  }
  return rows;
}

/** ReportRowForAgg → invoice.ReportLike（集計関数の入力形）。 */
export function toReportLike(rows: ReportRowForAgg[]): ReportLike[] {
  return rows.map((r) => ({
    client: r.clientName,
    site: r.siteName,
    manDays: r.manDays,
    otHours: r.otHours,
    contractType: r.contractType,
  }));
}

export interface ClientMonthSummary {
  clientName: string;
  manDays: number;
  otHours: number;
  /** RateCard を当てた概算金額（税抜）。単価未設定の現場は 0 として概算。 */
  estimatedAmount: number;
}

/**
 * 取引先別の月次サマリ（人工合計・残業合計・概算金額）。
 * 金額は buildInvoiceLines + summarize（calc.ts 経由）で算出。
 * 取引先名 → clientId の対応を rows から引く（同名取引先は最初の id）。
 */
export async function summarizeByClient(
  yearMonth: string,
  rows: ReportRowForAgg[],
): Promise<ClientMonthSummary[]> {
  const onDate = monthRange(yearMonth).to; // 月末時点の単価で概算。
  const nameToClientId = new Map<string, string>();
  for (const r of rows) {
    if (!nameToClientId.has(r.clientName))
      nameToClientId.set(r.clientName, r.clientId);
  }

  const agg = aggregateForInvoice(toReportLike(rows));
  const out: ClientMonthSummary[] = [];

  for (const clientName of Object.keys(agg).sort()) {
    const clientAgg: ClientAgg = agg[clientName];
    const clientId = nameToClientId.get(clientName)!;

    // 現場別単価を事前に解決（async）してキャッシュに積む。
    // 現場名から siteId は直接引けないため、取引先既定単価（siteId=null）で概算する。
    const rateCache = new Map<string, number>();
    let manDays = 0;
    let otHours = 0;
    for (const siteName of Object.keys(clientAgg.sites)) {
      const s = clientAgg.sites[siteName];
      manDays += s.manDays;
      otHours += s.otHours;
      const unit = await rateLookup(clientId, null, "JOYO", onDate);
      rateCache.set(siteName, unit ?? 0);
    }

    // buildInvoiceLines は事前解決済みキャッシュを参照する（同期）。
    const rateFor = (siteName: string): number | null =>
      rateCache.get(siteName) ?? 0;

    const lines: InvoiceLine[] = buildInvoiceLines(clientAgg, {
      rateFor,
      taxRate: 0, // 概算は税抜小計のみ使うので税率0でよい。
    });
    const summary = summarize(lines, 0);

    out.push({
      clientName,
      manDays,
      otHours,
      estimatedAmount: summary.subtotal + summary.exempt,
    });
  }
  return out;
}

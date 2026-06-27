// ============================================================
// 月次集計（管理ダッシュボード / 請求書プレビュー共通）
//
//   Prisma の Report を読み、@/lib/invoice の集計ユーティリティと
//   @/lib/calc の金額計算を再利用して「取引先×現場の人工・残業・概算金額」を作る。
//   ロジックは calc / invoice に一元化し、ここでは DB → 集計入力の橋渡しのみ行う。
// ============================================================

import { unstable_cache } from "next/cache";
import { prisma } from "./db.js";
import { resolveManDays, type Shift } from "./calc.js";
import {
  aggregateForInvoice,
  buildClientLines,
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
      manDays += resolveManDays(e.shift as Shift, e.manDays);
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

  // ★N+1 解消: 取引先既定単価（JOYO・siteId=null）を 1 クエリでまとめ取りし、
  // メモリで取引先→単価に解決する。以前は現場ごとに rateLookup を直列 await して
  // いた（取引先×現場ぶんの DB 往復＝East/Tokyo 間で致命的）。概算は取引先既定単価
  // のみ使うため、現場別の引き当ては不要。
  const clientIds = Array.from(new Set(nameToClientId.values()));
  const rateByClient = await loadDefaultJoyoRates(clientIds, onDate);

  const out: ClientMonthSummary[] = [];
  for (const clientName of Object.keys(agg).sort()) {
    const clientAgg: ClientAgg = agg[clientName];
    const clientId = nameToClientId.get(clientName)!;
    const unit = rateByClient.get(clientId) ?? 0;

    let manDays = 0;
    let otHours = 0;
    for (const siteName of Object.keys(clientAgg.sites)) {
      const s = clientAgg.sites[siteName];
      manDays += s.manDays;
      otHours += s.otHours;
    }

    // 取引先ごとの委託料（人工×単価）＋残業で概算（請求書と同じ作り）。
    const lines: InvoiceLine[] = buildClientLines(
      { manDays, otHours, expenses: [] },
      { unitPrice: unit, taxRate: 0 }, // 概算は税抜小計のみ使うので税率0でよい。
    );
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

/**
 * 取引先既定単価（JOYO・siteId=null・effectiveFrom<=on）を 1 クエリでまとめ取りし、
 * clientId → 最新有効 unitPrice の Map にして返す（N+1 回避）。
 */
async function loadDefaultJoyoRates(
  clientIds: string[],
  on: Date,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (clientIds.length === 0) return map;
  const cards = await prisma.rateCard.findMany({
    where: {
      clientId: { in: clientIds },
      siteId: null,
      contractType: "JOYO",
      effectiveFrom: { lte: on },
    },
    orderBy: { effectiveFrom: "desc" },
    select: { clientId: true, unitPrice: true },
  });
  // effectiveFrom 降順なので、各 clientId 最初の 1 件が最新有効単価。
  for (const c of cards) if (!map.has(c.clientId)) map.set(c.clientId, c.unitPrice);
  return map;
}

// ============================================================
// 職人別サマリ（給料に直結する見方 ＝ 旧 GAS の Summary / Monthly_Report）
//   現場の担当者（後藤・齋…）が普段から「後藤◯◯ 齋◯◯…」で締めていた形。
//   出面の entries を職人ごとに 人工・残業 で合算する（自社=SELF が対象）。
// ============================================================
export interface WorkerMonthSummary {
  workerName: string;
  manDays: number;
  otHours: number;
}

export async function summarizeByWorker(
  yearMonth: string,
  opts?: { source?: OrgKind },
): Promise<WorkerMonthSummary[]> {
  const { from, to } = monthRange(yearMonth);
  const reports = await prisma.report.findMany({
    where: {
      workDate: { gte: from, lt: to },
      ...(opts?.source ? { source: opts.source } : {}),
    },
    select: {
      entries: {
        select: {
          manDays: true,
          otHours: true,
          shift: true,
          worker: { select: { name: true } },
        },
      },
    },
  });

  const map = new Map<string, { manDays: number; otHours: number }>();
  for (const r of reports) {
    for (const e of r.entries) {
      const name = e.worker?.name ?? "(不明)";
      const md = resolveManDays(e.shift as Shift, e.manDays);
      const cur = map.get(name) ?? { manDays: 0, otHours: 0 };
      cur.manDays += md;
      cur.otHours += Number(e.otHours) || 0;
      map.set(name, cur);
    }
  }
  return Array.from(map.entries())
    .map(([workerName, v]) => ({ workerName, manDays: v.manDays, otHours: v.otHours }))
    .sort((a, b) => b.manDays - a.manDays || a.workerName.localeCompare(b.workerName, "ja"));
}

// ============================================================
// 月次サマリのキャッシュ（管理ダッシュボード）
//   自社/パートナーの取引先別サマリ＋職人別サマリ＋自社合計を 1 つにまとめ、
//   unstable_cache でキャッシュ（tag="reports"・revalidate=60s）。出面の
//   作成/承認/削除時に revalidateTag("reports") で無効化する。
// ============================================================
export interface MonthSummaryData {
  self: ClientMonthSummary[];
  partner: ClientMonthSummary[];
  byWorker: WorkerMonthSummary[];
  selfTotals: { manDays: number; otHours: number; amount: number };
}

async function computeMonthSummary(yearMonth: string): Promise<MonthSummaryData> {
  const [selfRows, partnerRows, byWorker] = await Promise.all([
    loadMonthRows(yearMonth, { source: "SELF" }),
    loadMonthRows(yearMonth, { source: "PARTNER" }),
    summarizeByWorker(yearMonth, { source: "SELF" }),
  ]);
  const [self, partner] = await Promise.all([
    summarizeByClient(yearMonth, selfRows),
    summarizeByClient(yearMonth, partnerRows),
  ]);
  const selfTotals = {
    manDays: self.reduce((a, r) => a + r.manDays, 0),
    otHours: self.reduce((a, r) => a + r.otHours, 0),
    amount: self.reduce((a, r) => a + r.estimatedAmount, 0),
  };
  return { self, partner, byWorker, selfTotals };
}

/** 月次サマリをキャッシュして返す（tag="reports" で無効化）。 */
export function getMonthSummary(yearMonth: string): Promise<MonthSummaryData> {
  return unstable_cache(
    () => computeMonthSummary(yearMonth),
    ["month-summary", yearMonth],
    { revalidate: 60, tags: ["reports"] },
  )();
}

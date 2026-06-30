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

  // v3: 常用(JOYO)は取引先の常用単価を優先（未設定なら旧RateCard・過去分維持）。
  if (contractType === "JOYO") {
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: { unitPrice: true },
    });
    if (client?.unitPrice != null) return client.unitPrice;
  }

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
  /** 請負(UKEOI)の契約金額（税抜）。常用は 0。概算金額に反映する。 */
  contractAmount: number;
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
      // 確定済みのみ集計（要確認 NEEDS_REVIEW は承認されるまで金額・集計に乗せない）。
      status: "CONFIRMED",
      // 無効化した組織の出面は集計・請求から除外。
      org: { active: true },
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
      // v3: 自由入力の現場名(Report.siteName)を最優先。無ければ旧現場マスタ名。
      siteName: r.siteName?.trim() || r.site?.name || "(現場未設定)",
      contractType: r.contractType,
      source: r.source,
      manDays,
      otHours,
      contractAmount: r.contractType === "UKEOI" ? Number(r.contractAmount) || 0 : 0,
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
    // 請負(UKEOI)の契約金額は概算で「一式」として積む（lump に載せる）。
    lump: r.contractAmount,
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

    // 取引先ごとの委託料（人工×単価）＋残業＋請負(UKEOI)契約金額で概算（請求書と同じ作り）。
    // 概算は税抜小計のみ使うため、請負はその月の合算を 1 件にまとめて積めば十分。
    const ukeoiAmounts = clientAgg.lump > 0 ? [clientAgg.lump] : [];
    const lines: InvoiceLine[] = buildClientLines(
      { manDays, otHours, expenses: [], ukeoiAmounts },
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
  // v3: 取引先の常用単価を優先（1クエリ）。
  const clients = await prisma.client.findMany({
    where: { id: { in: clientIds } },
    select: { id: true, unitPrice: true },
  });
  for (const c of clients) if (c.unitPrice != null) map.set(c.id, c.unitPrice);
  // 未設定分のみ旧RateCard既定でフォールバック（過去分維持）。
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
      // 確定済みのみ（要確認は職人別集計にも乗せない）／無効化組織は除外。
      status: "CONFIRMED",
      org: { active: true },
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
// 建て替え集計（立替経費を「立替えた人 × 用途」で集計）
//   請求書・人工集計とは独立。立替えた人ごとに用途(種別)と金額をまとめる。
//   立替えた人(paidBy)が未指定の経費は「未指定」にまとめる。
// ============================================================
export interface ExpensePayerSummary {
  /** 立替えた人の名前（未指定は "未指定"）。 */
  paidBy: string;
  /** 用途(種別)ごとの金額。 */
  items: { kind: string; amount: number }[];
  /** その人の合計。 */
  total: number;
}

const UNASSIGNED_PAYER = "未指定";

export async function summarizeExpenses(
  yearMonth: string,
): Promise<{ payers: ExpensePayerSummary[]; grandTotal: number }> {
  const { from, to } = monthRange(yearMonth);
  const expenses = await prisma.expense.findMany({
    where: {
      workDate: { gte: from, lt: to },
      // 出面に紐づく経費は確定済み・有効組織のみ。出面を持たない経費はそのまま含める。
      OR: [
        { reportId: null },
        { report: { status: "CONFIRMED", org: { active: true } } },
      ],
    },
    select: { paidBy: true, kind: true, amount: true },
  });

  // 立替えた人 → 用途(種別) → 金額。
  const byPayer = new Map<string, Map<string, number>>();
  for (const e of expenses) {
    const payer = e.paidBy?.trim() || UNASSIGNED_PAYER;
    const kind = e.kind?.trim() || "その他";
    const kinds = byPayer.get(payer) ?? new Map<string, number>();
    kinds.set(kind, (kinds.get(kind) ?? 0) + (Number(e.amount) || 0));
    byPayer.set(payer, kinds);
  }

  let grandTotal = 0;
  const payers: ExpensePayerSummary[] = [];
  for (const [payer, kinds] of byPayer) {
    const items = Array.from(kinds.entries())
      .map(([kind, amount]) => ({ kind, amount }))
      .sort((a, b) => b.amount - a.amount || a.kind.localeCompare(b.kind, "ja"));
    const total = items.reduce((a, i) => a + i.amount, 0);
    grandTotal += total;
    payers.push({ paidBy: payer, items, total });
  }
  // 金額の多い順。未指定は最後に寄せる。
  payers.sort((a, b) => {
    if (a.paidBy === UNASSIGNED_PAYER) return 1;
    if (b.paidBy === UNASSIGNED_PAYER) return -1;
    return b.total - a.total || a.paidBy.localeCompare(b.paidBy, "ja");
  });
  return { payers, grandTotal };
}

// ============================================================
// 月次サマリのキャッシュ（管理ダッシュボード）
//   自社/パートナーの取引先別サマリ＋職人別サマリ＋建て替え集計を 1 つにまとめ、
//   unstable_cache でキャッシュ（tag="reports"・revalidate=60s）。出面の
//   作成/承認/削除時に revalidateTag("reports") で無効化する。
// ============================================================
export interface MonthSummaryData {
  self: ClientMonthSummary[];
  partner: ClientMonthSummary[];
  byWorker: WorkerMonthSummary[];
  selfTotals: { manDays: number; otHours: number; amount: number };
  expensePayers: ExpensePayerSummary[];
  expenseTotal: number;
}

async function computeMonthSummary(yearMonth: string): Promise<MonthSummaryData> {
  const [selfRows, partnerRows, byWorker, expenseAgg] = await Promise.all([
    loadMonthRows(yearMonth, { source: "SELF" }),
    loadMonthRows(yearMonth, { source: "PARTNER" }),
    summarizeByWorker(yearMonth, { source: "SELF" }),
    summarizeExpenses(yearMonth),
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
  return {
    self,
    partner,
    byWorker,
    selfTotals,
    expensePayers: expenseAgg.payers,
    expenseTotal: expenseAgg.grandTotal,
  };
}

/** 月次サマリをキャッシュして返す（tag="reports" で無効化）。 */
export function getMonthSummary(yearMonth: string): Promise<MonthSummaryData> {
  return unstable_cache(
    () => computeMonthSummary(yearMonth),
    ["month-summary", yearMonth],
    { revalidate: 60, tags: ["reports"] },
  )();
}

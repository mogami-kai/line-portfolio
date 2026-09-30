// ============================================================
// 粗利（会社に残るお金）— /admin/aggregate
//
//   自社 と 協力会社 を別々に計算し、最後に合算して取り分を分ける。
//     自社     : 売上（税抜）− 立替経費 − 人工（自社の職人の給料）     = 自社の残り
//     協力会社 : 売上（税抜）− 立替経費 − 人工（協力会社への支払い） = 協力会社分の残り
//     合計     : 自社の残り ＋ 協力会社分の残り − その他経費 = 会社に残る額
//                → 取り分（profitShareName へ profitShareRate）／ 会社（残り）
//
//   売上は請求書と同じ計算（collectBillingWork → buildBillingLines。夜勤単価・請負込み）を
//   取引先×出面の区分（SELF/PARTNER）ごとに行って合算する。請負一式（LumpContract）は
//   会社として受けた契約なので自社側に積む。
//   立替経費は立替集計と同じ対象（確定済み・有効組織の出面にひも付くもの＋出面なし）。
//   出面なしの経費は自社側。
//   人工は職人別集計（summarizeByWorker）の給料概算をそのまま合計する。協力会社への支払いは
//   協力会社の職人に入れた単価で同じ式（夜勤1.25倍・残業）で計算する。
//
//   計算（DB非依存の純粋関数）と取得（summarizeMonthProfit）を分け、前者を単体テストする。
// ============================================================

import type { OrgKind, Role } from "@prisma/client";
import { prisma } from "./db.js";
import {
  loadClientRates,
  monthRange,
  summarizeByWorker,
  type ClientRateInfo,
  type WorkerMonthSummary,
} from "./aggregate.js";
import { buildBillingLines } from "./invoice.js";
import { collectBillingWork, type BillingReportRow } from "./invoiceService.js";

/** 取り分の既定（InvoiceSetting が未作成のとき）。 */
export const DEFAULT_PROFIT_SHARE_NAME = "大和";
export const DEFAULT_PROFIT_SHARE_RATE = 0.2;

/** ADMIN 以外で「粗利を見られる」に設定できるロール。 */
export const PROFIT_VIEWABLE_ROLES = ["SELF_ADMIN", "ORG_ADMIN"] as const;

/**
 * 粗利の閲覧範囲。
 *   "ALL"  … 自社＋協力会社（ADMIN）
 *   "SELF" … 自社のみ（設定で許可された SELF_ADMIN / ORG_ADMIN。自社所属に限る）
 *   null   … 見られない
 * 協力会社所属の組織管理者には、許可されていても出さない（会社の取り分・単価を渡さない）。
 */
export function profitScopeFor(
  u: { user: { role: Role }; org: { kind: OrgKind } },
  viewRoles: readonly Role[],
): "ALL" | "SELF" | null {
  if (u.user.role === "ADMIN") return "ALL";
  const viewable = (PROFIT_VIEWABLE_ROLES as readonly Role[]).includes(u.user.role);
  if (viewable && viewRoles.includes(u.user.role) && u.org.kind === "SELF") {
    return "SELF";
  }
  return null;
}

/** 1区分（自社 or 協力会社）の粗利。 */
export interface ProfitBlock {
  /** 売上（税抜）。 */
  sales: number;
  /** 立替経費。 */
  expenses: number;
  /** 人工（自社＝職人の給料 / 協力会社＝協力会社への支払い）。 */
  labor: number;
  /** 売上 − 立替経費 − 人工。 */
  remaining: number;
}

export function profitBlock(
  sales: number,
  expenses: number,
  labor: number,
): ProfitBlock {
  return { sales, expenses, labor, remaining: sales - expenses - labor };
}

/**
 * 会社に残る額を 取り分 と 会社 に分ける。
 * 取り分は円未満切り捨て、会社はその残り（合計が必ず元の額に一致する）。
 * 0以下（赤字）のときは取り分0。率は 0〜1 に丸める。
 */
export function splitShare(
  amount: number,
  rate: number,
): { share: number; company: number } {
  const r = Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 0;
  const share = amount > 0 ? Math.floor(amount * r) : 0;
  return { share, company: amount - share };
}

/** 売上計算に使う出面1件（取引先・区分つき）。 */
export interface SalesReportRow extends BillingReportRow {
  clientId: string;
  clientName: string;
  source: OrgKind;
}

/** 請負一式（LumpContract）1件。 */
export interface SalesLumpRow {
  clientId: string;
  name: string;
  amount: number;
}

/**
 * 売上（税抜）を区分ごとに計算する。DB非依存の純粋関数。
 * 取引先×区分ごとに請求書と同じ明細（buildBillingLines）を作って金額を合計する。
 * 単価未設定（0円）で常用の人工・残業がある取引先は unpricedClients に名前を返す。
 */
export function computeSalesBySource(
  yearMonth: string,
  reports: SalesReportRow[],
  rates: Map<string, ClientRateInfo>,
  lumps: SalesLumpRow[],
): Record<OrgKind, { sales: number; unpricedClients: string[] }> {
  // 取引先×区分 → 出面。請負一式だけの取引先も自社側に1グループ作る。
  const groups = new Map<
    string,
    { clientId: string; clientName: string; source: OrgKind; rows: SalesReportRow[] }
  >();
  const keyOf = (clientId: string, source: OrgKind) => `${clientId}\u0000${source}`;
  for (const r of reports) {
    const k = keyOf(r.clientId, r.source);
    const g =
      groups.get(k) ??
      { clientId: r.clientId, clientName: r.clientName, source: r.source, rows: [] };
    g.rows.push(r);
    groups.set(k, g);
  }
  const lumpsByClient = new Map<string, SalesLumpRow[]>();
  for (const l of lumps) {
    const list = lumpsByClient.get(l.clientId) ?? [];
    list.push(l);
    lumpsByClient.set(l.clientId, list);
    const k = keyOf(l.clientId, "SELF");
    if (!groups.has(k)) {
      groups.set(k, { clientId: l.clientId, clientName: "", source: "SELF", rows: [] });
    }
  }

  const out: Record<OrgKind, { sales: number; unpricedClients: string[] }> = {
    SELF: { sales: 0, unpricedClients: [] },
    PARTNER: { sales: 0, unpricedClients: [] },
  };
  for (const g of groups.values()) {
    const rate = rates.get(g.clientId);
    const unit = rate?.resolvedUnit ?? 0;
    const { sites, otHours, ukeoiAmounts } = collectBillingWork(g.rows);
    const lines = buildBillingLines(
      {
        billingMode: rate?.billingMode ?? "AGGREGATE",
        yearMonth,
        unitPrice: unit,
        nightUnitPrice: rate?.nightUnitPrice ?? 0,
        otUnitPrice: rate?.otUnitPrice ?? null,
        otHours,
        sites,
        ukeoiAmounts,
        lumpItems:
          g.source === "SELF"
            ? (lumpsByClient.get(g.clientId) ?? []).map((l) => ({
                name: l.name,
                amount: l.amount,
              }))
            : [],
        expenses: [],
      },
      0,
    );
    out[g.source].sales += lines.reduce((a, l) => a + l.amount, 0);
    const hasJoyoWork =
      otHours > 0 || sites.some((s) => s.dayManDays > 0 || s.nightManDays > 0);
    if (unit <= 0 && hasJoyoWork) {
      out[g.source].unpricedClients.push(g.clientName);
    }
  }
  for (const k of ["SELF", "PARTNER"] as const) {
    out[k].unpricedClients.sort((a, b) => a.localeCompare(b, "ja"));
  }
  return out;
}

/** 職人別集計 → 人工（給料/支払い）の合計と、単価未設定で出面のある職人名。 */
export function sumLabor(workers: WorkerMonthSummary[]): {
  labor: number;
  unpricedWorkers: string[];
} {
  let labor = 0;
  const unpricedWorkers: string[] = [];
  for (const w of workers) {
    labor += w.pay;
    if (w.manDays > 0 && !(w.unitPrice && w.unitPrice > 0)) {
      unpricedWorkers.push(w.workerName);
    }
  }
  return { labor, unpricedWorkers };
}

/** 立替経費を区分ごとに合計する（出面なしは自社）。 */
export function sumExpensesBySource(
  rows: { amount: number; source: OrgKind | null }[],
): Record<OrgKind, number> {
  const out: Record<OrgKind, number> = { SELF: 0, PARTNER: 0 };
  for (const r of rows) {
    out[r.source ?? "SELF"] += Number(r.amount) || 0;
  }
  return out;
}

export interface OtherExpenseRow {
  id: string;
  name: string;
  amount: number;
}

export interface ProfitSummary {
  self: ProfitBlock;
  /** 協力会社分。閲覧範囲が自社のみなら null（協力会社の存在も出さない）。 */
  partner: ProfitBlock | null;
  otherExpenses: OtherExpenseRow[];
  otherTotal: number;
  /** 会社に残る額（自社の残り ＋ 協力会社分の残り − その他経費）。 */
  remaining: number;
  shareName: string;
  shareRate: number;
  /** 取り分（shareName へ）。 */
  share: number;
  /** 会社に残る（remaining − share）。 */
  company: number;
  warnings: {
    /** 単価未設定の取引先（自社側）。 */
    unpricedClients: string[];
    /** 単価未設定の取引先（協力会社側。閲覧範囲が自社のみなら空）。 */
    unpricedPartnerClients: string[];
    /** 単価未設定の自社の職人。 */
    unpricedWorkers: string[];
    /** 単価未設定の協力会社の職人（閲覧範囲が自社のみなら空）。 */
    unpricedPartnerWorkers: string[];
  };
}

/** 各部品 → 粗利の全体。DB非依存の純粋関数。 */
export function composeProfit(input: {
  self: ProfitBlock;
  partner: ProfitBlock | null;
  otherExpenses: OtherExpenseRow[];
  shareName: string;
  shareRate: number;
  warnings: ProfitSummary["warnings"];
}): ProfitSummary {
  const otherTotal = input.otherExpenses.reduce((a, x) => a + x.amount, 0);
  const remaining =
    input.self.remaining + (input.partner?.remaining ?? 0) - otherTotal;
  const { share, company } = splitShare(remaining, input.shareRate);
  return {
    self: input.self,
    partner: input.partner,
    otherExpenses: input.otherExpenses,
    otherTotal,
    remaining,
    shareName: input.shareName,
    shareRate: input.shareRate,
    share,
    company,
    warnings: input.warnings,
  };
}

/**
 * 月の粗利を DB から集計する。
 *   scope="ALL"  … 自社＋協力会社（協力会社の職人の支払い一覧 partnerWorkers も返す）
 *   scope="SELF" … 自社のみ（協力会社のデータは一切読まない）
 */
export async function summarizeMonthProfit(
  yearMonth: string,
  scope: "ALL" | "SELF",
): Promise<{ profit: ProfitSummary; partnerWorkers: WorkerMonthSummary[] }> {
  const includePartner = scope === "ALL";
  const { from, to } = monthRange(yearMonth);
  const sources: OrgKind[] = includePartner ? ["SELF", "PARTNER"] : ["SELF"];

  const [reports, lumps, expenseRows, selfWorkers, partnerWorkers, others, setting] =
    await Promise.all([
      // 請求書・集計と同じ対象（確定済み・有効組織）。
      prisma.report.findMany({
        where: {
          workDate: { gte: from, lt: to },
          status: "CONFIRMED",
          org: { active: true },
          source: { in: sources },
        },
        select: {
          clientId: true,
          source: true,
          contractType: true,
          contractAmount: true,
          siteName: true,
          site: { select: { name: true } },
          client: { select: { name: true } },
          entries: { select: { shift: true, manDays: true, otHours: true } },
        },
      }),
      prisma.lumpContract.findMany({
        where: { yearMonth, status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
        select: { clientId: true, name: true, amount: true },
      }),
      // 立替集計（全社）と同じ対象。自社のみのときは協力会社の出面の経費を読まない。
      prisma.expense.findMany({
        where: {
          workDate: { gte: from, lt: to },
          OR: [
            { reportId: null },
            {
              report: {
                status: "CONFIRMED",
                org: { active: true },
                source: { in: sources },
              },
            },
          ],
        },
        select: { amount: true, report: { select: { source: true } } },
      }),
      summarizeByWorker(yearMonth, { source: "SELF" }),
      includePartner
        ? summarizeByWorker(yearMonth, { source: "PARTNER" })
        : Promise.resolve([] as WorkerMonthSummary[]),
      prisma.otherExpense.findMany({
        where: { yearMonth },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, amount: true },
      }),
      prisma.invoiceSetting.findFirst({
        select: { profitShareName: true, profitShareRate: true },
      }),
    ]);

  const clientIds = Array.from(
    new Set([...reports.map((r) => r.clientId), ...lumps.map((l) => l.clientId)]),
  );
  const rates = await loadClientRates(clientIds, to);
  const sales = computeSalesBySource(
    yearMonth,
    reports.map((r) => ({
      clientId: r.clientId,
      clientName: r.client.name,
      source: r.source,
      contractType: r.contractType,
      contractAmount: r.contractAmount,
      siteName: r.siteName,
      site: r.site,
      entries: r.entries,
    })),
    rates,
    lumps,
  );
  const expenses = sumExpensesBySource(
    expenseRows.map((x) => ({ amount: x.amount, source: x.report?.source ?? null })),
  );
  const selfLabor = sumLabor(selfWorkers);
  const partnerLabor = sumLabor(partnerWorkers);

  const profit = composeProfit({
    self: profitBlock(sales.SELF.sales, expenses.SELF, selfLabor.labor),
    partner: includePartner
      ? profitBlock(sales.PARTNER.sales, expenses.PARTNER, partnerLabor.labor)
      : null,
    otherExpenses: others,
    shareName: setting?.profitShareName?.trim() || DEFAULT_PROFIT_SHARE_NAME,
    shareRate: setting?.profitShareRate ?? DEFAULT_PROFIT_SHARE_RATE,
    warnings: {
      unpricedClients: sales.SELF.unpricedClients,
      unpricedPartnerClients: includePartner ? sales.PARTNER.unpricedClients : [],
      unpricedWorkers: selfLabor.unpricedWorkers,
      unpricedPartnerWorkers: includePartner ? partnerLabor.unpricedWorkers : [],
    },
  });
  return { profit, partnerWorkers };
}

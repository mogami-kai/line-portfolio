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
import { resolveManDays, type Shift } from "./calc.js";
import {
  buildBillingLines,
  summarize,
  type InvoiceLine,
  type SiteWork,
} from "./invoice.js";
import { monthRange } from "./aggregate.js";
import { jstTodayDate, computeDueDate } from "./invoiceDates.js";

/**
 * 取引先×月の Report → InvoiceLine[]。
 * 取引先ごとに合算（現場の内訳なし）：委託料＝合計人工×単価、残業＝合計時間×残業単価、
 * 立替経費＝種別ごと（対象外）、請負＝LumpContract。単価は取引先既定（管理者がマスタ入力）。
 */
export async function buildClientInvoiceLines(
  clientId: string,
  yearMonth: string,
  taxRate: number,
  // 請求方式の上書き（請求書作成時に「集約」「現場ごと」を選んで両パターン出せる）。
  billingModeOverride?: "AGGREGATE" | "PER_SITE",
): Promise<InvoiceLine[]> {
  const { from, to } = monthRange(yearMonth);

  const reports = await prisma.report.findMany({
    where: {
      clientId,
      workDate: { gte: from, lt: to },
      // 確定済みのみ請求対象（要確認 NEEDS_REVIEW は承認されるまで金額に乗せない）。
      status: "CONFIRMED",
      // 無効化した組織の出面は請求から除外。
      org: { active: true },
    },
    select: {
      contractType: true,
      contractAmount: true,
      siteName: true,
      site: { select: { name: true } },
      entries: { select: { shift: true, manDays: true, otHours: true } },
    },
  });

  // 現場ごとに「日勤(DAY+HALF)」「夜勤(NIGHT)」の人工を畳む。残業は全体で合算。
  //   委託料の人工/残業は「常用（JOYO）」のみ積む。請負（UKEOI）は Report ごとの
  //   contractAmount を「○月委託料 数量1（式）」で計上（人工×単価には混ぜない＝二重計上回避）。
  const siteMap = new Map<string, SiteWork>();
  let otHours = 0;
  const ukeoiAmounts: number[] = [];
  for (const r of reports) {
    if (r.contractType === "JOYO") {
      const siteName = r.siteName?.trim() || r.site?.name || "(現場未設定)";
      let agg = siteMap.get(siteName);
      if (!agg) {
        agg = { site: siteName, dayManDays: 0, nightManDays: 0 };
        siteMap.set(siteName, agg);
      }
      for (const e of r.entries) {
        const md = resolveManDays(e.shift as Shift, e.manDays);
        if (e.shift === "NIGHT") agg.nightManDays += md;
        else agg.dayManDays += md;
        otHours += Number(e.otHours) || 0;
      }
    } else if (r.contractType === "UKEOI") {
      // UKEOI の職人 entries は社内記録用で請求額に影響しない（共通仕様）。
      const amt = Number(r.contractAmount) || 0;
      if (amt > 0) ukeoiAmounts.push(amt);
    }
  }

  // 請負（UKEOI）契約金額を LumpContract から取り込む（その月・ACTIVE）。
  const lumps = await prisma.lumpContract.findMany({
    where: { clientId, yearMonth, status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
    select: { name: true, amount: true },
  });
  const lumpItems = lumps.map((l) => ({ name: l.name, amount: l.amount }));

  const sites = Array.from(siteMap.values());
  const hasWork =
    sites.some((s) => s.dayManDays > 0 || s.nightManDays > 0) ||
    otHours > 0 ||
    lumpItems.length > 0 ||
    ukeoiAmounts.length > 0;
  if (!hasWork) return [];

  // 単価（取引先既定・JOYO・月末時点）。管理者がマスタ/集計画面で入れた値。無ければ0。
  const unitPrice = (await resolveDefaultRate(clientId, to)) ?? 0;
  // 夜勤単価・残業単価・請求方式（取引先設定）。
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { nightUnitPrice: true, otUnitPrice: true, billingMode: true },
  });

  return buildBillingLines(
    {
      billingMode: billingModeOverride ?? client?.billingMode ?? "AGGREGATE",
      yearMonth,
      unitPrice,
      nightUnitPrice: client?.nightUnitPrice ?? 0,
      otUnitPrice: client?.otUnitPrice ?? null,
      otHours,
      sites,
      lumpItems,
      ukeoiAmounts,
      expenses: [],
    },
    taxRate,
  );
}

/** 取引先の既定単価（JOYO・siteId=null・effectiveFrom<=on の最新）。 */
async function resolveDefaultRate(
  clientId: string,
  on: Date,
): Promise<number | null> {
  // v3: 取引先の常用単価を優先。未設定なら旧RateCard既定（過去分維持）。
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { unitPrice: true },
  });
  if (client?.unitPrice != null) return client.unitPrice;
  const card = await prisma.rateCard.findFirst({
    where: { clientId, siteId: null, contractType: "JOYO", effectiveFrom: { lte: on } },
    orderBy: { effectiveFrom: "desc" },
    select: { unitPrice: true },
  });
  return card ? card.unitPrice : null;
}

/**
 * 指定取引先のうち「既定単価（JOYO・siteId=null・effectiveFrom<=on）」が登録済みの
 * clientId 集合を 1 クエリで返す。請求一覧で「単価未登録（→0円請求）」を警告するために使う。
 */
export async function clientsWithDefaultRate(
  clientIds: string[],
  on: Date,
): Promise<Set<string>> {
  if (clientIds.length === 0) return new Set();
  const has = new Set<string>();
  // v3: 取引先に常用単価が入っていれば「登録済み」。
  const priced = await prisma.client.findMany({
    where: { id: { in: clientIds }, unitPrice: { not: null } },
    select: { id: true },
  });
  priced.forEach((c) => has.add(c.id));
  // 未設定分は旧RateCard既定でフォールバック判定（過去分維持）。
  const cards = await prisma.rateCard.findMany({
    where: {
      clientId: { in: clientIds },
      siteId: null,
      contractType: "JOYO",
      effectiveFrom: { lte: on },
    },
    select: { clientId: true },
  });
  cards.forEach((c) => has.add(c.clientId));
  return has;
}

// ============================================================
// 内訳（確認用）: 取引先×月を「現場別・職人別・日別」に展開
//   外向き請求書には出さないが、管理者が「内訳を見る」で根拠を確認するための集計。
//   委託料は常用(JOYO)のみ（請求と同規約）。要確認件数は契約種別に依らず数える。
//   当月の全 Report を 1 クエリで取り、メモリで取引先ごとに畳む（N+1回避）。
// ============================================================
export interface BreakdownRow {
  name: string;
  manDays: number;
  otHours: number;
}
export interface ClientMonthDetails {
  manDays: number;
  otHours: number;
  needsReview: number;
  bySite: BreakdownRow[];
  byWorker: BreakdownRow[];
  byDay: BreakdownRow[];
}

export async function getMonthClientDetails(
  yearMonth: string,
): Promise<Map<string, ClientMonthDetails>> {
  const { from, to } = monthRange(yearMonth);
  const reports = await prisma.report.findMany({
    where: { workDate: { gte: from, lt: to }, org: { active: true } },
    select: {
      clientId: true,
      status: true,
      contractType: true,
      workDate: true,
      siteName: true,
      site: { select: { name: true } },
      entries: {
        select: {
          shift: true,
          manDays: true,
          otHours: true,
          worker: { select: { name: true } },
        },
      },
    },
  });

  type Acc = {
    manDays: number;
    otHours: number;
    needsReview: number;
    site: Map<string, BreakdownRow>;
    worker: Map<string, BreakdownRow>;
    day: Map<string, BreakdownRow>;
  };
  const accs = new Map<string, Acc>();
  const ensure = (id: string): Acc => {
    let a = accs.get(id);
    if (!a) {
      a = {
        manDays: 0,
        otHours: 0,
        needsReview: 0,
        site: new Map(),
        worker: new Map(),
        day: new Map(),
      };
      accs.set(id, a);
    }
    return a;
  };
  const bump = (m: Map<string, BreakdownRow>, name: string, md: number, ot: number) => {
    const r = m.get(name) ?? { name, manDays: 0, otHours: 0 };
    r.manDays += md;
    r.otHours += ot;
    m.set(name, r);
  };

  for (const r of reports) {
    const a = ensure(r.clientId);
    if (r.status === "NEEDS_REVIEW") a.needsReview += 1;
    // 確定済みのみ内訳に積む（要確認は件数だけ数え、人工/金額には入れない）。
    if (r.status !== "CONFIRMED") continue;
    if (r.contractType !== "JOYO") continue; // 委託料の内訳は常用のみ。
    // v3: 自由入力の現場名(Report.siteName)を最優先。無ければ旧現場マスタ名。
    const siteName = r.siteName?.trim() || r.site?.name || "(現場未設定)";
    const dateStr = `${r.workDate.getUTCMonth() + 1}/${r.workDate.getUTCDate()}`;
    for (const e of r.entries) {
      const md = resolveManDays(e.shift as Shift, e.manDays);
      const ot = Number(e.otHours) || 0;
      a.manDays += md;
      a.otHours += ot;
      bump(a.site, siteName, md, ot);
      bump(a.worker, e.worker?.name ?? "(不明)", md, ot);
      bump(a.day, dateStr, md, ot);
    }
  }

  const out = new Map<string, ClientMonthDetails>();
  for (const [id, a] of accs) {
    out.set(id, {
      manDays: a.manDays,
      otHours: a.otHours,
      needsReview: a.needsReview,
      bySite: Array.from(a.site.values()).sort((x, y) => y.manDays - x.manDays),
      byWorker: Array.from(a.worker.values()).sort((x, y) => y.manDays - x.manDays),
      byDay: Array.from(a.day.values()).sort(
        (x, y) => parseInt(x.name) - parseInt(y.name),
      ),
    });
  }
  return out;
}

/**
 * 請求書番号 "YYYY-NNN" を採番（年内の通番＝count+1）。
 * offset は採番衝突時のリトライ用（衝突した番号を飛ばして次を試す）。
 */
async function nextInvoiceNo(yearMonth: string, offset = 0): Promise<string> {
  const [y] = yearMonth.split("-");
  const countThisYear = await prisma.invoice.count({
    where: { yearMonth: { startsWith: `${y}-` } },
  });
  const seq = String(countThisYear + 1 + offset).padStart(3, "0");
  return `${y}-${seq}`;
}

/**
 * 取引先×月の請求書を生成（スナップショット保存）。
 * 既存（clientId+yearMonth ユニーク）があれば明細を作り直して上書き。
 * issueDate = 作成した当日（＝請求日／制作日）。dueDate = 翌月の Client.paymentDay（＝支払期限）。
 */
export async function generateInvoice(
  clientId: string,
  yearMonth: string,
  billingModeOverride?: "AGGREGATE" | "PER_SITE",
): Promise<{ id: string; invoiceNo: string }> {
  const setting = await prisma.invoiceSetting.findFirst();
  const taxRate = setting?.taxRate ?? 0.1;

  const lines = await buildClientInvoiceLines(
    clientId,
    yearMonth,
    taxRate,
    billingModeOverride,
  );
  const lineCreate = lines.map((l) => ({
    sortNo: l.sortNo,
    itemName: l.itemName,
    qty: l.qty,
    unitLabel: l.unitLabel,
    unitPrice: l.unitPrice,
    amount: l.amount,
    taxRate: l.taxRate,
  }));

  // 請求日（＝制作日）＝作成した当日（JST）。出力し直しでも安定させるためスナップショット。
  const issueDate = jstTodayDate();
  // 支払期限＝翌月の Client.paymentDay（末日 or 指定日）。取引先設定から確定。
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { paymentDay: true },
  });
  const dueDate = computeDueDate(yearMonth, client?.paymentDay ?? null);

  const existing = await prisma.invoice.findUnique({
    where: { clientId_yearMonth: { clientId, yearMonth } },
  });

  // 新規で明細ゼロ（請求対象が無い）の請求書は作らない。理由は呼び出し側で表示する。
  if (!existing && lines.length === 0) {
    throw new Error("EMPTY_INVOICE");
  }

  if (existing) {
    // 明細を作り直す（発行前の下書き更新を想定）。
    await prisma.invoiceLine.deleteMany({ where: { invoiceId: existing.id } });
    await prisma.invoice.update({
      where: { id: existing.id },
      data: { issueDate, dueDate, lines: { create: lineCreate } },
    });
    return { id: existing.id, invoiceNo: existing.invoiceNo };
  }

  // 新規作成。請求書番号(count+1)は採番→作成が非アトミックなため、unique 競合(P2002)
  // 時は番号を採り直して数回リトライ。同時生成・過去請求の削除後でも番号衝突でクラッシュしない。
  for (let attempt = 0; attempt < 5; attempt++) {
    const invoiceNo = await nextInvoiceNo(yearMonth, attempt);
    try {
      const created = await prisma.invoice.create({
        data: {
          clientId,
          yearMonth,
          invoiceNo,
          issueDate,
          dueDate,
          status: "DRAFT",
          lines: { create: lineCreate },
        },
      });
      return { id: created.id, invoiceNo: created.invoiceNo };
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e;
      // clientId+yearMonth の同時生成競合なら、出来上がった既存を返す。
      const raced = await prisma.invoice.findUnique({
        where: { clientId_yearMonth: { clientId, yearMonth } },
        select: { id: true, invoiceNo: true },
      });
      if (raced) return raced;
      // それ以外（invoiceNo の衝突）は番号を採り直して次の試行へ。
    }
  }
  throw new Error(
    "請求書番号の採番に繰り返し失敗しました。時間をおいて再試行してください。",
  );
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

  const fmtDate = (d: Date) =>
    `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(
      2,
      "0",
    )}/${String(d.getUTCDate()).padStart(2, "0")}`;
  const issueDateStr = fmtDate(invoice.issueDate); // 請求日（＝制作日）
  // 支払期限。旧データ（dueDate=null）は従来どおり issueDate（＝月末）へフォールバック。
  const dueDateStr = invoice.dueDate ? fmtDate(invoice.dueDate) : issueDateStr;

  return {
    invoiceNo: invoice.invoiceNo,
    issueDate: issueDateStr,
    dueDate: dueDateStr,
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

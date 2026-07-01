// ============================================================
// 集計 → 請求書明細 → CSV/xlsx
// v1 GAS（line-daily-report/invoice_doc.js）の請求書テンプレに準拠して移植。
//
// テンプレ（REQUIREMENTS.md §10 / writeInvoiceTab_）:
//   請求書番号 / 請求日（末締め）
//   発行元（InvoiceSetting）: 名 / 住所 / TEL・Email / 登録番号 / 担当
//   宛先: {取引先} 御中 / 住所（Client）
//   明細: No | 品目・内容 | 数量 | 単位 | 単価 | 金額 | 税率
//     常用: 「{現場} 常用」数量=人工 単価=RateCard 金額=数量×単価
//     残業: 「{現場} 残業」数量=h 単価=round(単価/8×1.25)
//     請負: 「請負工事一式」 / 立替経費（対象外・税率0）
//   小計（税抜）→ 消費税 → 対象外 → 合計（税込）→ お支払期限
//   お振込先 / 備考
//
// GASは「単価=入力セル＋金額=数式」の編集可能スプレッドシートを作るが、
// アプリ側は確定スナップショット（amount を計算済みで埋める）として出力する。
// 金額計算は calc.ts に一元化（丸めも Math.round で統一）。
// ============================================================

import ExcelJS from "exceljs";
import { INVOICE_TEMPLATE_B64 } from "./invoiceTemplateB64.js";
import {
  joyoAmount,
  overtimeUnit,
  overtimeLineAmount,
  resolveOvertimeUnit,
  overtimeLineAmountResolved,
} from "./calc.js";

/** 請求書明細1行（Prisma model InvoiceLine と一致）。 */
export interface InvoiceLine {
  sortNo: number;
  itemName: string;
  qty: number;
  unitLabel: string;
  unitPrice: number;
  amount: number;
  taxRate: number;
}

/** 現場ごとの集計（人工・残業）。 */
export interface SiteAgg {
  manDays: number;
  otHours: number;
}

/** 名前付きの請負（UKEOI）契約 1 件（LumpContract 相当）。 */
export interface LumpItem {
  name: string;
  amount: number;
}

/** 取引先ごとの集計（現場別 ＋ 請負 ＋ 立替経費）。 */
export interface ClientAgg {
  sites: Record<string, SiteAgg>;
  /** 請負金額の合算（名前付き明細を使わない場合のフォールバック）。 */
  lump: number;
  expense: number;
  /**
   * 名前付き請負契約（LumpContract）。指定があれば各件を個別明細
   * 「{name} 一式」として出力し、集約 `lump` は無視する。
   */
  lumpItems?: LumpItem[];
}

/** 集計の入力レコード（1出面相当）。 */
export interface ReportLike {
  client: string;
  site: string;
  manDays: number;
  otHours: number;
  contractType: "JOYO" | "UKEOI";
  lump?: number;
  expense?: number;
}

/** 経費（立替）を種別ごとに集計した1件。 */
export interface ExpenseAgg {
  kind: string;
  amount: number;
}

/**
 * 取引先ごとの請求集計（現場の内訳は持たない）。
 *   manDays … その月の合計人工、otHours … 合計残業時間、
 *   expenses … 請求対象の立替経費（種別ごと合算）、lumpItems … 請負（一式）。
 *   ukeoiAmounts … v3 請負(UKEOI) Report の契約金額。Report ごとに 1 行
 *     「○月委託料 数量1 単位=式 単価=金額」で計上する（品目名は常用と共通）。
 *     旧 LumpContract（lumpItems）とは別系統で、双方を並べても二重計上しない
 *     （データソースが Report.contractAmount と LumpContract で分かれている）。
 */
export interface ClientTotals {
  manDays: number;
  otHours: number;
  expenses: ExpenseAgg[];
  lumpItems?: LumpItem[];
  ukeoiAmounts?: number[];
}

/** 発行元情報（Prisma model InvoiceSetting 相当）。 */
export interface InvoiceSettingLike {
  issuerName: string;
  address?: string;
  tel?: string;
  email?: string;
  regNumber?: string;
  bankInfo?: string;
  taxRate?: number;
  contactName?: string;
}

/** 請求書サマリ（小計・消費税・対象外・合計）。 */
export interface InvoiceSummary {
  subtotal: number;
  tax: number;
  exempt: number;
  total: number;
}

const toNumber = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
};

const DEFAULT_SITE = "(現場未設定)";

// ============================================================
// 集計: 取引先 → 現場ごとの人工・残業 ＋ 請負 ＋ 立替経費
// 常用（JOYO）のみ現場別に人工/残業を積む。請負（UKEOI）は lump、立替は expense。
// ============================================================
export function aggregateForInvoice(
  reports: ReportLike[],
): Record<string, ClientAgg> {
  const out: Record<string, ClientAgg> = {};
  const ensure = (c: string): ClientAgg =>
    out[c] || (out[c] = { sites: {}, lump: 0, expense: 0 });

  for (const r of reports || []) {
    const client = String(r.client ?? "").trim();
    if (!client) continue;
    const agg = ensure(client);

    if (r.contractType === "JOYO") {
      const site = String(r.site ?? "").trim() || DEFAULT_SITE;
      const s = agg.sites[site] || (agg.sites[site] = { manDays: 0, otHours: 0 });
      s.manDays += toNumber(r.manDays, 0);
      s.otHours += toNumber(r.otHours, 0);
    }

    // 請負契約金額（UKEOI）・立替経費は契約種別に依らず取引先に積む。
    agg.lump += toNumber(r.lump, 0);
    agg.expense += toNumber(r.expense, 0);
  }

  return out;
}

// ============================================================
// 1取引先ぶんの明細（常用 / 残業 / 請負 / 立替経費）
// ============================================================
export function buildInvoiceLines(
  agg: ClientAgg,
  opts: { rateFor: (site: string) => number | null; taxRate: number },
): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  const taxRate = opts.taxRate;
  let sortNo = 0;

  for (const site of Object.keys(agg.sites).sort()) {
    const s = agg.sites[site];
    const md = toNumber(s.manDays, 0);
    if (md <= 0) continue;
    const unit = opts.rateFor(site) || 0;

    // 常用
    lines.push({
      sortNo: ++sortNo,
      itemName: `${site} 常用`,
      qty: md,
      unitLabel: "人工",
      unitPrice: unit,
      amount: joyoAmount(md, unit),
      taxRate,
    });

    // 残業（otHours>0 のみ）。金額＝round(表示残業単価 × 時間)で「単価×数量＝金額」を一致させる。
    const ot = toNumber(s.otHours, 0);
    if (ot > 0) {
      lines.push({
        sortNo: ++sortNo,
        itemName: `${site} 残業`,
        qty: ot,
        unitLabel: "時間",
        unitPrice: overtimeUnit(unit),
        amount: overtimeLineAmount(ot, unit),
        taxRate,
      });
    }
  }

  // 請負（UKEOI）
  //   - lumpItems があれば各契約を個別明細「{案件} 一式」として出力。
  //   - 無ければ集約 lump をまとめて「請負工事一式」1 行で出力（後方互換）。
  if (agg.lumpItems && agg.lumpItems.length > 0) {
    for (const item of agg.lumpItems) {
      const amt = toNumber(item.amount, 0);
      if (amt <= 0) continue;
      const label = String(item.name ?? "").trim();
      lines.push({
        sortNo: ++sortNo,
        itemName: label ? `${label} 一式` : "請負工事一式",
        qty: 1,
        unitLabel: "式",
        unitPrice: amt,
        amount: amt,
        taxRate,
      });
    }
  } else {
    const lump = toNumber(agg.lump, 0);
    if (lump > 0) {
      lines.push({
        sortNo: ++sortNo,
        itemName: "請負工事一式",
        qty: 1,
        unitLabel: "式",
        unitPrice: lump,
        amount: lump,
        taxRate,
      });
    }
  }

  // 立替経費（対象外・税率0）
  const expense = toNumber(agg.expense, 0);
  if (expense > 0) {
    lines.push({
      sortNo: ++sortNo,
      itemName: "立替経費（駐車/燃料等）",
      qty: 1,
      unitLabel: "式",
      unitPrice: expense,
      amount: expense,
      taxRate: 0,
    });
  }

  return lines;
}

// ============================================================
// 取引先ごとの明細（委託料 ＋ 残業 ＋ 請負 ＋ 立替経費）
//   現場の内訳は出さない。委託料＝合計人工×単価、残業＝合計時間×残業単価
//   （単価÷8×1.25）。経費は種別ごとに対象外（税率0）で計上。
//   単価は管理者がマスタに入れた値（RateCard）。金額・合計は全て自動計算。
// ============================================================
export function buildClientLines(
  totals: ClientTotals,
  opts: {
    unitPrice: number;
    taxRate: number;
    joyoItemName?: string;
    /** 残業の時間単価（円/時）。未指定なら 人工単価÷8×1.25 を自動採用。 */
    otUnitPrice?: number | null;
  },
): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  const { unitPrice, taxRate, otUnitPrice } = opts;
  // 委託料の品目名（既定「委託料」。請求書では「○月委託料」を渡す）。
  const joyoItemName = (opts.joyoItemName ?? "委託料").trim() || "委託料";
  let sortNo = 0;

  // 委託料（常用の人工合計 × 単価）
  const md = toNumber(totals.manDays, 0);
  if (md > 0) {
    lines.push({
      sortNo: ++sortNo,
      itemName: joyoItemName,
      qty: md,
      unitLabel: "人工",
      unitPrice,
      amount: joyoAmount(md, unitPrice),
      taxRate,
    });
  }

  // 残業（合計時間 × 残業単価＝単価÷8×1.25）。
  // 金額＝round(表示残業単価 × 時間)。帳票上「単価×数量＝金額」が一致する（検算に強い）。
  const ot = toNumber(totals.otHours, 0);
  if (ot > 0) {
    lines.push({
      sortNo: ++sortNo,
      itemName: "残業",
      qty: ot,
      unitLabel: "時間",
      unitPrice: resolveOvertimeUnit(unitPrice, otUnitPrice),
      amount: overtimeLineAmountResolved(ot, unitPrice, otUnitPrice),
      taxRate,
    });
  }

  // 請負（UKEOI・v3）。Report.contractAmount を案件ごとに 1 行で計上。
  // 品目名は常用と共通の「○月委託料」、数量1・単位=式・単価=金額・税率=既定。
  for (const amount of totals.ukeoiAmounts ?? []) {
    const amt = toNumber(amount, 0);
    if (amt <= 0) continue;
    lines.push({
      sortNo: ++sortNo,
      itemName: joyoItemName,
      qty: 1,
      unitLabel: "式",
      unitPrice: amt,
      amount: amt,
      taxRate,
    });
  }

  // 請負（一式）。LumpContract があれば案件ごとに計上（過去分維持）。
  for (const item of totals.lumpItems ?? []) {
    const amt = toNumber(item.amount, 0);
    if (amt <= 0) continue;
    const label = String(item.name ?? "").trim();
    lines.push({
      sortNo: ++sortNo,
      itemName: label ? `${label} 一式` : "請負工事一式",
      qty: 1,
      unitLabel: "式",
      unitPrice: amt,
      amount: amt,
      taxRate,
    });
  }

  // 立替経費（対象外・税率0）。種別ごとに集計済み。
  for (const e of totals.expenses ?? []) {
    const amt = toNumber(e.amount, 0);
    if (amt <= 0) continue;
    const kind = String(e.kind ?? "").trim() || "立替";
    lines.push({
      sortNo: ++sortNo,
      itemName: `立替 ${kind}`,
      qty: 1,
      unitLabel: "式",
      unitPrice: amt,
      amount: amt,
      taxRate: 0,
    });
  }

  return lines;
}

// ============================================================
// 取引先ごとの請求明細（v4: 日勤/夜勤分離 ＋ 請求方式 集約/現場ごと）
//   ・日勤(DAY)＋半日(HALF) は unitPrice、夜勤(NIGHT) は nightUnitPrice で別行。
//   ・AGGREGATE: 「○年○月委託料（日勤）」「○年○月委託料（夜勤）」＋「残業代」を合算1行ずつ。
//   ・PER_SITE : 現場名ごとに1行（日勤）＋「現場名 夜勤」別行 ＋「残業代」(合算)。
//   ・請負(UKEOI/一式)・立替経費は両モード共通で末尾に積む。
//   金額は calc.ts（joyoAmount / overtime*）に一元化。丸めは Math.round。
// ============================================================

/** "2026-06" → "2026年6月"（不正なら空文字）。 */
function monthLabel(yearMonth?: string): string {
  if (yearMonth && /^\d{4}-\d{2}$/.test(yearMonth)) {
    const [y, m] = yearMonth.split("-");
    return `${y}年${parseInt(m, 10)}月`;
  }
  return "";
}

/** 現場ごとの人工（日勤＝DAY+HALF / 夜勤＝NIGHT）。 */
export interface SiteWork {
  site: string;
  dayManDays: number;
  nightManDays: number;
}

export interface BillingInput {
  billingMode: "AGGREGATE" | "PER_SITE";
  yearMonth?: string;
  /** 日勤の人工単価（円/人工）。 */
  unitPrice: number;
  /** 夜勤の人工単価（円/人工）。0/未設定なら日勤単価を流用。 */
  nightUnitPrice: number;
  /** 残業の時間単価（円/時）。未設定なら 日勤単価÷8×1.25 を自動採用。 */
  otUnitPrice?: number | null;
  /** 残業合計（時間）。両モードとも「残業代」1行に合算。 */
  otHours: number;
  /** 現場ごとの人工。 */
  sites: SiteWork[];
  /** 請負(UKEOI)契約金額（案件ごと）。 */
  ukeoiAmounts?: number[];
  /** 請負(一式)契約（LumpContract）。 */
  lumpItems?: LumpItem[];
  /** 立替経費（対象外・税率0）。 */
  expenses?: ExpenseAgg[];
}

export function buildBillingLines(
  input: BillingInput,
  taxRate: number,
): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  let sortNo = 0;
  const ml = monthLabel(input.yearMonth);
  const dayUnit = toNumber(input.unitPrice, 0);
  const nightUnit =
    toNumber(input.nightUnitPrice, 0) > 0
      ? toNumber(input.nightUnitPrice, 0)
      : dayUnit;

  if (input.billingMode === "PER_SITE") {
    // 現場名で安定ソート。日勤行 → 夜勤行 の順に並べる（PDFの体裁）。
    const sites = [...input.sites].sort((a, b) =>
      a.site.localeCompare(b.site, "ja"),
    );
    for (const s of sites) {
      const md = toNumber(s.dayManDays, 0);
      if (md > 0) {
        lines.push({
          sortNo: ++sortNo,
          itemName: s.site,
          qty: md,
          unitLabel: "人工",
          unitPrice: dayUnit,
          amount: joyoAmount(md, dayUnit),
          taxRate,
        });
      }
    }
    for (const s of sites) {
      const md = toNumber(s.nightManDays, 0);
      if (md > 0) {
        lines.push({
          sortNo: ++sortNo,
          itemName: `${s.site} 夜勤`,
          qty: md,
          unitLabel: "人工",
          unitPrice: nightUnit,
          amount: joyoAmount(md, nightUnit),
          taxRate,
        });
      }
    }
  } else {
    // 集約: 日勤・夜勤を取引先全体で合算し、それぞれ1行。
    const dayMd = input.sites.reduce((a, s) => a + toNumber(s.dayManDays, 0), 0);
    const nightMd = input.sites.reduce(
      (a, s) => a + toNumber(s.nightManDays, 0),
      0,
    );
    if (dayMd > 0) {
      lines.push({
        sortNo: ++sortNo,
        itemName: `${ml}委託料（日勤）`,
        qty: dayMd,
        unitLabel: "人工",
        unitPrice: dayUnit,
        amount: joyoAmount(dayMd, dayUnit),
        taxRate,
      });
    }
    if (nightMd > 0) {
      lines.push({
        sortNo: ++sortNo,
        itemName: `${ml}委託料（夜勤）`,
        qty: nightMd,
        unitLabel: "人工",
        unitPrice: nightUnit,
        amount: joyoAmount(nightMd, nightUnit),
        taxRate,
      });
    }
  }

  // 残業代（両モード共通・合算1行）。残業単価は日勤単価を基準に自動／明示。
  const ot = toNumber(input.otHours, 0);
  if (ot > 0) {
    lines.push({
      sortNo: ++sortNo,
      itemName: "残業代",
      qty: ot,
      unitLabel: "時間",
      unitPrice: resolveOvertimeUnit(dayUnit, input.otUnitPrice),
      amount: overtimeLineAmountResolved(ot, dayUnit, input.otUnitPrice),
      taxRate,
    });
  }

  // 請負(UKEOI)：案件ごと1行（委託料と共通の品目名）。
  for (const amount of input.ukeoiAmounts ?? []) {
    const amt = toNumber(amount, 0);
    if (amt <= 0) continue;
    lines.push({
      sortNo: ++sortNo,
      itemName: `${ml}委託料`,
      qty: 1,
      unitLabel: "式",
      unitPrice: amt,
      amount: amt,
      taxRate,
    });
  }

  // 請負(一式)：LumpContract（過去分維持）。
  for (const item of input.lumpItems ?? []) {
    const amt = toNumber(item.amount, 0);
    if (amt <= 0) continue;
    const label = String(item.name ?? "").trim();
    lines.push({
      sortNo: ++sortNo,
      itemName: label ? `${label} 一式` : "請負工事一式",
      qty: 1,
      unitLabel: "式",
      unitPrice: amt,
      amount: amt,
      taxRate,
    });
  }

  // 立替経費（対象外・税率0）。
  for (const e of input.expenses ?? []) {
    const amt = toNumber(e.amount, 0);
    if (amt <= 0) continue;
    const kind = String(e.kind ?? "").trim() || "立替";
    lines.push({
      sortNo: ++sortNo,
      itemName: `立替 ${kind}`,
      qty: 1,
      unitLabel: "式",
      unitPrice: amt,
      amount: amt,
      taxRate: 0,
    });
  }

  return lines;
}

// ============================================================
// サマリ: 小計（課税）/ 消費税 / 対象外 / 合計
// ============================================================
export function summarize(
  lines: InvoiceLine[],
  taxRate: number,
): InvoiceSummary {
  let subtotal = 0;
  let exempt = 0;
  for (const l of lines || []) {
    if (l.taxRate > 0) subtotal += l.amount;
    else exempt += l.amount;
  }
  const tax = Math.round(subtotal * taxRate);
  return { subtotal, tax, exempt, total: subtotal + tax + exempt };
}

// ============================================================
// CSV（明細フラット・会計/freee取込用）
// ヘッダ行: No,品目・内容,数量,単位,単価,金額,税率
// ============================================================
const csvCell = (v: unknown): string => {
  let s = String(v ?? "");
  // CSV インジェクション対策: =, +, -, @, タブ, CR で始まるセルは Excel/会計ソフトで
  // 数式として評価されうる。先頭に ' を付けて無害化（取引先名・経費種別・案件名は自由入力）。
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const taxLabel = (rate: number): string =>
  rate > 0 ? `${Math.round(rate * 100)}%` : "対象外";

export function toCSV(
  header: { invoiceNo: string; issueDate: string; client: string },
  lines: InvoiceLine[],
): string {
  const rows: string[] = [];
  // 請求書メタ（取込側で無視できるよう # プレフィックス）
  rows.push(["# 請求書番号", header.invoiceNo].map(csvCell).join(","));
  rows.push(["# 請求日", header.issueDate].map(csvCell).join(","));
  rows.push(["# 宛先", header.client].map(csvCell).join(","));
  // 明細ヘッダ
  rows.push(["No", "品目・内容", "数量", "単位", "単価", "金額", "税率"].join(","));
  for (const l of lines || []) {
    rows.push(
      [
        l.sortNo,
        l.itemName,
        l.qty,
        l.unitLabel,
        l.unitPrice,
        l.amount,
        taxLabel(l.taxRate),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return rows.join("\r\n") + "\r\n";
}

// ============================================================
// xlsx（ユーザー提供テンプレ template_013 準拠）
//   空テンプレ（invoiceTemplateB64・個人情報除去済み）を読み込み、
//   発行元・宛先・振込先・明細・合計を DB から注入して返す。
//   罫線/結合/列幅/書式/青タイトルはテンプレのまま維持する。
//   明細: B=品目 / J=数量 / K=単価 / M=金額（18〜48行）。
//   合計: I50=小計(税抜) / K50=消費税 / M50=合計(税込) / L49=税率% / B49=支払期限。
// ============================================================
export async function toXlsx(data: {
  invoiceNo: string;
  issueDate: string;
  yearMonth?: string;
  client: string;
  honorific?: string;
  address?: string;
  issuer?: Partial<InvoiceSettingLike>;
  lines: InvoiceLine[];
  taxRate: number;
}): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const tpl = Buffer.from(INVOICE_TEMPLATE_B64, "base64");
  await wb.xlsx.load(tpl as unknown as ExcelJS.Buffer);
  const ws = wb.worksheets[0] ?? wb.addWorksheet("請求書");

  const issuer = data.issuer || {};
  const lines = data.lines || [];
  const subtotal = lines
    .filter((l) => l.taxRate > 0)
    .reduce((a, l) => a + l.amount, 0);
  const exempt = lines
    .filter((l) => l.taxRate === 0)
    .reduce((a, l) => a + l.amount, 0);
  const tax = Math.round(subtotal * (data.taxRate || 0.1));
  const total = subtotal + tax + exempt;
  const taxPct = Math.round((data.taxRate || 0.1) * 100);

  const put = (addr: string, v: ExcelJS.CellValue) => {
    ws.getCell(addr).value = v;
  };

  // ── ヘッダー（発行元・宛先・振込先） ──
  put("O1", data.issueDate); // 請求日
  put("B6", `${data.client}　${data.honorific || "様"}`); // 宛先
  put("B8", data.address ?? ""); // 宛先住所
  const tel = String(issuer.tel ?? "").trim();
  put("K8", tel ? `☎ ${tel}` : ""); // 発行元TEL
  put("K6", issuer.bankInfo ? String(issuer.bankInfo) : ""); // 振込先
  put("F11", total); // ご請求金額（税込）

  // ── 明細（18〜48行：品目B / 数量J / 単価K / 金額M）──
  //   明細数が枠(31行)を超える分は表示から溢れるが、合計は全明細で計算済み。
  const FIRST = 18;
  const LAST = 48;
  const slots = LAST - FIRST + 1;
  for (let i = 0; i < slots; i++) {
    const r = FIRST + i;
    const l = lines[i];
    put(`B${r}`, l ? l.itemName : null);
    put(`J${r}`, l ? l.qty : null);
    put(`K${r}`, l ? l.unitPrice : null);
    put(`M${r}`, l ? l.amount : null);
  }

  // ── 合計・支払期限 ──
  put("B49", data.issueDate); // 支払期限（末締め）
  put("L49", taxPct); // 税率(%)
  put("I50", subtotal); // 小計（税抜）
  put("K50", tax); // 消費税
  put("M50", total); // 合計（税込）

  return wb;
}

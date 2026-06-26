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
import { joyoAmount, overtimeAmount, HOURS_PER_DAY, OT_FACTOR } from "./calc.js";

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

    // 残業（otHours>0 のみ）
    const ot = toNumber(s.otHours, 0);
    if (ot > 0) {
      const otUnit = Math.round((unit / HOURS_PER_DAY) * OT_FACTOR);
      lines.push({
        sortNo: ++sortNo,
        itemName: `${site} 残業`,
        qty: ot,
        unitLabel: "時間",
        unitPrice: otUnit,
        amount: overtimeAmount(ot, unit),
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
  const s = String(v ?? "");
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
// xlsx（テンプレ体裁）— exceljs Workbook を返す（caller が buffer 化）
// ============================================================
export function toXlsx(data: {
  invoiceNo: string;
  issueDate: string;
  client: string;
  address?: string;
  issuer?: Partial<InvoiceSettingLike>;
  lines: InvoiceLine[];
  taxRate: number;
}): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = data.issuer?.issuerName || "請求書";
  wb.created = new Date();
  const ws = wb.addWorksheet("請求書");

  // 7列（No | 品目・内容 | 数量 | 単位 | 単価 | 金額 | 税率）
  ws.columns = [
    { width: 6 },
    { width: 32 },
    { width: 10 },
    { width: 8 },
    { width: 12 },
    { width: 14 },
    { width: 10 },
  ];

  const issuer = data.issuer || {};
  const pct = Math.round((data.taxRate || 0) * 100);

  const addRow = (cells: Array<string | number>): ExcelJS.Row =>
    ws.addRow(cells);

  // ── ヘッダ ──
  const title = addRow(["請求書"]);
  title.getCell(1).font = { bold: true, size: 16 };
  addRow(["請求書番号", data.invoiceNo, "", "", "請求日", data.issueDate]);
  addRow([]);

  // ── 発行元（InvoiceSetting）──
  if (String(issuer.issuerName ?? "").trim()) addRow([String(issuer.issuerName)]);
  if (String(issuer.address ?? "").trim()) addRow([String(issuer.address)]);
  {
    const tel = String(issuer.tel ?? "").trim();
    const mail = String(issuer.email ?? "").trim();
    const ln = [tel ? "TEL: " + tel : "", mail ? "Email: " + mail : ""]
      .filter(Boolean)
      .join("　");
    if (ln) addRow([ln]);
  }
  if (String(issuer.regNumber ?? "").trim())
    addRow(["登録番号　" + String(issuer.regNumber)]);
  if (String(issuer.contactName ?? "").trim())
    addRow(["担当：" + String(issuer.contactName)]);
  addRow([]);

  // ── 宛先（Client）──
  const to = addRow([data.client + "　御中"]);
  to.getCell(1).font = { bold: true, size: 12 };
  if (String(data.address ?? "").trim()) addRow([String(data.address)]);
  addRow([]);

  // ── 明細ヘッダ ──
  const head = addRow(["No", "品目・内容", "数量", "単位", "単価", "金額", "税率"]);
  head.font = { bold: true };
  head.eachCell((cell) => {
    cell.border = { bottom: { style: "thin" } };
  });

  // ── 明細 ──
  for (const l of data.lines || []) {
    const r = addRow([
      l.sortNo,
      l.itemName,
      l.qty,
      l.unitLabel,
      l.unitPrice,
      l.amount,
      taxLabel(l.taxRate),
    ]);
    r.getCell(5).numFmt = "#,##0";
    r.getCell(6).numFmt = "#,##0";
  }

  const summary = summarize(data.lines || [], data.taxRate);

  // ── サマリ（小計 → 消費税 → 対象外 → 合計 → 支払期限）──
  addRow([]);
  const subRow = addRow(["", "", "", "", "小計（税抜）", summary.subtotal]);
  subRow.getCell(6).numFmt = "#,##0";
  const taxRow = addRow(["", "", "", "", `消費税（${pct}%）`, summary.tax]);
  taxRow.getCell(6).numFmt = "#,##0";
  if (summary.exempt > 0) {
    const exeRow = addRow(["", "", "", "", "対象外（立替）", summary.exempt]);
    exeRow.getCell(6).numFmt = "#,##0";
  }
  const totalRow = addRow(["", "", "", "", "合計（税込）", summary.total]);
  totalRow.getCell(5).font = { bold: true };
  totalRow.getCell(6).font = { bold: true };
  totalRow.getCell(6).numFmt = "#,##0";
  addRow(["", "", "", "", "お支払期限", data.issueDate]);

  // ── フッタ ──
  addRow([]);
  if (String(issuer.bankInfo ?? "").trim())
    addRow(["お振込先　" + String(issuer.bankInfo)]);
  addRow(["備考　※お振込手数料は御社にてご負担をお願いいたします。"]);

  ws.views = [{ state: "frozen", ySplit: 1 }];
  return wb;
}

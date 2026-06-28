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
import { joyoAmount, overtimeUnit, overtimeLineAmount } from "./calc.js";

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
  opts: { unitPrice: number; taxRate: number; joyoItemName?: string },
): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  const { unitPrice, taxRate } = opts;
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
      unitPrice: overtimeUnit(unitPrice),
      amount: overtimeLineAmount(ot, unitPrice),
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
// xlsx（指定テンプレ準拠）— exceljs Workbook を返す（caller が buffer 化）
//
//   ユーザー提供の請求書テンプレ（Googleスプレッドシート由来）の体裁を、
//   セル配置・結合・数式まで忠実に再現する。発行元名・住所・登録番号・振込先・
//   宛先（取引先）は実行時に DB（InvoiceSetting / Client）から埋めるため、
//   個人情報（口座・実名・住所）はコードに焼かない（公開リポジトリ対策）。
//
//   金額・小計・消費税・合計・税率別内訳は「数式」で持たせる（＝Excelで単価/数量を
//   直せば自動再計算）。同時に計算済みの cached result も入れるので、再計算なしの
//   閲覧でも正しい数字が出る。明細の金額 F = 数量(C) × 単価(E)。
// ============================================================
export function toXlsx(data: {
  invoiceNo: string;
  issueDate: string;
  yearMonth?: string;
  client: string;
  honorific?: string;
  address?: string;
  issuer?: Partial<InvoiceSettingLike>;
  lines: InvoiceLine[];
  taxRate: number;
}): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = data.issuer?.issuerName || "請求書";
  wb.created = new Date();
  const ws = wb.addWorksheet("請求書");

  // 列幅（テンプレ準拠）: A=No, B=品目, C=数量, D=単位, E=単価, F=金額, G=税率
  ws.columns = [
    { width: 5 },
    { width: 34 },
    { width: 8 },
    { width: 7 },
    { width: 14 },
    { width: 15 },
    { width: 8 },
  ];

  const issuer = data.issuer || {};
  const MONEY = '¥#,##0;"-¥"#,##0;""';

  type CellOpts = {
    font?: Partial<ExcelJS.Font>;
    align?: Partial<ExcelJS.Alignment>;
    numFmt?: string;
  };
  const set = (addr: string, value: ExcelJS.CellValue, opts: CellOpts = {}) => {
    const c = ws.getCell(addr);
    c.value = value;
    if (opts.font) c.font = opts.font;
    if (opts.align) c.alignment = opts.align;
    if (opts.numFmt) c.numFmt = opts.numFmt;
    return c;
  };
  const RIGHT = { horizontal: "right" as const };
  const CENTER = { horizontal: "center" as const };

  // ── 行アンカー（明細は最低15行。テンプレと同じ見た目／件数が多ければ伸ばす）──
  const lines = data.lines || [];
  const itemRows = Math.max(15, lines.length);
  const FIRST = 20;
  const LAST = FIRST + itemRows - 1;
  const R_SUB = LAST + 2;
  const R_TAX = R_SUB + 1;
  const R_TOTAL = R_SUB + 2;
  const R_BRKHEAD = R_SUB + 4;
  const R_BRKLBL = R_SUB + 5;
  const R_BRK10 = R_SUB + 6;
  const R_BRK8 = R_SUB + 7;
  const R_BANK = R_SUB + 9;
  const R_NOTELBL = R_SUB + 12;
  const R_NOTE = R_SUB + 13;

  // ── 計算済み（cached result。再計算なしでも数字が出るように）──
  const lineAmt = (l: InvoiceLine) => l.qty * l.unitPrice;
  const subtotalAll = lines.reduce((a, l) => a + lineAmt(l), 0);
  const base10 = lines.filter((l) => l.taxRate === 0.1).reduce((a, l) => a + lineAmt(l), 0);
  const base8 = lines.filter((l) => l.taxRate === 0.08).reduce((a, l) => a + lineAmt(l), 0);
  const tax10 = Math.floor(base10 * 0.1);
  const tax8 = Math.floor(base8 * 0.08);
  const total = subtotalAll + tax10 + tax8;

  // ── タイトル ──
  ws.mergeCells("A2:G2");
  set("A2", "請　求　書", {
    font: { bold: true, size: 18 },
    align: { horizontal: "center", vertical: "middle" },
  });
  ws.getRow(2).height = 36;

  // ── 請求書番号 / 請求日 ──
  set("E4", "請求書番号", { align: RIGHT });
  ws.mergeCells("F4:G4");
  set("F4", data.invoiceNo);
  set("E5", "請求日", { align: RIGHT });
  ws.mergeCells("F5:G5");
  set("F5", data.issueDate);

  // ── 宛先（取引先）／ 発行元（自社・DBから）──
  ws.mergeCells("A7:C7");
  set("A7", `${data.client}　${data.honorific || "御中"}`, {
    font: { bold: true, size: 13 },
  });
  ws.mergeCells("E7:G7");
  set("E7", String(issuer.issuerName ?? ""), { font: { bold: true } });
  ws.mergeCells("A8:C8");
  set("A8", String(data.address ?? ""));
  ws.mergeCells("E8:G8");
  set("E8", String(issuer.address ?? ""));
  ws.mergeCells("E9:G9");
  {
    const tel = String(issuer.tel ?? "").trim();
    const mail = String(issuer.email ?? "").trim();
    set("E9", [tel ? "TEL: " + tel : "", mail ? "Email: " + mail : ""].filter(Boolean).join("　"));
  }
  ws.mergeCells("E10:G10");
  set("E10", issuer.regNumber ? "登録番号　" + String(issuer.regNumber) : "");
  ws.mergeCells("E11:G11");
  set("E11", issuer.contactName ? "担当：" + String(issuer.contactName) : "");

  // ── 件名 / リード ──
  let subject = "件名：　フィールドスタッフ業務委託料";
  if (data.yearMonth && /^\d{4}-\d{2}$/.test(data.yearMonth)) {
    const [y, m] = data.yearMonth.split("-");
    subject = `件名：　${y}年${parseInt(m, 10)}月分　フィールドスタッフ業務委託料`;
  }
  ws.mergeCells("A13:G13");
  set("A13", subject, { font: { bold: true } });
  ws.mergeCells("A14:G14");
  set("A14", "下記のとおりご請求申し上げます。");

  // ── ご請求金額（税込）／ お支払期限（数式で合計・請求日を参照）──
  ws.mergeCells("A16:B16");
  set("A16", "ご請求金額（税込）", { font: { bold: true } });
  ws.mergeCells("C16:E16");
  set("C16", { formula: `F${R_TOTAL}`, result: total }, {
    font: { bold: true, size: 14 },
    numFmt: MONEY,
  });
  ws.mergeCells("A17:B17");
  set("A17", "お支払期限", { font: { bold: true } });
  ws.mergeCells("C17:E17");
  set("C17", { formula: "F5", result: data.issueDate });

  // ── 明細ヘッダ ──
  const heads = ["No", "品目・内容", "数量", "単位", "単価", "金額", "税率"];
  heads.forEach((h, i) => {
    const c = ws.getRow(19).getCell(i + 1);
    c.value = h;
    c.font = { bold: true };
    c.border = { bottom: { style: "thin" } };
    if (i >= 2) c.alignment = CENTER;
  });

  // ── 明細（A=No自動・F=数量×単価 を数式で。空行はテンプレ同様に枠だけ残す）──
  for (let i = 0; i < itemRows; i++) {
    const r = FIRST + i;
    const l = lines[i];
    set(`A${r}`, { formula: `IF(B${r}="","",ROW()-19)`, result: l ? l.sortNo : "" }, { align: CENTER });
    if (l) {
      set(`B${r}`, l.itemName);
      // 数量も3桁区切り（半日=0.5 等の小数は保持）。単価・金額は ¥#,##0 で区切り済み。
      set(`C${r}`, l.qty, { numFmt: "#,##0.##", align: RIGHT });
      set(`D${r}`, l.unitLabel, { align: CENTER });
      set(`E${r}`, l.unitPrice, { numFmt: "¥#,##0", align: RIGHT });
      set(`G${r}`, l.taxRate, { numFmt: "0%", align: CENTER });
    }
    set(
      `F${r}`,
      { formula: `IF(OR(C${r}="",E${r}=""),"",C${r}*E${r})`, result: l ? lineAmt(l) : "" },
      { numFmt: "¥#,##0", align: RIGHT },
    );
    ws.getRow(r).height = 15.75;
  }

  // ── 小計 / 消費税 / 合計（数式）──
  set(`E${R_SUB}`, "小計（税抜）", { align: RIGHT });
  set(`F${R_SUB}`, { formula: `SUM(F${FIRST}:F${LAST})`, result: subtotalAll }, { numFmt: MONEY, align: RIGHT });
  set(`E${R_TAX}`, "消費税", { align: RIGHT });
  set(`F${R_TAX}`, { formula: `E${R_BRK10}+E${R_BRK8}`, result: tax10 + tax8 }, { numFmt: MONEY, align: RIGHT });
  set(`E${R_TOTAL}`, "合計（税込）", { font: { bold: true }, align: RIGHT });
  set(`F${R_TOTAL}`, { formula: `F${R_SUB}+F${R_TAX}`, result: total }, { font: { bold: true }, numFmt: MONEY, align: RIGHT });

  // ── 税率別内訳（SUMIF。10%対象 / 8%対象軽減）──
  ws.mergeCells(`A${R_BRKHEAD}:G${R_BRKHEAD}`);
  set(`A${R_BRKHEAD}`, "【税率別内訳】", { font: { bold: true } });
  set(`B${R_BRKLBL}`, "税率", { font: { bold: true } });
  ws.mergeCells(`C${R_BRKLBL}:D${R_BRKLBL}`);
  set(`C${R_BRKLBL}`, "対象金額（税抜）", { font: { bold: true }, align: CENTER });
  ws.mergeCells(`E${R_BRKLBL}:F${R_BRKLBL}`);
  set(`E${R_BRKLBL}`, "消費税額", { font: { bold: true }, align: CENTER });
  set(`B${R_BRK10}`, "10% 対象");
  ws.mergeCells(`C${R_BRK10}:D${R_BRK10}`);
  set(`C${R_BRK10}`, { formula: `SUMIF(G${FIRST}:G${LAST},0.1,F${FIRST}:F${LAST})`, result: base10 }, { numFmt: MONEY, align: RIGHT });
  ws.mergeCells(`E${R_BRK10}:F${R_BRK10}`);
  set(`E${R_BRK10}`, { formula: `ROUNDDOWN(C${R_BRK10}*0.1,0)`, result: tax10 }, { numFmt: MONEY, align: RIGHT });
  set(`B${R_BRK8}`, "8% 対象（軽減）");
  ws.mergeCells(`C${R_BRK8}:D${R_BRK8}`);
  set(`C${R_BRK8}`, { formula: `SUMIF(G${FIRST}:G${LAST},0.08,F${FIRST}:F${LAST})`, result: base8 }, { numFmt: MONEY, align: RIGHT });
  ws.mergeCells(`E${R_BRK8}:F${R_BRK8}`);
  set(`E${R_BRK8}`, { formula: `ROUNDDOWN(C${R_BRK8}*0.08,0)`, result: tax8 }, { numFmt: MONEY, align: RIGHT });

  // ── 振込先（DBの bankInfo）／ 備考 ──
  ws.mergeCells(`A${R_BANK}:G${R_BANK}`);
  set(`A${R_BANK}`, issuer.bankInfo ? "【お振込先】　" + String(issuer.bankInfo) : "【お振込先】");
  set(`A${R_NOTELBL}`, "備考");
  ws.mergeCells(`A${R_NOTE}:G${R_NOTE}`);
  set(`A${R_NOTE}`, "※お振込手数料は御社にてご負担をお願いいたします。");

  return wb;
}

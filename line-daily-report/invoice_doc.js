// ============================================================
// 【ファイル6】請求書の自動作成（編集可能なスプレッドシート/xlsx）
// 請求サマリの元データから、取引先ごとにタブを分けた請求書ブックを生成する。
// ============================================================
// PDFではなく「編集可能なスプレッドシート」で出すのが狙い:
//   管理者が各タブの「単価(入力)」セルに現場ごとの単価を入れると、
//   金額・小計・消費税・合計が数式で自動計算される（xlsxとしてDLも可）。
// 月末締め（billing.js の finalizeBillingForMonth_）から自動で呼ばれる。
//
// 依存（他ファイルの既存グローバル）:
//   TZ / BILLING / CONFIG / HEADERS_DAILY_REPORT / HEADERS_LUMPSUM / HEADERS_EXPENSE /
//   readSheetObjects_ / ymFromDateCell_ / normalizeContractType / toNumber /
//   canonicalClient_ / clientMasterMap_ / lookupRate_ / prop_ / appendProcessLog_ /
//   ymForMonthOffset_
//
// 設定（「請求書設定」シートのキー＝値。setupInvoiceSheet で雛形作成）:
//   発行元名 / 発行元住所 / 発行元TEL / 登録番号 / 振込先 / 消費税率(0.10) /
//   保存フォルダID(空なら「請求書」フォルダを自動作成)
// ============================================================

const INVOICE = {
  sheetSettings:     "請求書設定",
  defaultTaxRate:    0.10,
  defaultFolderName: "請求書",
};

const HEADERS_INVOICE_SETTINGS = ["設定キー", "値", "説明"];

const INVOICE_SETTING_DEFAULTS = [
  ["発行元名",      "", "請求書に載せる自社名／屋号"],
  ["発行元住所",    "", "〒含む住所"],
  ["発行元TEL",     "", ""],
  ["発行元Email",   "", ""],
  ["担当者",        "", "請求書に載せる担当者名"],
  ["登録番号",      "", "インボイス制度の適格請求書発行事業者番号（T+13桁）"],
  ["振込先",        "", "例: ○○銀行 △△支店 普通 1234567 ﾔﾏﾀﾞﾀﾛｳ"],
  ["消費税率",      "0.10", "0.10=10%。単価が税込なら 0 を設定"],
  ["保存フォルダID", "", "空ならマイドライブに「請求書」フォルダを自動作成"],
];

// ============================================================
// セットアップ
// ============================================================

function setupInvoiceSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(INVOICE.sheetSettings);
  if (!sheet) sheet = ss.insertSheet(INVOICE.sheetSettings);

  const row1 = sheet.getRange(1, 1, 1, HEADERS_INVOICE_SETTINGS.length).getValues()[0];
  if (!row1.some((v) => String(v ?? "").trim())) {
    sheet.getRange(1, 1, 1, HEADERS_INVOICE_SETTINGS.length).setValues([HEADERS_INVOICE_SETTINGS]);
    sheet.setFrozenRows(1);
    sheet.getRange(2, 1, INVOICE_SETTING_DEFAULTS.length, 3).setValues(INVOICE_SETTING_DEFAULTS);
  }

  SpreadsheetApp.getUi().alert(
    "✅ 「請求書設定」シートを準備しました\n\n" +
    "発行元名・住所・振込先・登録番号 を入力してください。\n" +
    "保存フォルダIDは空でOK（自動で「請求書」フォルダに保存します）。\n\n" +
    "発行はメニュー『請求・経費』→『請求書(xlsx)を作成』。\n" +
    "各タブの「単価(入力)」に現場ごとの単価を入れると金額が自動計算されます。"
  );
}

function loadInvoiceSettings_() {
  const map = {};
  for (const r of readSheetObjects_(INVOICE.sheetSettings, HEADERS_INVOICE_SETTINGS)) {
    const key = String(r["設定キー"] ?? "").trim();
    if (key) map[key] = r["値"];
  }
  return map;
}

const invoiceMonthEnd_ = (ym) => {
  const m = String(ym).match(/^(\d{4})-(\d{2})$/);
  if (!m) return "";
  return Utilities.formatDate(new Date(Number(m[1]), Number(m[2]), 0), TZ, "yyyy/MM/dd");
};

// ============================================================
// 集計（請求書の元データ）: 取引先 → 現場ごとの人工・残業 ＋ 請負 ＋ 立替経費
// ============================================================

function aggregateForInvoice_(ym) {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const report = ss.getSheetByName(CONFIG.sheetReport);
  const out    = {};
  const ensure = (c) => out[c] || (out[c] = { sites: {}, lump: 0, expense: 0 });

  // 常用：作業日報を 取引先×現場 で集計
  if (report && report.getLastRow() >= 2) {
    const rows = report.getRange(2, 1, report.getLastRow() - 1, HEADERS_DAILY_REPORT.length).getValues();
    for (const r of rows) {
      if (!r[1] || ymFromDateCell_(r[1]) !== String(ym).trim()) continue;
      if (normalizeContractType(r[4], "常用") !== "常用") continue;
      const client = canonicalClient_(r[3]);
      if (!client) continue;
      const site = String(r[6] ?? "").trim() || "(現場未設定)";
      const sites = ensure(client).sites;
      const s = sites[site] || (sites[site] = { manDays: 0, otHours: 0 });
      s.manDays += toNumber(r[8], 0);
      s.otHours += toNumber(r[9], 0);
    }
  }

  // 請負：案件マスタの契約金額
  for (const r of readSheetObjects_(BILLING.sheetLumpSum, HEADERS_LUMPSUM)) {
    if (String(r["計上月"] ?? "").trim() !== String(ym).trim()) continue;
    const client = canonicalClient_(r["取引先"]);
    if (!client) continue;
    ensure(client).lump += toNumber(r["契約金額"], 0);
  }

  // 立替経費：請求対象のみ
  for (const e of readSheetObjects_(BILLING.sheetExpense, HEADERS_EXPENSE)) {
    if (!e["日付"] || ymFromDateCell_(e["日付"]) !== String(ym).trim()) continue;
    if (!String(e["請求対象"] ?? "").includes("請求")) continue;
    const client = canonicalClient_(e["取引先"]);
    if (!client) continue;
    ensure(client).expense += toNumber(e["金額"], 0);
  }

  return out;
}

// ============================================================
// 1取引先ぶんのタブを書き込む（単価=入力、金額/小計/税/合計=数式）
// ============================================================

function invoiceTabName_(client, i) {
  const n = String(client ?? "").replace(/[\[\]\*\/\\?:]/g, "").trim().slice(0, 90);
  return n || ("取引先" + (i + 1));
}

function writeInvoiceTab_(sheet, ym, client, data, settings, index) {
  const rawRate = settings["消費税率"];
  const taxRate = (rawRate === "" || rawRate == null) ? INVOICE.defaultTaxRate : Number(rawRate);
  const rate10  = isNaN(taxRate) ? 0 : taxRate;
  const pct     = Math.round(rate10 * 100);

  const cm        = (typeof clientMasterMap_ === "function") ? (clientMasterMap_()[client] || {}) : {};
  const addr      = String(cm["住所"] ?? "").trim();
  const invoiceNo = `${String(ym).slice(0, 4)}-${String(index + 1).padStart(3, "0")}`; // 例 2026-001
  const issueDate = invoiceMonthEnd_(ym); // 末締め：請求日＝支払期限（同日）

  // 明細は 7列: No | 品目・内容 | 数量 | 単位 | 単価(入力) | 金額 | 税率
  const COLS = 7;
  const vals = [];
  const row = (a, b, c, d, e, f, g) =>
    (vals.push([a ?? "", b ?? "", c ?? "", d ?? "", e ?? "", f ?? "", g ?? ""]), vals.length);

  // ── ヘッダ ──
  row("請求書");
  row("請求書番号", invoiceNo, "", "", "請求日", issueDate);
  row("");

  // ── 発行元（請求書設定シート）──
  if (String(settings["発行元名"] ?? "").trim())   row(String(settings["発行元名"]));
  if (String(settings["発行元住所"] ?? "").trim()) row(String(settings["発行元住所"]));
  {
    const tel  = String(settings["発行元TEL"] ?? "").trim();
    const mail = String(settings["発行元Email"] ?? "").trim();
    const ln   = [tel ? "TEL: " + tel : "", mail ? "Email: " + mail : ""].filter(Boolean).join("　");
    if (ln) row(ln);
  }
  if (String(settings["登録番号"] ?? "").trim()) row("登録番号　" + String(settings["登録番号"]));
  if (String(settings["担当者"] ?? "").trim())   row("担当：" + String(settings["担当者"]));
  row("");

  // ── 宛先（取引先マスタ）──
  row(client + "　御中");
  if (addr) row(addr);
  row("");

  // ── 明細（単価=入力、金額/小計/消費税/合計=数式で自動）──
  row("No", "品目・内容", "数量", "単位", "単価", "金額", "税率");
  let no = 0;
  const taxable = []; // 課税対象（常用/残業/請負）の金額セル行
  const exempt  = []; // 対象外（立替経費）の金額セル行
  for (const site of Object.keys(data.sites).sort()) {
    const s  = data.sites[site];
    const md = toNumber(s.manDays, 0);
    if (md <= 0) continue;
    const rate = (typeof lookupRate_ === "function") ? (lookupRate_(client, site, "常用", null) || {}) : {};
    const unit = rate.unit > 0 ? rate.unit : ""; // 取引先マスタからプリフィル（無ければ入力待ち）
    const rJoyo = vals.length + 1;
    row(++no, `${site}　常用`, md, "人工", unit, `=IF($E${rJoyo}="","",$C${rJoyo}*$E${rJoyo})`, `${pct}%`);
    taxable.push(rJoyo);
    const ot = toNumber(s.otHours, 0);
    if (ot > 0) {
      const rOt = vals.length + 1;
      // 残業単価＝常用単価 ÷ 8 × 1.25（常用行の単価入力から自動）
      row(++no, `${site}　残業`, ot, "時間", `=IF($E${rJoyo}="","",ROUND($E${rJoyo}/8*1.25,0))`,
          `=IF($E${rOt}="","",$C${rOt}*$E${rOt})`, `${pct}%`);
      taxable.push(rOt);
    }
  }
  if (toNumber(data.lump, 0) > 0) {
    const r = vals.length + 1;
    row(++no, "請負工事一式", 1, "式", data.lump, `=$C${r}*$E${r}`, `${pct}%`);
    taxable.push(r);
  }
  if (toNumber(data.expense, 0) > 0) {
    const r = vals.length + 1;
    row(++no, "立替経費（駐車/燃料等）", 1, "式", data.expense, `=$C${r}*$E${r}`, "対象外");
    exempt.push(r);
  }

  // ── サマリ（小計→消費税→合計→支払期限）──
  row("");
  const sumExpr = (arr) => (arr.length ? "=" + arr.map((r) => `F${r}`).join("+") : "=0");
  const rSub = row("", "", "", "", "小計（税抜）", sumExpr(taxable));
  const rTax = row("", "", "", "", `消費税（${pct}%）`, `=ROUND(F${rSub}*${rate10},0)`);
  let rExe = 0;
  if (exempt.length) rExe = row("", "", "", "", "対象外（立替）", sumExpr(exempt));
  row("", "", "", "", "合計（税込）",
      rExe ? `=F${rSub}+F${rTax}+F${rExe}` : `=F${rSub}+F${rTax}`);
  row("", "", "", "", "お支払期限", issueDate);

  // ── フッタ ──
  row("");
  if (String(settings["振込先"] ?? "").trim()) row("お振込先　" + String(settings["振込先"]));
  row("備考　※お振込手数料は御社にてご負担をお願いいたします。");

  sheet.getRange(1, 1, vals.length, COLS).setValues(vals);
  sheet.setFrozenRows(1);
}

// ============================================================
// 月のブックを作成（取引先ごとに1タブ）→ Drive保存
// ============================================================

function issueInvoiceBookForMonth_(ym) {
  const settings = loadInvoiceSettings_();
  const agg      = aggregateForInvoice_(ym);

  const clients = Object.keys(agg)
    .filter((c) => Object.keys(agg[c].sites).length > 0 || agg[c].lump > 0)
    .sort();

  if (clients.length === 0) {
    appendProcessLog_(new Date(), "", "", "", `[INVOICE_XLSX] ${ym}`, "INFO", "対象なし");
    return { count: 0, fileUrl: "" };
  }

  const book = SpreadsheetApp.create(`請求書_${ym}`);
  clients.forEach((client, i) => {
    const sheet = book.insertSheet(invoiceTabName_(client, i));
    writeInvoiceTab_(sheet, ym, client, agg[client], settings, i);
  });

  // 自動作成された既定シート（シート1）を削除
  const sheets = book.getSheets();
  if (sheets.length > clients.length) book.deleteSheet(sheets[0]);

  // 保存フォルダへ移動
  try {
    DriveApp.getFileById(book.getId()).moveTo(resolveInvoiceFolder_(settings));
  } catch (e) { /* 移動失敗時はマイドライブ直下に残る */ }

  appendProcessLog_(
    new Date(), "", "", "",
    `[INVOICE_XLSX] ${ym}`, "SUCCESS_INVOICE",
    `clients=${clients.length} book=${book.getId()}`
  );

  return { count: clients.length, fileUrl: book.getUrl() };
}

// 保存先フォルダを解決（設定 → スクリプトプロパティ → 「請求書」フォルダ自動作成）
function resolveInvoiceFolder_(settings) {
  const id = String(settings["保存フォルダID"] ?? "").trim() || prop_("INVOICE_FOLDER_ID");
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* フォールバック */ }
  }
  const it = DriveApp.getFoldersByName(INVOICE.defaultFolderName);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(INVOICE.defaultFolderName);
}

// ============================================================
// メニュー実行用ラッパー
// ============================================================

function issueInvoicesThisMonth() { runIssueInvoicesForOffset_(0); }
function issueInvoicesPrevMonth() { runIssueInvoicesForOffset_(-1); }

function runIssueInvoicesForOffset_(offset) {
  const ui = SpreadsheetApp.getUi();
  const ym = ymForMonthOffset_(offset);
  try {
    const res = issueInvoiceBookForMonth_(ym);
    if (res.count === 0) {
      ui.alert(`ℹ️ ${ym} は請求書の対象がありませんでした（先に出面を登録／単価マスタを確認）`);
      return;
    }
    ui.alert(
      `✅ ${ym} の請求書(xlsx)を作成しました（${res.count}取引先）\n\n` +
      `編集用スプレッドシート:\n${res.fileUrl}\n\n` +
      `各タブの「単価(入力)」に現場ごとの単価を入れると金額・合計が自動計算されます。\n` +
      `（ファイル → ダウンロード → Microsoft Excel(.xlsx) でxlsx化も可）`
    );
  } catch (err) {
    ui.alert(`❌ 請求書(xlsx)作成でエラー\n\n${err && err.stack ? err.stack : err}`);
  }
}

// ============================================================
// .xlsx 書き出し（単価を入れ終えた請求書ブックをExcel形式で保存）
// ============================================================
// 「請求書(xlsx)を作成」で出来た Googleスプレッドシートのブックに単価を入れたあと、
// これを実行すると同じフォルダに 請求書_YYYY-MM.xlsx を書き出す。
// （ブック自体も File → ダウンロード → Excel で個別にxlsx化できます）

function exportInvoiceXlsxForMonth_(ym) {
  const folder = resolveInvoiceFolder_(loadInvoiceSettings_());
  const it = folder.getFilesByName(`請求書_${ym}`);
  if (!it.hasNext()) return null; // ブック未作成

  const file = it.next();
  const url = "https://www.googleapis.com/drive/v3/files/" + file.getId() +
    "/export?mimeType=application%2Fvnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error("xlsx変換に失敗: HTTP " + res.getResponseCode());
  }
  const xlsx = folder.createFile(res.getBlob().setName(`請求書_${ym}.xlsx`));
  return xlsx.getUrl();
}

function exportInvoiceXlsxThisMonth() { runExportXlsxForOffset_(0); }
function exportInvoiceXlsxPrevMonth() { runExportXlsxForOffset_(-1); }

function runExportXlsxForOffset_(offset) {
  const ui = SpreadsheetApp.getUi();
  const ym = ymForMonthOffset_(offset);
  try {
    const url = exportInvoiceXlsxForMonth_(ym);
    if (!url) {
      ui.alert(`ℹ️ ${ym} の請求書ブックが見つかりません\n先に「請求書(xlsx)を作成」を実行してください。`);
      return;
    }
    ui.alert(`✅ ${ym} の請求書を .xlsx で保存しました\n\n${url}`);
  } catch (err) {
    ui.alert(`❌ xlsx書き出しでエラー\n\n${err && err.stack ? err.stack : err}`);
  }
}

// ============================================================
// 【ファイル6】請求書の自動作成（freee非依存・編集可能なスプレッドシート/xlsx）
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
  ["発行元名",      "", "請求書に載せる自社名"],
  ["発行元住所",    "", ""],
  ["発行元TEL",     "", ""],
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
  const pct     = Math.round((isNaN(taxRate) ? 0 : taxRate) * 100);

  const cm        = (typeof clientMasterMap_ === "function") ? (clientMasterMap_()[client] || {}) : {};
  const addr      = String(cm["住所"] ?? "").trim();
  const invoiceNo = `${String(ym).replace("-", "")}-${String(index + 1).padStart(2, "0")}`;
  const issueDate = invoiceMonthEnd_(ym);
  const issuer    = [settings["発行元名"], settings["発行元住所"],
                     settings["登録番号"] ? "登録番号 " + settings["登録番号"] : ""]
                      .map((v) => String(v ?? "").trim()).filter(Boolean).join("　");

  const vals = [];
  const push = (a, b, c, d, e) => { vals.push([a ?? "", b ?? "", c ?? "", d ?? "", e ?? ""]); return vals.length; };

  push("請求書", "", "", "", "");
  push(client + " 御中", "", "", "", "");
  if (addr) push(addr, "", "", "", "");
  push("請求書番号 " + invoiceNo, "", "発行日 " + issueDate, "", "");
  if (issuer) push("発行元 " + issuer, "", "", "", "");
  push("", "", "", "", "");
  push("現場", "人工", "残業h", "単価(入力)", "金額");

  const firstDetail = vals.length + 1;
  for (const site of Object.keys(data.sites).sort()) {
    const s    = data.sites[site];
    const r    = vals.length + 1;
    const rate = (typeof lookupRate_ === "function") ? lookupRate_(client, site, "常用", null) : null;
    const unit = rate && rate.unit > 0 ? rate.unit : ""; // 単価マスタからプリフィル（無ければ入力待ち）
    push(site, s.manDays, s.otHours, unit, `=IF($D${r}="","",$D${r}*$B${r}+$C${r}*$D${r}/8*1.25)`);
  }
  if (data.lump > 0) push("(請負) 一式", "", "", "", data.lump);
  const lastDetail = vals.length;

  const subtotalRow = push("小計(税抜)", "", "", "", `=SUM(E${firstDetail}:E${lastDetail})`);
  const taxRow      = push(`消費税(${pct}%)`, "", "", "", `=ROUND(E${subtotalRow}*${isNaN(taxRate) ? 0 : taxRate},0)`);
  let   expenseRow  = 0;
  if (data.expense > 0) expenseRow = push("立替経費(非課税)", "", "", "", data.expense);
  push("合計", "", "", "",
    expenseRow ? `=E${subtotalRow}+E${taxRow}+E${expenseRow}` : `=E${subtotalRow}+E${taxRow}`);
  push("", "", "", "", "");
  push("お振込先 " + String(settings["振込先"] ?? "").trim(), "", "", "", "");

  sheet.getRange(1, 1, vals.length, 5).setValues(vals);
  sheet.setFrozenRows(7);
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

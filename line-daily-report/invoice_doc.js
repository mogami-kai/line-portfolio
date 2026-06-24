// ============================================================
// 【ファイル6】請求書PDFの自動発行（freee非依存）
// 請求サマリ → 取引先ごとの請求書PDFを生成し Drive 保存（＋任意でメール）
// ============================================================
// 月末締め（billing.js の finalizeBillingForMonth_）から自動で呼ばれる。
// freee連携が無くても、これだけで「請求書の発行」まで自動化できる。
// GASの Utilities.newBlob(html).getAs("application/pdf") でHTML→PDF変換するため
// 追加インフラ・外部APIは不要。
//
// 依存（他ファイルの既存グローバル）:
//   TZ / BILLING / HEADERS_BILLING_SUMMARY / readSheetObjects_ /
//   toNumber / prop_ / appendProcessLog_ / ymForMonthOffset_ / dateCellToYmd_
//
// 設定（「請求書設定」シートのキー＝値。setupInvoiceSheet で雛形作成）:
//   発行元名 / 発行元住所 / 発行元TEL / 登録番号(インボイスT+13桁) / 振込先 /
//   消費税率(既定0.10) / 経費に課税(FALSE) / 端数処理(切り捨て) /
//   保存フォルダID(空なら「請求書」フォルダを自動作成) / メール送信(FALSE) / メール送信先
// ============================================================

const INVOICE = {
  sheetSettings:     "請求書設定",
  defaultTaxRate:    0.10,
  defaultFolderName: "請求書",
};

const HEADERS_INVOICE_SETTINGS = ["設定キー", "値", "説明"];

const INVOICE_SETTING_DEFAULTS = [
  ["発行元名",     "", "請求書に載せる自社名"],
  ["発行元住所",   "", ""],
  ["発行元TEL",    "", ""],
  ["登録番号",     "", "インボイス制度の適格請求書発行事業者番号（T+13桁）"],
  ["振込先",       "", "例: ○○銀行 △△支店 普通 1234567 ﾔﾏﾀﾞﾀﾛｳ"],
  ["消費税率",     "0.10", "0.10=10%。単価が税込なら 0 を設定"],
  ["経費に課税",   "FALSE", "立替経費に消費税を載せるか（既定FALSE=非課税の立替扱い）"],
  ["端数処理",     "切り捨て", "消費税の端数: 切り捨て / 四捨五入 / 切り上げ"],
  ["保存フォルダID", "", "空ならマイドライブに「請求書」フォルダを自動作成"],
  ["メール送信",   "FALSE", "TRUEで発行後にPDFをメール送信"],
  ["メール送信先", "", "メール送信先（カンマ区切り可）"],
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
    "発行はメニュー『請求・経費』→『請求書PDFを発行』。月末締めでも自動発行されます。"
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

// ============================================================
// 請求モデル組み立て（純粋関数・テスト対象）
// ============================================================

const roundTax_ = (v, mode) => {
  const m = String(mode ?? "").trim();
  if (m === "四捨五入") return Math.round(v);
  if (m === "切り上げ") return Math.ceil(v);
  return Math.floor(v); // 既定: 切り捨て
};

const invoiceMonthEnd_ = (ym) => {
  const m = String(ym).match(/^(\d{4})-(\d{2})$/);
  if (!m) return "";
  return Utilities.formatDate(new Date(Number(m[1]), Number(m[2]), 0), TZ, "yyyy/MM/dd");
};

function buildInvoiceModel_(ym, s, settings, index) {
  const client  = String(s["取引先"] ?? "").trim();
  const manDays = toNumber(s["常用_人工合計"], 0);
  const joyo    = toNumber(s["常用請求額"], 0);
  const lump    = toNumber(s["請負請求額"], 0);
  const exp     = toNumber(s["経費請求額"], 0);

  const lineItems = [];
  if (joyo > 0) {
    const unit = manDays > 0 ? Math.round(joyo / manDays) : joyo;
    lineItems.push({ name: "出面（常用）", qty: manDays || 1, unit, amount: joyo });
  }
  if (lump > 0) lineItems.push({ name: "請負工事一式", qty: 1, unit: lump, amount: lump });

  const rawRate = settings["消費税率"];
  const taxRate = (rawRate === "" || rawRate == null) ? INVOICE.defaultTaxRate : Number(rawRate);
  const taxOnExp = String(settings["経費に課税"] ?? "").toUpperCase() === "TRUE";

  let taxable = joyo + lump;
  let reimburse = 0;
  if (exp > 0) {
    if (taxOnExp) taxable += exp;
    else reimburse = exp; // 立替（非課税）として別計上
  }

  const tax   = roundTax_(taxable * (isNaN(taxRate) ? 0 : taxRate), settings["端数処理"]);
  const total = taxable + tax + reimburse;

  const issueDate =
    (typeof dateCellToYmd_ === "function" ? dateCellToYmd_(s["請求日"]) : String(s["請求日"] ?? "")) ||
    invoiceMonthEnd_(ym);
  const invoiceNo = `${String(ym).replace("-", "")}-${String((index ?? 0) + 1).padStart(2, "0")}`;

  return {
    invoiceNo, issueDate, ym, client, manDays,
    lineItems, taxRate: isNaN(taxRate) ? 0 : taxRate, taxable, tax, reimburse, exp, total,
  };
}

// ============================================================
// HTML生成（純粋関数・テスト対象）
// ============================================================

const escapeHtml_ = (s) => String(s ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const yen_ = (n) => "¥" + Math.round(Number(n) || 0).toLocaleString("ja-JP");

function buildInvoiceHtml_(model, settings) {
  const issuer = {
    name: escapeHtml_(settings["発行元名"] || ""),
    addr: escapeHtml_(settings["発行元住所"] || ""),
    tel:  escapeHtml_(settings["発行元TEL"] || ""),
    reg:  escapeHtml_(settings["登録番号"] || ""),
    bank: escapeHtml_(settings["振込先"] || ""),
  };

  const rows = model.lineItems.map((l) => `
        <tr>
          <td class="l">${escapeHtml_(l.name)}</td>
          <td class="r">${(Number(l.qty) || 0).toLocaleString("ja-JP")}</td>
          <td class="r">${yen_(l.unit)}</td>
          <td class="r">${yen_(l.amount)}</td>
        </tr>`).join("");

  const taxPct = Math.round((model.taxRate || 0) * 100);
  const reimburseRow = model.reimburse > 0
    ? `<tr><td colspan="3" class="r">立替経費（非課税）</td><td class="r">${yen_(model.reimburse)}</td></tr>`
    : "";

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box} body{font-family:'Noto Sans JP','Hiragino Sans',sans-serif;color:#222;margin:0;padding:32px}
    .head{display:flex;justify-content:space-between;align-items:flex-start}
    h1{font-size:28px;letter-spacing:8px;margin:0 0 12px;border-bottom:3px solid #333;padding-bottom:6px}
    .muted{color:#666;font-size:12px} .to{font-size:18px;margin:16px 0 4px} .to b{font-size:20px}
    .total{margin:16px 0;padding:10px 14px;background:#f2f5f8;border-left:5px solid #2b6cb0;font-size:20px}
    table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}
    th,td{border:1px solid #ccc;padding:7px 9px} th{background:#2b6cb0;color:#fff}
    td.r,th.r{text-align:right} td.l,th.l{text-align:left}
    tfoot td{font-weight:bold;background:#f7f9fc}
    .bank{margin-top:18px;font-size:13px;padding:10px;border:1px dashed #999}
  </style></head><body>
    <div class="head">
      <div>
        <h1>請求書</h1>
        <div class="to"><b>${escapeHtml_(model.client)}</b> 御中</div>
      </div>
      <div class="muted">
        請求書番号: ${escapeHtml_(model.invoiceNo)}<br>
        発行日: ${escapeHtml_(model.issueDate)}<br>
        対象月: ${escapeHtml_(model.ym)}
      </div>
    </div>

    <div class="total">ご請求金額　<b>${yen_(model.total)}</b>（税込）</div>

    <table>
      <thead><tr><th class="l">品目</th><th class="r">数量</th><th class="r">単価</th><th class="r">金額</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td colspan="3" class="r">小計（税抜）</td><td class="r">${yen_(model.taxable)}</td></tr>
        <tr><td colspan="3" class="r">消費税（${taxPct}%）</td><td class="r">${yen_(model.tax)}</td></tr>
        ${reimburseRow}
        <tr><td colspan="3" class="r">合計</td><td class="r">${yen_(model.total)}</td></tr>
      </tfoot>
    </table>

    <div class="bank">お振込先: ${issuer.bank || "（請求書設定の「振込先」に入力してください）"}</div>

    <div class="muted" style="margin-top:24px">
      ${issuer.name}${issuer.addr ? "　" + issuer.addr : ""}${issuer.tel ? "　TEL " + issuer.tel : ""}<br>
      ${issuer.reg ? "登録番号 " + issuer.reg : ""}
    </div>
  </body></html>`;
}

// ============================================================
// 発行（請求サマリ → 取引先ごとのPDFをDrive保存・任意でメール）
// ============================================================

function issueInvoicesForMonth_(ym) {
  const settings = loadInvoiceSettings_();

  const summary = readSheetObjects_(BILLING.sheetSummary, HEADERS_BILLING_SUMMARY)
    .filter((r) => String(r["対象月"] ?? "").trim() === String(ym).trim())
    .filter((r) => toNumber(r["合計請求額"], 0) > 0);

  if (summary.length === 0) {
    appendProcessLog_(new Date(), "", "", "", `[INVOICE_PDF] ${ym}`, "INFO", "対象なし（請求額0）");
    return { count: 0, folderUrl: "", created: [] };
  }

  const folder   = resolveInvoiceFolder_(settings);
  const sendMail = String(settings["メール送信"] ?? "").toUpperCase() === "TRUE";
  const mailTo   = String(settings["メール送信先"] ?? "").trim();

  const created = [];
  summary.forEach((s, i) => {
    const model = buildInvoiceModel_(ym, s, settings, i);
    const html  = buildInvoiceHtml_(model, settings);
    const name  = `請求書_${model.client}_${ym}.pdf`;
    const pdf   = Utilities.newBlob(html, "text/html", name.replace(/\.pdf$/, ".html"))
      .getAs("application/pdf")
      .setName(name);
    const file  = folder.createFile(pdf);
    created.push({ client: model.client, total: model.total, url: file.getUrl() });

    if (sendMail && mailTo) {
      MailApp.sendEmail({
        to: mailTo,
        subject: `【請求書】${model.client} ${ym}（${model.invoiceNo}）`,
        body: `${model.client} 御中\n\n${ym}分の請求書を添付します。\n` +
              `ご請求金額: ${Math.round(model.total).toLocaleString("ja-JP")}円（税込）`,
        attachments: [pdf],
      });
    }
  });

  appendProcessLog_(
    new Date(), "", "", "",
    `[INVOICE_PDF] ${ym}`, "SUCCESS_INVOICE",
    `created=${created.length} folder=${folder.getId()} mail=${sendMail}`
  );

  return { count: created.length, folderUrl: folder.getUrl(), created };
}

// 保存先フォルダを解決（設定 → スクリプトプロパティ → 「請求書」フォルダ自動作成）
function resolveInvoiceFolder_(settings) {
  const id = String(settings["保存フォルダID"] ?? "").trim() || prop_("INVOICE_FOLDER_ID");
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* フォールバック */ }
  }
  const name = INVOICE.defaultFolderName;
  const it = DriveApp.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(name);
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
    const res = issueInvoicesForMonth_(ym);
    if (res.count === 0) {
      ui.alert(`ℹ️ ${ym} は請求書の対象がありませんでした\n先に「請求サマリを作成」を実行してください。`);
      return;
    }
    ui.alert(
      `✅ ${ym} の請求書PDFを ${res.count}件 発行しました\n\n` +
      `保存先フォルダ:\n${res.folderUrl}`
    );
  } catch (err) {
    ui.alert(`❌ 請求書PDF発行でエラー\n\n${err && err.stack ? err.stack : err}`);
  }
}

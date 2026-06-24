// ============================================================
// invoice_doc.js（請求書xlsxブック・単価は管理者入力）の単体テスト
//   node test/invoice.test.js
// ============================================================

const assert = require("node:assert");
const path = require("node:path");
const { loadGas } = require("./gas_mock");

const webhookPath = path.resolve(__dirname, "../line-daily-report/webhook.js");
const billingPath = path.resolve(__dirname, "../line-daily-report/billing.js");
const invoicePath = path.resolve(__dirname, "../line-daily-report/invoice_doc.js");

const HEADERS_DAILY_REPORT = [
  "管理ID", "日付", "年月", "取引先", "契約種別", "勤務体系",
  "現場", "職人名", "人工", "残業時間", "元メッセージID",
  "登録日時", "判定方法", "確認状態", "AI要約",
];
const HEADERS_LUMPSUM          = ["取引先", "案件名", "契約金額", "計上月", "ステータス", "備考"];
const HEADERS_EXPENSE          = ["日付", "取引先", "現場", "職人名", "種別", "金額", "請求対象", "元メッセージID", "登録方法", "備考"];
const HEADERS_CLIENT_MASTER    = ["取引先", "現場", "単価", "住所", "請求日ルール", "別名", "備考"];
const HEADERS_INVOICE_SETTINGS = ["設定キー", "値", "説明"];

let passed = 0, failed = 0, assertionCount = 0;
const A = new Proxy(assert, { get: (t, k) => (...a) => { assertionCount++; return t[k](...a); } });
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (e) { console.log(`  FAIL- ${name}\n        ${e.message}`); failed++; }
}

function seedCommon(ss) {
  ss.__seed("作業日報", [
    HEADERS_DAILY_REPORT,
    ["id1", new Date(2026, 2, 18, 12), "2026-03", "A", "常用", "", "現場1", "田中", 2, 1, "M1", "", "従来ルール", "自動登録", ""],
    ["id2", new Date(2026, 2, 19, 12), "2026-03", "A", "常用", "", "現場2", "鈴木", 1, 0, "M2", "", "従来ルール", "自動登録", ""],
  ]);
  ss.__seed("取引先マスタ", [
    HEADERS_CLIENT_MASTER,
    ["A", "現場1", 20000, "横浜市港北区ダミー1-2-3", "末日", "", ""],
  ]);
  ss.__seed("請負案件マスタ", [HEADERS_LUMPSUM, ["A", "ビル改修", 500000, "2026-03", "未請求", ""]]);
  ss.__seed("経費", [HEADERS_EXPENSE, ["2026/03/20", "A", "現場1", "", "パーキング", 8000, "請求", "M3", "LINE", ""]]);
  ss.__seed("請求書設定", [
    HEADERS_INVOICE_SETTINGS,
    ["消費税率", "0.10", ""],
    ["振込先", "テスト銀行 普通 1234567", ""],
    ["発行元名", "デモ社", ""],
    ["登録番号", "T1234567890123", ""],
  ]);
}

test("aggregateForInvoice_ : 取引先×現場の集計＋請負＋立替経費", () => {
  const { ctx, ss } = loadGas([webhookPath, billingPath, invoicePath], { props: {} });
  seedCommon(ss);
  const agg = ctx.aggregateForInvoice_("2026-03");
  A.strictEqual(agg.A.sites["現場1"].manDays, 2);
  A.strictEqual(agg.A.sites["現場1"].otHours, 1);
  A.strictEqual(agg.A.sites["現場2"].manDays, 1);
  A.strictEqual(agg.A.lump, 500000);
  A.strictEqual(agg.A.expense, 8000);
});

test("issueInvoiceBookForMonth_ : 取引先ごとのタブ＋単価プリフィル＋数式で請求書ブック作成", () => {
  const { ctx, ss, createdSpreadsheets } = loadGas([webhookPath, billingPath, invoicePath], { props: {} });
  seedCommon(ss);

  const res = ctx.issueInvoiceBookForMonth_("2026-03");
  A.strictEqual(res.count, 1);
  A.strictEqual(createdSpreadsheets.length, 1);

  const book = createdSpreadsheets[0];
  A.strictEqual(book.getName(), "請求書_2026-03");
  A.ok(book.getSheetByName("A"), "取引先Aのタブがある");
  A.strictEqual(book.getSheets().length, 1, "既定シートは削除される");

  const flat = book.__data("A").map((r) => r.join("｜")).join("\n");
  for (const needle of [
    "請求書", "請求書番号", "請求日", "御中", "横浜市港北区ダミー",
    "No", "品目・内容", "常用", "残業", "請負工事一式", "立替経費",
    "=IF($E", "=ROUND(", "小計", "消費税", "合計（税込）", "お支払期限", "お振込先", "テスト銀行", "備考",
  ]) {
    A.ok(flat.includes(needle), `タブに「${needle}」が含まれる`);
  }
  A.ok(flat.includes("20000"), "現場1の単価が取引先マスタからプリフィルされる");
});

test("issueInvoiceBookForMonth_ : 対象が無ければブックを作らない", () => {
  const { ctx, ss, createdSpreadsheets } = loadGas([webhookPath, billingPath, invoicePath], { props: {} });
  ss.__seed("作業日報", [HEADERS_DAILY_REPORT]);
  const res = ctx.issueInvoiceBookForMonth_("2026-03");
  A.strictEqual(res.count, 0);
  A.strictEqual(createdSpreadsheets.length, 0);
});

console.log(`\nTests: ${passed} passed, ${failed} failed (${assertionCount} assertions)`);
process.exit(failed ? 1 : 0);

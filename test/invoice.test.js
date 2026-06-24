// ============================================================
// invoice_doc.js（請求書PDF自動発行・freee非依存）の単体テスト
//   node test/invoice.test.js
// ============================================================

const assert = require("node:assert");
const path = require("node:path");
const { loadGas } = require("./gas_mock");

const webhookPath = path.resolve(__dirname, "../line-daily-report/webhook.js");
const billingPath = path.resolve(__dirname, "../line-daily-report/billing.js");
const invoicePath = path.resolve(__dirname, "../line-daily-report/invoice_doc.js");

const HEADERS_BILLING_SUMMARY = [
  "対象月", "取引先", "常用_人工合計", "残業合計h", "夜勤日数",
  "常用請求額", "請負請求額", "経費請求額", "合計請求額",
  "請求日", "ステータス", "単価未設定", "生成日時",
];
const HEADERS_INVOICE_SETTINGS = ["設定キー", "値", "説明"];
const HEADERS_CLIENT_MASTER = ["取引先", "別名", "締め日", "請求日ルール", "freee取引先ID", "振込先メモ", "備考", "住所"];

let passed = 0, failed = 0, assertionCount = 0;
const A = new Proxy(assert, { get: (t, k) => (...a) => { assertionCount++; return t[k](...a); } });
function test(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); passed++; }
  catch (e) { console.log(`  FAIL- ${name}\n        ${e.message}`); failed++; }
}

test("buildInvoiceModel_ : 税抜小計・消費税(切り捨て)・立替非課税・合計・請求書番号", () => {
  const { ctx } = loadGas([webhookPath, billingPath, invoicePath], { props: {} });
  const s = { 取引先: "A", "常用_人工合計": 10, 常用請求額: 200000, 請負請求額: 50000, 経費請求額: 8000, 請求日: "2026/03/31" };
  const m = ctx.buildInvoiceModel_("2026-03", s, { 消費税率: "0.10", 経費に課税: "FALSE", 端数処理: "切り捨て" }, 0);
  A.strictEqual(m.taxable, 250000);   // 常用+請負（税抜）
  A.strictEqual(m.tax, 25000);        // floor(250000*0.10)
  A.strictEqual(m.reimburse, 8000);   // 立替（非課税）
  A.strictEqual(m.total, 283000);     // 250000+25000+8000
  A.strictEqual(m.invoiceNo, "202603-01");
  A.strictEqual(m.issueDate, "2026/03/31");
  A.strictEqual(m.lineItems.length, 2);
  A.strictEqual(m.lineItems[0].unit, 20000); // 200000/10
});

test("buildInvoiceModel_ : 端数処理（切り捨て=1234 / 四捨五入=1235）", () => {
  const { ctx } = loadGas([webhookPath, billingPath, invoicePath], { props: {} });
  const s = { 取引先: "A", "常用_人工合計": 1, 常用請求額: 12345, 請負請求額: 0, 経費請求額: 0, 請求日: "2026/03/31" };
  const floor = ctx.buildInvoiceModel_("2026-03", s, { 消費税率: "0.10", 端数処理: "切り捨て" }, 0);
  const round = ctx.buildInvoiceModel_("2026-03", s, { 消費税率: "0.10", 端数処理: "四捨五入" }, 0);
  A.strictEqual(floor.tax, 1234); // floor(1234.5)
  A.strictEqual(round.tax, 1235); // round(1234.5)
});

test("buildInvoiceModel_ : 経費に課税=TRUE なら立替を課税対象に含める", () => {
  const { ctx } = loadGas([webhookPath, billingPath, invoicePath], { props: {} });
  const s = { 取引先: "A", "常用_人工合計": 10, 常用請求額: 200000, 請負請求額: 0, 経費請求額: 10000, 請求日: "2026/03/31" };
  const m = ctx.buildInvoiceModel_("2026-03", s, { 消費税率: "0.10", 経費に課税: "TRUE", 端数処理: "切り捨て" }, 0);
  A.strictEqual(m.taxable, 210000);
  A.strictEqual(m.reimburse, 0);
  A.strictEqual(m.tax, 21000);
  A.strictEqual(m.total, 231000);
});

test("buildInvoiceHtml_ : 取引先・請求書番号・消費税・立替・振込先を含む", () => {
  const { ctx } = loadGas([webhookPath, billingPath, invoicePath], { props: {} });
  const s = { 取引先: "恵デモ", "常用_人工合計": 10, 常用請求額: 200000, 請負請求額: 0, 経費請求額: 8000, 請求日: "2026/03/31" };
  const settings = { 消費税率: "0.10", 振込先: "テスト銀行 普通 1234567", 発行元名: "デモ社" };
  const html = ctx.buildInvoiceHtml_(ctx.buildInvoiceModel_("2026-03", s, settings, 0), settings, "横浜市デモ町1-2-3");
  for (const needle of ["請求書", "恵デモ", "202603-01", "消費税", "立替経費", "テスト銀行 普通 1234567", "デモ社", "横浜市デモ町1-2-3"]) {
    A.ok(html.includes(needle), `HTMLに「${needle}」が含まれる`);
  }
});

test("issueInvoicesForMonth_ : サマリからPDFをDrive保存し、メール送信もする", () => {
  const { ctx, ss, driveFiles, mailbox } = loadGas([webhookPath, billingPath, invoicePath], { props: {} });
  ss.__seed("請求書設定", [
    HEADERS_INVOICE_SETTINGS,
    ["消費税率", "0.10", ""],
    ["振込先", "テスト銀行", ""],
    ["発行元名", "デモ社", ""],
    ["メール送信", "TRUE", ""],
    ["メール送信先", "owner@example.com", ""],
  ]);
  ss.__seed("取引先マスタ", [
    HEADERS_CLIENT_MASTER,
    ["A", "", "末", "末日", "", "", "", "横浜市金沢区六浦3-36-9"],
  ]);
  ss.__seed("請求サマリ", [
    HEADERS_BILLING_SUMMARY,
    ["2026-03", "A", 10, 0, 0, 200000, 50000, 8000, 258000, "2026/03/31", "未請求", "", "t"],
    ["2026-03", "B", 0, 0, 0, 0, 0, 0, 0, "2026/03/31", "未請求", "", "t"], // 合計0 → 対象外
  ]);

  const res = ctx.issueInvoicesForMonth_("2026-03");
  A.strictEqual(res.count, 1);                 // Bは合計0で除外
  A.strictEqual(driveFiles.length, 1);
  A.strictEqual(driveFiles[0].getName(), "請求書_A_2026-03.pdf");
  A.ok(driveFiles[0]._blob.getDataAsString().includes("テスト銀行"));
  A.ok(driveFiles[0]._blob.getDataAsString().includes("横浜市金沢区六浦")); // 宛先住所
  A.strictEqual(mailbox.length, 1);
  A.strictEqual(mailbox[0].to, "owner@example.com");
  A.strictEqual(mailbox[0].attachments.length, 1);
});

console.log(`\nTests: ${passed} passed, ${failed} failed (${assertionCount} assertions)`);
process.exit(failed ? 1 : 0);

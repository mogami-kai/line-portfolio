// ============================================================
// Unit tests for line-daily-report/billing.js, run under Node by
// mocking the GAS runtime (see gas_mock.js).
//
//   node /home/user/line-portfolio/test/billing.test.js
// ============================================================

// Make Date construction + Asia/Tokyo formatting line up deterministically.
process.env.TZ = "Asia/Tokyo";

const assert = require("node:assert");
const path = require("node:path");
const { loadGas } = require("./gas_mock.js");

const webhookPath = path.resolve(__dirname, "../line-daily-report/webhook.js");
const billingPath = path.resolve(__dirname, "../line-daily-report/billing.js");

// ------------------------------------------------------------
// Header arrays (copied from billing.js / webhook.js) so seeds are
// column-accurate.
// ------------------------------------------------------------
const HEADERS_DAILY_REPORT = [
  "管理ID", "日付", "年月", "取引先", "契約種別", "勤務体系",
  "現場", "職人名", "人工", "残業時間", "元メッセージID",
  "登録日時", "判定方法", "確認状態", "AI要約",
];
const HEADERS_CLIENT_MASTER = [
  "取引先", "現場", "単価", "住所", "請求日ルール", "別名", "freee取引先ID", "備考",
];
const HEADERS_LUMPSUM = [
  "取引先", "案件名", "契約金額", "計上月", "ステータス", "備考",
];
const HEADERS_EXPENSE = [
  "日付", "取引先", "現場", "職人名", "種別", "金額", "請求対象", "元メッセージID", "登録方法", "備考",
];
const HEADERS_BILLING_SUMMARY = [
  "対象月", "取引先", "常用_人工合計", "残業合計h", "夜勤日数",
  "常用請求額", "請負請求額", "経費請求額", "合計請求額",
  "請求日", "ステータス", "単価未設定", "生成日時",
];
const HEADERS_FREEE = [
  "対象月", "取引先", "請求日", "期日", "品目", "数量", "単価", "金額", "備考",
];

// Sheet names (from BILLING / CONFIG).
const SHEET = {
  report: "作業日報",
  client: "取引先マスタ",
  lump: "請負案件マスタ",
  expense: "経費",
  summary: "請求サマリ",
  freee: "freee取込",
};

// ------------------------------------------------------------
// Tiny test runner
// ------------------------------------------------------------
let passed = 0;
let failed = 0;
let assertionCount = 0;

// Wrap assert so we can count individual assertions.
const A = new Proxy(assert, {
  get(target, prop) {
    const orig = target[prop];
    if (typeof orig === "function") {
      return (...args) => {
        assertionCount++;
        return orig.apply(target, args);
      };
    }
    return orig;
  },
});

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL- ${name}`);
    console.log("        " + (err && err.stack ? err.stack.split("\n").join("\n        ") : err));
  }
}

// Helper: build a fresh harness for each test (independent state).
function freshGas() {
  const { ctx, ss } = loadGas([webhookPath, billingPath], { props: {} });
  return { ctx, ss };
}

const D = (m, d, h = 12) => new Date(2026, m - 1, d, h, 0, 0); // noon by default

// ============================================================
// 1. extractExpensesFromText_
// ============================================================
test("extractExpensesFromText_ parses parking / gasoline / highway and ignores worker lines", () => {
  const { ctx } = freshGas();
  const f = ctx.extractExpensesFromText_;

  // Use deepEqual (structural, prototype-agnostic): the objects are created
  // inside the vm realm, so their Object.prototype differs from the test
  // realm's and deepStrictEqual would reject them on identity grounds.
  A.deepEqual(f("パーキング1200円"), [{ 種別: "パーキング", 金額: 1200 }]);
  A.deepEqual(f("ガソリン代4000円"), [{ 種別: "ガソリン", 金額: 4000 }]);
  A.deepEqual(f("高速1500"), [{ 種別: "高速", 金額: 1500 }]);
  // A plain worker line yields no expenses.
  A.deepEqual(f("後藤 1 残業1"), []);

  // Multi-line: each matching line contributes; comma-grouped amounts parse.
  A.deepEqual(f("高速2,500\n駐車場 800円"), [
    { 種別: "高速", 金額: 2500 },
    { 種別: "パーキング", 金額: 800 },
  ]);
});

// ============================================================
// 2. lookupRate_
// ============================================================
test("lookupRate_ : exact site beats default, alias resolves to canonical, unknown -> null", () => {
  const { ctx, ss } = freshGas();
  ctx.resetBillingCache_();

  // 取引先マスタ1枚に集約: 既定(現場空欄)＋別名は同じ行、現場Xで上書き。
  ss.__seed(SHEET.client, [
    HEADERS_CLIENT_MASTER,
    ["元請A", "", 18000, "", "", "マルエー,MALU", "", "既定単価"],
    ["元請A", "現場X", 20000, "", "", "", "", "現場上書き"],
  ]);

  const onSite = ctx.lookupRate_("元請A", "現場X", "常用", D(3, 18));
  A.strictEqual(onSite.unit, 20000, "exact 現場 match should win over default");
  A.strictEqual(onSite.nightAdd, 0); // 夜勤割増は廃止（常に0）

  const offSite = ctx.lookupRate_("元請A", "現場Z", "常用", D(3, 18));
  A.strictEqual(offSite.unit, 18000, "unknown 現場 should fall back to default rate");

  // Alias should resolve to canonical client, then to its default rate.
  const viaAlias = ctx.lookupRate_("マルエー", "現場Q", "常用", D(3, 18));
  A.strictEqual(viaAlias.unit, 18000, "alias must resolve to canonical client");
  const viaAlias2 = ctx.lookupRate_("MALU", "現場X", "常用", D(3, 18));
  A.strictEqual(viaAlias2.unit, 20000, "alias + exact site");

  // Unknown client -> null.
  A.strictEqual(ctx.lookupRate_("知らない会社", "現場X", "常用", D(3, 18)), null);
});

// ============================================================
// 3. buildBillingSummary_("2026-03")
// ============================================================
test("buildBillingSummary_ aggregates 常用 + 請負 + 経費 and lists 単価未設定", () => {
  const { ctx, ss } = freshGas();

  // 取引先マスタ1枚に集約。現場Xだけ単価あり（現場Zは未設定）。別名は同じ行に。
  ss.__seed(SHEET.client, [
    HEADERS_CLIENT_MASTER,
    ["元請A", "現場X", 20000, "", "", "マルエー", "", ""],
  ]);

  // 作業日報 rows. Columns per HEADERS_DAILY_REPORT.
  // 年月(C) left blank: buildBillingSummary_ recomputes month from 日付(B).
  const r = (id, date, client, contract, shift, site, worker, qty, ot) => {
    const row = new Array(HEADERS_DAILY_REPORT.length).fill("");
    row[0] = id;
    row[1] = date;
    row[3] = client;
    row[4] = contract;
    row[5] = shift;
    row[6] = site;
    row[7] = worker;
    row[8] = qty;
    row[9] = ot;
    return row;
  };
  ss.__seed(SHEET.report, [
    HEADERS_DAILY_REPORT,
    r("m1_0", D(3, 18), "元請A", "常用", "", "現場X", "後藤", 1, 2),     // base+OT
    r("m1_1", D(3, 19), "元請A", "常用", "夜勤", "現場X", "石渡", 1, 0), // base+night
    r("m1_2", D(3, 20), "元請A", "常用", "", "現場Z", "齋", 1, 0),       // no rate -> missing
    // Out-of-month row (Feb) must be ignored.
    r("m1_3", D(2, 10), "元請A", "常用", "", "現場X", "誰か", 1, 0),
    // 請負 row in 作業日報 must be ignored here (counted via 請負案件マスタ).
    r("m1_4", D(3, 21), "元請A", "請負", "", "現場X", "請負職人", 1, 0),
  ]);

  ss.__seed(SHEET.lump, [
    HEADERS_LUMPSUM,
    ["元請A", "サンプル案件", 500000, "2026-03", "未請求", ""],
    ["元請A", "別月案件", 999999, "2026-02", "未請求", ""], // wrong month, ignored
  ]);

  ss.__seed(SHEET.expense, [
    HEADERS_EXPENSE,
    [D(3, 18), "元請A", "現場X", "後藤", "高速", 8000, "請求", "", "手動", ""],     // billable
    [D(3, 18), "元請A", "現場X", "後藤", "ガソリン", 5000, "自社負担", "", "手動", ""], // not billable
    [D(2, 18), "元請A", "現場X", "後藤", "高速", 7777, "請求", "", "手動", ""],     // wrong month
  ]);

  const res = ctx.buildBillingSummary_("2026-03");

  // ---- expected numbers (computed by hand) ----
  // 夜勤割増は廃止（常に0）。残業係数は1.25固定。
  const unit = 20000, otFactor = 1.25;
  const joyoRow1 = unit * 1 + (unit / 8) * otFactor * 2;          // 20000 + 6250 = 26250
  const joyoRow2 = unit * 1;                                      // 夜勤も1日=単価のみ = 20000
  const expectedJoyo = Math.round(joyoRow1 + joyoRow2);            // 46250
  const expectedLump = 500000;
  const expectedExpense = 8000;
  const expectedTotal = expectedJoyo + expectedLump + expectedExpense; // 557250

  const data = ss.__data(SHEET.summary);
  // Row 0 = header, row 1 = 元請A.
  A.deepStrictEqual(data[0], HEADERS_BILLING_SUMMARY);
  const row = data[1];
  const col = (h) => row[HEADERS_BILLING_SUMMARY.indexOf(h)];

  A.strictEqual(col("対象月"), "2026-03");
  A.strictEqual(col("取引先"), "元請A");
  A.strictEqual(col("常用_人工合計"), 3, "manDays = 1+1+1 (3 in-month 常用 rows)");
  A.strictEqual(col("残業合計h"), 2);
  A.strictEqual(col("夜勤日数"), 1);
  A.strictEqual(col("常用請求額"), expectedJoyo);
  A.strictEqual(col("請負請求額"), expectedLump);
  A.strictEqual(col("経費請求額"), expectedExpense);
  A.strictEqual(col("合計請求額"), expectedTotal);
  A.strictEqual(col("単価未設定"), "現場Z", "no-rate 現場 must be listed");
  A.strictEqual(col("請求日"), "2026/03/31", "blank 請求日ルール -> month end");

  // ---- return value ----
  A.strictEqual(res.clientCount, 1);
  A.strictEqual(res.totalAmount, expectedTotal);
  A.strictEqual(res.missing.length, 1);
  A.ok(res.missing[0].includes("現場Z"));
});

// ============================================================
// 4. exportFreee_("2026-03")
// ============================================================
test("exportFreee_ emits 出面（常用）/ 請負工事一式 / 立替経費 lines with 請求日===期日", () => {
  const { ctx, ss } = freshGas();

  ss.__seed(SHEET.client, [
    HEADERS_CLIENT_MASTER,
    ["元請A", "現場X", 20000, "", "", "", "", ""],
  ]);
  const r = (id, date, shift, site, worker, qty, ot) => {
    const row = new Array(HEADERS_DAILY_REPORT.length).fill("");
    row[0] = id; row[1] = date; row[3] = "元請A"; row[4] = "常用";
    row[5] = shift; row[6] = site; row[7] = worker; row[8] = qty; row[9] = ot;
    return row;
  };
  ss.__seed(SHEET.report, [
    HEADERS_DAILY_REPORT,
    r("m1_0", D(3, 18), "", "現場X", "後藤", 1, 2),
    r("m1_1", D(3, 19), "夜勤", "現場X", "石渡", 1, 0),
  ]);
  ss.__seed(SHEET.lump, [
    HEADERS_LUMPSUM,
    ["元請A", "サンプル案件", 500000, "2026-03", "未請求", ""],
  ]);
  ss.__seed(SHEET.expense, [
    HEADERS_EXPENSE,
    [D(3, 18), "元請A", "現場X", "後藤", "高速", 8000, "請求", "", "手動", ""],
  ]);

  ctx.buildBillingSummary_("2026-03");
  const n = ctx.exportFreee_("2026-03");
  A.strictEqual(n, 3, "three 品目 lines (常用 + 請負 + 経費)");

  const data = ss.__data(SHEET.freee);
  A.deepStrictEqual(data[0], HEADERS_FREEE);
  const lines = data.slice(1);
  const idx = (h) => HEADERS_FREEE.indexOf(h);

  const expectedJoyo = 20000 * 1 + (20000 / 8) * 1.25 * 2 + 20000; // 46250 (夜勤も1日=単価のみ)
  const byItem = {};
  for (const ln of lines) byItem[ln[idx("品目")]] = ln;

  const joyoLine = byItem["出面（常用）"];
  A.ok(joyoLine, "出面（常用）line present");
  A.strictEqual(joyoLine[idx("数量")], 2);                 // manDays = 1+1 (two 現場X rows)
  A.strictEqual(joyoLine[idx("金額")], expectedJoyo);
  A.strictEqual(joyoLine[idx("単価")], Math.round(expectedJoyo / 2)); // 24625

  const lumpLine = byItem["請負工事一式"];
  A.ok(lumpLine, "請負工事一式 line present");
  A.strictEqual(lumpLine[idx("数量")], 1);
  A.strictEqual(lumpLine[idx("金額")], 500000);

  const expLine = byItem["立替経費（駐車/燃料等）"];
  A.ok(expLine, "立替経費 line present");
  A.strictEqual(expLine[idx("金額")], 8000);

  // 請求日 === 期日 on every line, and both are the month-end date.
  for (const ln of lines) {
    A.strictEqual(ln[idx("請求日")], ln[idx("期日")], "請求日 must equal 期日");
    A.strictEqual(ln[idx("請求日")], "2026/03/31");
  }
});

// ============================================================
// 5. computeBillingDate_("2026-02", client)
// ============================================================
test("computeBillingDate_ : default = month end, numeric 請求日ルール = that day", () => {
  const { ctx, ss } = freshGas();
  ctx.resetBillingCache_();

  ss.__seed(SHEET.client, [
    HEADERS_CLIENT_MASTER,
    ["締め末元請", "", "", "", "", "", "", ""],   // 請求日ルール blank -> month end
    ["20日締元請", "", "", "", "20", "", "", ""], // 請求日ルール(5列目) = "20"
  ]);

  A.strictEqual(
    ctx.computeBillingDate_("2026-02", "締め末元請"),
    "2026/02/28",
    "default rule -> last day of Feb 2026 (non-leap)"
  );
  A.strictEqual(
    ctx.computeBillingDate_("2026-02", "20日締元請"),
    "2026/02/20",
    "numeric rule 20 -> the 20th"
  );
  // A client not in the master also defaults to month end.
  A.strictEqual(ctx.computeBillingDate_("2026-02", "未登録"), "2026/02/28");
});

// ============================================================
console.log("");
console.log(`Tests: ${passed} passed, ${failed} failed (${assertionCount} assertions)`);
if (failed > 0) process.exit(1);

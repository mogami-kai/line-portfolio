// ============================================================
// Unit tests for the MVP-2 / MVP-3 additions:
//   billing.js : captureExpensesFromText_, deleteExpensesByMessageId_,
//                purgeBillingMonth_, finalizeBillingForMonth_
//   webhook.js : handleLineEvent unsend hook (報告＋経費の連動削除)
//
//   node /home/user/line-portfolio/test/mvp2_mvp3.test.js
// ============================================================

process.env.TZ = "Asia/Tokyo";

const assert = require("node:assert");
const path = require("node:path");
const { loadGas } = require("./gas_mock.js");

const webhookPath = path.resolve(__dirname, "../line-daily-report/webhook.js");
const billingPath = path.resolve(__dirname, "../line-daily-report/billing.js");

// Column-accurate headers (copied from the source files).
const HEADERS_DAILY_REPORT = [
  "管理ID", "日付", "年月", "取引先", "契約種別", "勤務体系",
  "現場", "職人名", "人工", "残業時間", "元メッセージID",
  "登録日時", "判定方法", "確認状態", "AI要約",
];
const HEADERS_CLIENT_MASTER = [
  "取引先", "現場", "単価", "住所", "請求日ルール", "別名", "備考",
];
const HEADERS_EXPENSE = [
  "日付", "取引先", "現場", "職人名", "種別", "金額", "請求対象", "元メッセージID", "登録方法", "備考",
];
const HEADERS_BILLING_SUMMARY = [
  "対象月", "取引先", "常用_人工合計", "残業合計h", "夜勤日数",
  "常用請求額", "請負請求額", "経費請求額", "合計請求額",
  "請求日", "ステータス", "単価未設定", "生成日時",
];

// ------------------------------------------------------------
// Tiny runner (assertion-counting)
// ------------------------------------------------------------
let passed = 0, failed = 0, assertionCount = 0;
const A = new Proxy(assert, {
  get(target, prop) {
    const orig = target[prop];
    if (typeof orig === "function") {
      return (...args) => { assertionCount++; return orig.apply(target, args); };
    }
    return orig;
  },
});
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (err) { failed++; console.log(`  FAIL- ${name}\n        ${err && err.message}`); }
}
const nonEmpty = (rows) => rows.filter((r) => r.some((v) => String(v ?? "").trim()));
const body = (ss, name) => nonEmpty((ss.__data(name) || []).slice(1)); // drop header row

// ------------------------------------------------------------
// Tests
// ------------------------------------------------------------

test("captureExpensesFromText_ : 日報の取引先・現場の文脈に紐付けて経費を登録", () => {
  const { ctx, ss } = loadGas([webhookPath, billingPath], { props: {} });
  ss.__seed("経費", [HEADERS_EXPENSE]);

  const text = [
    "3月18日(水)",
    "サンプル取引先",
    "サンプル現場",
    "田中 1",
    "パーキング1200",
    "ガソリン代3000円",
  ].join("\n");
  const ts = new Date(2026, 2, 18, 12, 0, 0); // handleLineEvent passes a Date

  const n = ctx.captureExpensesFromText_(text, "MSG1", ts);
  A.strictEqual(n, 2);

  const rows = body(ss, "経費");
  A.strictEqual(rows.length, 2);

  const [p, g] = rows;
  // [日付, 取引先, 現場, 職人, 種別, 金額, 請求対象, 元メッセージID, 登録方法, 備考]
  A.strictEqual(p[0], "2026/03/18");
  A.strictEqual(p[1], "サンプル取引先");
  A.strictEqual(p[2], "サンプル現場");
  A.strictEqual(p[4], "パーキング");
  A.strictEqual(p[5], 1200);
  A.strictEqual(p[6], "請求");
  A.strictEqual(p[7], "MSG1");
  A.strictEqual(p[8], "LINE");

  A.strictEqual(g[4], "ガソリン");
  A.strictEqual(g[5], 3000);
});

test("captureExpensesFromText_ : 経費行が無いメッセージは0件", () => {
  const { ctx, ss } = loadGas([webhookPath, billingPath], { props: {} });
  ss.__seed("経費", [HEADERS_EXPENSE]);
  const text = ["3月18日(水)", "サンプル取引先", "サンプル現場", "田中 1 鈴木 半日"].join("\n");
  const n = ctx.captureExpensesFromText_(text, "MSG2", new Date(2026, 2, 18, 12));
  A.strictEqual(n, 0);
  A.strictEqual(body(ss, "経費").length, 0);
});

test("deleteExpensesByMessageId_ : 同一メッセージIDの経費だけ削除", () => {
  const { ctx, ss } = loadGas([webhookPath, billingPath], { props: {} });
  ss.__seed("経費", [
    HEADERS_EXPENSE,
    ["2026/03/01", "A", "S1", "", "パーキング", 1000, "請求", "M1", "LINE", ""],
    ["2026/03/02", "B", "S2", "", "ガソリン", 2000, "請求", "M2", "LINE", ""],
    ["2026/03/03", "A", "S1", "", "高速", 500, "請求", "M1", "LINE", ""],
  ]);
  const removed = ctx.deleteExpensesByMessageId_("M1");
  A.strictEqual(removed, 2);
  const rows = body(ss, "経費");
  A.strictEqual(rows.length, 1);
  A.strictEqual(rows[0][7], "M2");
});

test("purgeBillingMonth_ : 対象月のみ 経費／請求サマリ からリセット", () => {
  const { ctx, ss } = loadGas([webhookPath, billingPath], { props: {} });
  ss.__seed("経費", [
    HEADERS_EXPENSE,
    ["2026/03/10", "A", "S", "", "パーキング", 1000, "請求", "M1", "LINE", ""],
    ["2026/04/10", "A", "S", "", "パーキング", 1000, "請求", "M2", "LINE", ""],
  ]);
  ss.__seed("請求サマリ", [
    HEADERS_BILLING_SUMMARY,
    ["2026-03", "A", 1, 0, 0, 1000, 0, 0, 1000, "2026/03/31", "未請求", "", "t"],
    ["2026-04", "A", 1, 0, 0, 1000, 0, 0, 1000, "2026/04/30", "未請求", "", "t"],
  ]);

  ctx.purgeBillingMonth_("2026-03");

  const exp = body(ss, "経費");
  A.strictEqual(exp.length, 1);
  A.strictEqual(exp[0][0], "2026/04/10");

  const sum = body(ss, "請求サマリ");
  A.strictEqual(sum.length, 1);
  A.strictEqual(sum[0][0], "2026-04");
});

test("finalizeBillingForMonth_ : 請求サマリを確定する／例外なし", () => {
  const { ctx, ss } = loadGas([webhookPath, billingPath], { props: {} });
  ss.__seed("作業日報", [
    HEADERS_DAILY_REPORT,
    ["id1", new Date(2026, 2, 18, 12, 0, 0), "2026-03", "サンプル取引先", "常用", "",
     "サンプル現場", "田中", 1, 0, "M1", "", "従来ルール", "自動登録", ""],
  ]);
  ss.__seed("取引先マスタ", [
    HEADERS_CLIENT_MASTER,
    ["サンプル取引先", "サンプル現場", 20000, "", "", "", ""],
  ]);

  A.doesNotThrow(() => ctx.finalizeBillingForMonth_("2026-03"));

  const sum = body(ss, "請求サマリ").find((r) => r[1] === "サンプル取引先");
  A.ok(sum, "請求サマリに取引先行がある");
  A.strictEqual(sum[5], 20000); // 常用請求額 = 20000 × 1人工
});

test("handleLineEvent : 送信取消で 作業日報 と 経費 の両方を連動削除", () => {
  const { ctx, ss } = loadGas([webhookPath, billingPath], { props: { LINE_CHANNEL_ACCESS_TOKEN: "t" } });
  ss.__seed("作業日報", [
    HEADERS_DAILY_REPORT,
    ["id1", new Date(2026, 2, 18, 12), "2026-03", "A", "常用", "", "S", "田中", 1, 0, "M9", "", "従来ルール", "自動登録", ""],
  ]);
  ss.__seed("経費", [
    HEADERS_EXPENSE,
    ["2026/03/18", "A", "S", "", "パーキング", 1200, "請求", "M9", "LINE", ""],
  ]);

  const event = {
    type: "unsend",
    timestamp: new Date(2026, 2, 19, 9).getTime(),
    source: { type: "group", groupId: "G1", userId: "U1" },
    unsend: { messageId: "M9" },
  };
  ctx.handleLineEvent(event);

  A.strictEqual(body(ss, "作業日報").length, 0);
  A.strictEqual(body(ss, "経費").length, 0);
  // 処理ログに DELETED 行が残る
  const log = body(ss, "メッセージ処理ログ");
  A.ok(log.some((r) => String(r[5]) === "DELETED" && /経費: 1/.test(String(r[6]))));
});

test("captureExpensesFromText_ : 現場名・人数の誤検知を抑止（漢字区切り/3桁未満は経費にしない）", () => {
  const { ctx, ss } = loadGas([webhookPath, billingPath], { props: {} });
  ss.__seed("経費", [HEADERS_EXPENSE]);
  const text = [
    "3月18日(水)",
    "サンプル取引先",
    "高速道路高架下",   // 現場名に「高速」が含まれる
    "田中 1 鈴木 半日", // 人数
    "第二駐車場 2台",   // 「駐車場」＋小さい数
    "ETC専用 4",        // 「ETC」＋小さい数
  ].join("\n");
  const n = ctx.captureExpensesFromText_(text, "MSGFP", new Date(2026, 2, 18, 12));
  A.strictEqual(n, 0);
  A.strictEqual(body(ss, "経費").length, 0);
});

test("captureExpensesFromText_ : カンマ区切り金額も取り込む", () => {
  const { ctx, ss } = loadGas([webhookPath, billingPath], { props: {} });
  ss.__seed("経費", [HEADERS_EXPENSE]);
  const text = ["3月18日(水)", "サンプル取引先", "サンプル現場", "田中 1", "高速1,500円", "ガソリン12,000"].join("\n");
  const n = ctx.captureExpensesFromText_(text, "MSGC", new Date(2026, 2, 18, 12));
  A.strictEqual(n, 2);
  const rows = body(ss, "経費");
  A.strictEqual(rows[0][5], 1500);
  A.strictEqual(rows[1][5], 12000);
});

test("captureExpensesFromText_ : 自社/自腹マーカーは自社負担、無印は請求", () => {
  const { ctx, ss } = loadGas([webhookPath, billingPath], { props: {} });
  ss.__seed("経費", [HEADERS_EXPENSE]);
  const text = ["3月18日(水)", "サンプル取引先", "サンプル現場", "田中 1", "ガソリン4000 自社", "パーキング1200"].join("\n");
  const n = ctx.captureExpensesFromText_(text, "MSGSB", new Date(2026, 2, 18, 12));
  A.strictEqual(n, 2);
  const rows = body(ss, "経費");
  A.strictEqual(rows.find((r) => r[4] === "ガソリン")[6], "自社負担"); // 請求対象 列
  A.strictEqual(rows.find((r) => r[4] === "パーキング")[6], "請求");
});

test("setupDailyReportCalcColumns_ : 作業日報に単価/請求額の数式列を設置（取引先マスタ参照）", () => {
  const { ctx, ss } = loadGas([webhookPath, billingPath], { props: {} });
  ss.__seed("作業日報", [HEADERS_DAILY_REPORT]);
  ss.__seed("取引先マスタ", [HEADERS_CLIENT_MASTER]);

  const ok = ctx.setupDailyReportCalcColumns_();
  A.strictEqual(ok, true);

  const d = ss.__data("作業日報");
  A.strictEqual(d[0][15], "請求単価(自動)"); // P1
  A.strictEqual(d[0][16], "請求額(自動)");   // Q1
  A.ok(String(d[1][15]).includes("取引先マスタ"));   // P2: 単価VLOOKUP
  A.ok(String(d[1][15]).includes("VLOOKUP"));
  A.ok(String(d[1][16]).includes("1.25"));         // Q2: 残業1.25
  A.ok(String(d[1][16]).includes("請負"));          // 請負は案件別
});

test("captureExpensesFromText_ : 弁当代もパーキング等と同様に経費登録", () => {
  const { ctx, ss } = loadGas([webhookPath, billingPath], { props: {} });
  ss.__seed("経費", [HEADERS_EXPENSE]);
  const text = ["3月18日(水)", "サンプル取引先", "サンプル現場", "田中 1", "弁当代1500"].join("\n");
  const n = ctx.captureExpensesFromText_(text, "MSGB", new Date(2026, 2, 18, 12));
  A.strictEqual(n, 1);
  const row = body(ss, "経費")[0];
  A.strictEqual(row[4], "弁当"); // 種別
  A.strictEqual(row[5], 1500);   // 金額
});

// ------------------------------------------------------------
console.log(`\nTests: ${passed} passed, ${failed} failed (${assertionCount} assertions)`);
process.exit(failed ? 1 : 0);

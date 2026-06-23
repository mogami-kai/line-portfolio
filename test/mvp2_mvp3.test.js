// ============================================================
// Unit tests for the MVP-2 / MVP-3 additions:
//   billing.js : captureExpensesFromText_, deleteExpensesByMessageId_,
//                purgeBillingMonth_, finalizeBillingForMonth_
//   webhook.js : handleLineEvent unsend hook (報告＋経費の連動削除)
//   billing_freee.js : freeeCreateInvoices_ safe-skip when unconfigured
//   + all four GAS files coexist in one shared scope (as GAS loads them)
//
//   node /home/user/line-portfolio/test/mvp2_mvp3.test.js
// ============================================================

process.env.TZ = "Asia/Tokyo";

const assert = require("node:assert");
const path = require("node:path");
const { loadGas } = require("./gas_mock.js");

const webhookPath = path.resolve(__dirname, "../line-daily-report/webhook.js");
const billingPath = path.resolve(__dirname, "../line-daily-report/billing.js");
const freeePath   = path.resolve(__dirname, "../line-daily-report/billing_freee.js");

// Column-accurate headers (copied from the source files).
const HEADERS_DAILY_REPORT = [
  "管理ID", "日付", "年月", "取引先", "契約種別", "勤務体系",
  "現場", "職人名", "人工", "残業時間", "元メッセージID",
  "登録日時", "判定方法", "確認状態", "AI要約",
];
const HEADERS_RATE_MASTER = [
  "取引先", "現場", "契約種別", "請求単価", "残業係数", "夜勤割増", "適用開始日", "備考",
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

test("purgeBillingMonth_ : 対象月のみ 経費／請求サマリ／freee取込 からリセット", () => {
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
  ss.__seed("freee取込", [
    HEADERS_FREEE,
    ["2026-03", "A", "2026/03/31", "2026/03/31", "出面（常用）", 1, 1000, 1000, ""],
    ["2026-04", "A", "2026/04/30", "2026/04/30", "出面（常用）", 1, 1000, 1000, ""],
  ]);

  ctx.purgeBillingMonth_("2026-03");

  const exp = body(ss, "経費");
  A.strictEqual(exp.length, 1);
  A.strictEqual(exp[0][0], "2026/04/10");

  const sum = body(ss, "請求サマリ");
  A.strictEqual(sum.length, 1);
  A.strictEqual(sum[0][0], "2026-04");

  const fr = body(ss, "freee取込");
  A.strictEqual(fr.length, 1);
  A.strictEqual(fr[0][0], "2026-04");
});

test("finalizeBillingForMonth_ : 請求サマリ＋freee取込を確定生成し、未設定freeeはスキップで例外なし", () => {
  const { ctx, ss } = loadGas([webhookPath, billingPath], { props: {} });
  ss.__seed("作業日報", [
    HEADERS_DAILY_REPORT,
    ["id1", new Date(2026, 2, 18, 12, 0, 0), "2026-03", "サンプル取引先", "常用", "",
     "サンプル現場", "田中", 1, 0, "M1", "", "従来ルール", "自動登録", ""],
  ]);
  ss.__seed("単価マスタ", [
    HEADERS_RATE_MASTER,
    ["サンプル取引先", "サンプル現場", "常用", 20000, 1.25, 0, "", ""],
  ]);

  // freeeCreateInvoices_ は未ロード → typeof ガードでスキップ。例外を投げないこと。
  A.doesNotThrow(() => ctx.finalizeBillingForMonth_("2026-03"));

  const sum = body(ss, "請求サマリ").find((r) => r[1] === "サンプル取引先");
  A.ok(sum, "請求サマリに取引先行がある");
  A.strictEqual(sum[5], 20000); // 常用請求額 = 20000 × 1人工

  const fr = body(ss, "freee取込");
  A.ok(fr.some((r) => r[1] === "サンプル取引先" && r[4] === "出面（常用）"));
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

test("4ファイルが単一スコープで共存する（GASのロード再現）＋ 未設定freeeは安全スキップ", () => {
  // webhook + billing + billing_freee を1スコープに連結。
  // 重複 const 宣言などがあればここで SyntaxError になる。
  const { ctx } = loadGas([webhookPath, billingPath, freeePath], { props: {} });
  A.strictEqual(typeof ctx.freeeCreateInvoices_, "function");
  const res = ctx.freeeCreateInvoices_("2026-03");
  A.strictEqual(res.skipped, true); // FREEE_ACCESS_TOKEN / COMPANY_ID 未設定 → スキップ
});

// ------------------------------------------------------------
console.log(`\nTests: ${passed} passed, ${failed} failed (${assertionCount} assertions)`);
process.exit(failed ? 1 : 0);

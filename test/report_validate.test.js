// ============================================================
// report_validate.js（日報バリデーション/聞き返し判定）の単体テスト。
// 運用で実際に起きたエラーパターンを、ダミー名で再現して検証する。
//   node test/report_validate.test.js
// ============================================================

process.env.TZ = "Asia/Tokyo";

const assert = require("node:assert");
const path = require("node:path");
const { loadGas } = require("./gas_mock.js");

const validatePath = path.resolve(__dirname, "../line-daily-report/report_validate.js");

let passed = 0, failed = 0, assertionCount = 0;
const A = new Proxy(assert, {
  get(t, k) {
    const o = t[k];
    return typeof o === "function" ? (...a) => { assertionCount++; return o.apply(t, a); } : o;
  },
});
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { failed++; console.log(`  FAIL- ${name}\n        ${e && e.stack ? e.stack.split("\n").join("\n        ") : e}`); }
}

const { ctx } = loadGas([validatePath], { props: {} });
const REF = new Date(2026, 2, 15, 12, 0, 0); // 2026-03-15 を基準日に

// 既知の取引先（ダミー正式名）＋別名解決のスタブ
const CANON = ["MELO", "丸栄工業", "あおぞら設備", "ひかり建設", "なかむら組"];
const ALIAS = { "melo": "MELO", "丸栄工業": "丸栄工業", "あおぞら設備": "あおぞら設備",
                "ひかり建設": "ひかり建設", "なかむら組": "なかむら組" };
const resolve = (raw) => ALIAS[ctx.normalizeNameKey_(raw)] || (CANON.includes(String(raw).trim()) ? String(raw).trim() : "");

// ============================================================
// 1. 取引先（表記揺れ＝ローマ字 L/R・末尾ゆれ・漢字1字違い 工/興）
// ============================================================
test("取引先: 正式名・別名は ok / 表記揺れは confirm(候補提示) / 新規は hold", () => {
  A.strictEqual(ctx.validateClientField_("MELO", CANON, resolve).status, "ok");
  A.strictEqual(ctx.validateClientField_("melo", CANON, resolve).status, "ok"); // 別名(小文字)

  const lr = ctx.validateClientField_("MERO", CANON, resolve); // L/R ゆれ
  A.strictEqual(lr.status, "confirm");
  A.strictEqual(lr.suggestion, "MELO", "MERO→MELO の表記揺れを提案");

  const tail = ctx.validateClientField_("MELL", CANON, resolve); // 末尾ゆれ
  A.strictEqual(tail.status, "confirm");
  A.strictEqual(tail.suggestion, "MELO");

  const kanji = ctx.validateClientField_("丸栄興業", CANON, resolve); // 工 vs 興（1字違い）
  A.strictEqual(kanji.status, "confirm");
  A.strictEqual(kanji.suggestion, "丸栄工業");

  A.strictEqual(ctx.validateClientField_("知らない会社", CANON, resolve).status, "hold");
  A.strictEqual(ctx.validateClientField_("", CANON, resolve).status, "hold");
});

// ============================================================
// 2. 日付（1/8 を 11/8、未来日、存在しない日、多様な表記）
// ============================================================
test("日付: 多様な表記を解釈 / 未来日・古すぎ・不正日は confirm or hold", () => {
  A.strictEqual(ctx.validateDateField_("3月14日", REF).status, "ok");
  A.strictEqual(ctx.validateDateField_("3/14", REF).status, "ok");
  A.strictEqual(ctx.validateDateField_("2026/3/14", REF).status, "ok");
  A.strictEqual(ctx.validateDateField_("3/10(火)", REF).value, "2026-03-10"); // 曜日付き

  // 1/8 のつもりで 11/8 → 未来日として confirm（典型ミス）
  const wrongMonth = ctx.validateDateField_("11月8日", REF);
  A.strictEqual(wrongMonth.status, "confirm");

  // 未来日
  A.strictEqual(ctx.validateDateField_("3月25日", REF).status, "confirm");
  // 存在しない日（2026は閏年でない）
  A.strictEqual(ctx.validateDateField_("2月29日", REF).status, "hold");
  // 読み取れない
  A.strictEqual(ctx.validateDateField_("きのう", REF).status, "hold");
});

// ============================================================
// 3. 人工 / 4. 残業
// ============================================================
test("人工: 0.5/0.75/1 は ok / >1 は confirm / 0・非数値は hold", () => {
  A.strictEqual(ctx.validateQtyField_(0.5).status, "ok");
  A.strictEqual(ctx.validateQtyField_(0.75).status, "ok");
  A.strictEqual(ctx.validateQtyField_(1).status, "ok");
  A.strictEqual(ctx.validateQtyField_(1.5).status, "confirm");
  A.strictEqual(ctx.validateQtyField_(2.5).status, "confirm");
  A.strictEqual(ctx.validateQtyField_(0).status, "hold");
  A.strictEqual(ctx.validateQtyField_("x").status, "hold");
});

test("残業: 0〜3h は ok / それ以上は confirm / 負・非数値は hold", () => {
  A.strictEqual(ctx.validateOtField_(0).status, "ok");
  A.strictEqual(ctx.validateOtField_(1).status, "ok");
  A.strictEqual(ctx.validateOtField_(3).status, "ok");
  A.strictEqual(ctx.validateOtField_(5).status, "confirm");
  A.strictEqual(ctx.validateOtField_(10).status, "confirm");
  A.strictEqual(ctx.validateOtField_(-1).status, "hold");
});

// ============================================================
// 5. 職人名（「職人A半日」のようなスペース抜けでのマーカー食い込み）
// ============================================================
test("職人名: マーカー/数字の食い込みを confirm（名前＋半日/残業/数字）", () => {
  A.strictEqual(ctx.validateWorkerName_("職人A").status, "ok");
  A.strictEqual(ctx.validateWorkerName_("職人A半日").status, "confirm");
  A.strictEqual(ctx.validateWorkerName_("職人A1").status, "confirm");
  A.strictEqual(ctx.validateWorkerName_("職人A残業1").status, "confirm");
});

// ============================================================
// 6. 行・レポート総合判定
// ============================================================
test("行判定: 全項目正常は ok / 1つでも怪しいと confirm or hold", () => {
  const ok = ctx.validateRow_(
    { client: "MELO", date: "3月14日", worker: "職人B", qty: 1, ot: 0 },
    { canonicals: CANON, resolveClient: resolve, refDate: REF }
  );
  A.strictEqual(ok.status, "ok");

  const conf = ctx.validateRow_(
    { client: "MERO", date: "3月14日", worker: "職人B", qty: 1, ot: 0 }, // 取引先ゆれ
    { canonicals: CANON, resolveClient: resolve, refDate: REF }
  );
  A.strictEqual(conf.status, "confirm");

  const held = ctx.validateRow_(
    { client: "知らない", date: "2月29日", worker: "職人B", qty: 1, ot: 0 }, // 新規＋不正日
    { canonicals: CANON, resolveClient: resolve, refDate: REF }
  );
  A.strictEqual(held.status, "hold");
});

test("レポート判定: 同一現場で同じ職人が重複したら confirm", () => {
  const rows = [
    { client: "MELO", site: "現場X", date: "3月14日", worker: "職人A", qty: 1, ot: 0 },
    { client: "MELO", site: "現場X", date: "3月14日", worker: "職人A", qty: 1, ot: 0 }, // 同じ人が2回
  ];
  const rep = ctx.validateReportRows_(rows, { canonicals: CANON, resolveClient: resolve, refDate: REF });
  A.strictEqual(rep.status, "confirm");
  const msg = ctx.buildAskbackMessage_(rep);
  A.ok(/重複/.test(msg), "聞き返し文に重複の指摘が含まれる");
});

test("聞き返し文: 正常レポートは空文字（聞かない）", () => {
  const rows = [{ client: "MELO", site: "現場X", date: "3月14日", worker: "職人B", qty: 1, ot: 0 }];
  const rep = ctx.validateReportRows_(rows, { canonicals: CANON, resolveClient: resolve, refDate: REF });
  A.strictEqual(rep.status, "ok");
  A.strictEqual(ctx.buildAskbackMessage_(rep), "");
});

// ============================================================
console.log(`\nTests: ${passed} passed, ${failed} failed (${assertionCount} assertions)`);
process.exit(failed ? 1 : 0);

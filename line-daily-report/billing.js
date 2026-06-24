// ============================================================
// 【ファイル4】請求・経費 自動化（MVP）
// 元請けごとの請求集計・単価マスタ・経費・freee取込データ生成
// ============================================================
// 既存の webhook（ファイル1）・management（ファイル2）には手を入れず、
// このファイルを追加するだけで動きます。
//
// 依存（ファイル1で定義済みのグローバル）:
//   TZ / CONFIG / HEADERS_DAILY_REPORT /
//   prop_ / appendProcessLog_ / ymFromDateCell_ /
//   normalizeContractType / toNumber
//
// セットアップ手順:
//   1) このファイルを Apps Script プロジェクトに追加
//   2) setupBillingSheets を1回実行（マスタ／サマリのシートを作成）
//   3) 単価マスタにサンプル行を消して実単価を入力
//   4) メニュー「請求・経費」→「請求サマリを作成」
//      ※メニューを出すには、既存 onOpen（ファイル2）の末尾に1行だけ追加:
//          addBillingMenu_(SpreadsheetApp.getUi());
//      （メニューを使わず Apps Script エディタの実行ボタンから動かしてもOK）
// ============================================================

const BILLING = {
  sheetClientMaster: "取引先マスタ",
  sheetRateMaster:   "単価マスタ",
  sheetLumpSum:      "請負案件マスタ",
  sheetExpense:      "経費",
  sheetSummary:      "請求サマリ",
  sheetFreee:        "freee取込",

  defaultOtFactor:    1.25, // 残業係数（請求単価 ÷ 8 × 係数 / h）
  defaultHoursPerDay: 8,
};

const HEADERS_CLIENT_MASTER = [
  "取引先", "別名", "締め日", "請求日ルール", "freee取引先ID", "振込先メモ", "備考",
];

const HEADERS_RATE_MASTER = [
  "取引先", "現場", "契約種別", "請求単価", "残業係数", "夜勤割増", "適用開始日", "備考",
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

// ============================================================
// 初期セットアップ（導入時に1回だけ実行）
// ============================================================

function setupBillingSheets() {
  billingSheet_(BILLING.sheetClientMaster, HEADERS_CLIENT_MASTER, (s) => {
    s.appendRow(["サンプル取引先", "サンプル商事,サンプル建設", "末", "末日", "", "", "← この行は削除して実データを入れてください"]);
  });

  billingSheet_(BILLING.sheetRateMaster, HEADERS_RATE_MASTER, (s) => {
    s.appendRow(["サンプル取引先", "",          "常用", 20000, BILLING.defaultOtFactor, 0, "", "現場空欄＝取引先の既定単価"]);
    s.appendRow(["サンプル取引先", "サンプル現場", "常用", 22000, BILLING.defaultOtFactor, 0, "", "現場ごとに上書きできる"]);
  });

  billingSheet_(BILLING.sheetLumpSum, HEADERS_LUMPSUM, (s) => {
    const ym = Utilities.formatDate(new Date(), TZ, "yyyy-MM");
    s.appendRow(["サンプル取引先", "サンプル案件", 500000, ym, "未請求", "請負は人工ではなく契約金額で請求"]);
  });

  billingSheet_(BILLING.sheetExpense, HEADERS_EXPENSE, null);
  billingSheet_(BILLING.sheetSummary, HEADERS_BILLING_SUMMARY, null);
  billingSheet_(BILLING.sheetFreee,   HEADERS_FREEE, null);

  SpreadsheetApp.getUi().alert(
    "✅ 請求・経費シートを準備しました\n\n" +
    "作成/確認したシート:\n" +
    "  ・取引先マスタ（別名で名寄せ／請求日ルール）\n" +
    "  ・単価マスタ（取引先×現場×契約種別の請求単価）\n" +
    "  ・請負案件マスタ（請負＝契約金額で請求）\n" +
    "  ・経費（パーキング/ガソリン等。請求対象フラグ付き）\n" +
    "  ・請求サマリ（自動生成）\n" +
    "  ・freee取込（自動生成）\n\n" +
    "次の手順:\n" +
    "  1) 単価マスタのサンプル行を消して実単価を入力\n" +
    "  2) メニュー『請求・経費』→『請求サマリを作成』\n\n" +
    "※メニューを出すには、既存 onOpen の末尾に\n" +
    "    addBillingMenu_(SpreadsheetApp.getUi());\n" +
    "  を1行追加してください。"
  );
}

function billingSheet_(name, headers, fillSamples) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  const row1 = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (!row1.some((v) => String(v ?? "").trim())) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    if (fillSamples) fillSamples(sheet);
  }
  return sheet;
}

// ============================================================
// スプレッドシートUIメニュー（手動実行用）
// 既存 onOpen の中で addBillingMenu_(SpreadsheetApp.getUi()) を呼ぶ
// ============================================================

function addBillingMenu_(ui) {
  const menu = ui.createMenu("請求・経費")
    .addItem("請求サマリを作成（今月）", "createBillingSummaryThisMonth")
    .addItem("請求サマリを作成（先月）", "createBillingSummaryPrevMonth")
    .addSeparator()
    .addItem("請求書PDFを発行（今月）", "issueInvoicesThisMonth")
    .addItem("請求書PDFを発行（先月）", "issueInvoicesPrevMonth");
  // freee連携を使うときだけ（FREEE_ENABLED=TRUE）freeeメニューを表示
  if (freeeEnabled_()) {
    menu.addSeparator()
      .addItem("freee取込データを作成（今月）", "exportFreeeThisMonth")
      .addItem("freee取込データを作成（先月）", "exportFreeePrevMonth");
  }
  menu.addToUi();
}

function createBillingSummaryThisMonth() { runBillingSummaryForOffset_(0); }
function createBillingSummaryPrevMonth() { runBillingSummaryForOffset_(-1); }
function exportFreeeThisMonth()          { runFreeeExportForOffset_(0); }
function exportFreeePrevMonth()          { runFreeeExportForOffset_(-1); }

function ymForMonthOffset_(offset) {
  const now = new Date();
  const d   = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return Utilities.formatDate(d, TZ, "yyyy-MM");
}

function runBillingSummaryForOffset_(offset) {
  const ui = SpreadsheetApp.getUi();
  const ym = ymForMonthOffset_(offset);
  try {
    const res = buildBillingSummary_(ym);
    let msg = `✅ ${ym} の請求サマリを作成しました\n\n` +
      `取引先数: ${res.clientCount}\n` +
      `合計請求額: ¥${Math.round(res.totalAmount).toLocaleString()}`;
    if (res.missing.length > 0) {
      msg += "\n\n⚠️ 単価未設定（請求額に未反映）:\n" +
        res.missing.map((m) => `  ・${m}`).join("\n") +
        "\n→ 単価マスタに追加して再実行してください";
    }
    ui.alert(msg);
  } catch (err) {
    ui.alert(`❌ 請求サマリ作成でエラー\n\n${err && err.stack ? err.stack : err}`);
  }
}

function runFreeeExportForOffset_(offset) {
  const ui = SpreadsheetApp.getUi();
  const ym = ymForMonthOffset_(offset);
  try {
    const n = exportFreee_(ym);
    ui.alert(
      `✅ ${ym} のfreee取込データを作成しました（${n}品目）\n\n` +
      `「${BILLING.sheetFreee}」シートを\n` +
      `ファイル → ダウンロード → CSV で書き出して\n` +
      `freee請求書にインポートしてください。`
    );
  } catch (err) {
    ui.alert(`❌ freee取込データ作成でエラー\n\n${err && err.stack ? err.stack : err}`);
  }
}

// ============================================================
// マスタ読み込み・名寄せ・単価ルックアップ
// ============================================================

let _clientAliasMap  = null; // alias(lower) -> canonical
let _clientMasterMap = null; // canonical -> master row object
let _rateRows        = null; // [{client, site, type, unit, otFactor, nightAdd, from}]

function resetBillingCache_() {
  _clientAliasMap  = null;
  _clientMasterMap = null;
  _rateRows        = null;
}

function readSheetObjects_(name, headers) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  return values
    .filter((r) => r.some((v) => String(v ?? "").trim()))
    .map((r) => {
      const o = {};
      headers.forEach((h, i) => { o[h] = r[i]; });
      return o;
    });
}

function clientAliasMap_() {
  if (_clientAliasMap) return _clientAliasMap;
  const map = {};
  for (const c of readSheetObjects_(BILLING.sheetClientMaster, HEADERS_CLIENT_MASTER)) {
    const canonical = String(c["取引先"] ?? "").trim();
    if (!canonical) continue;
    map[canonical.toLowerCase()] = canonical;
    String(c["別名"] ?? "")
      .split(/[,、\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((alias) => { map[alias.toLowerCase()] = canonical; });
  }
  _clientAliasMap = map;
  return map;
}

function clientMasterMap_() {
  if (_clientMasterMap) return _clientMasterMap;
  const map = {};
  for (const c of readSheetObjects_(BILLING.sheetClientMaster, HEADERS_CLIENT_MASTER)) {
    const canonical = String(c["取引先"] ?? "").trim();
    if (canonical) map[canonical] = c;
  }
  _clientMasterMap = map;
  return map;
}

// 表記揺れ（MALU/MARU/マル 等）を取引先マスタの別名で正規化
function canonicalClient_(name) {
  const key = String(name ?? "").trim().toLowerCase();
  if (!key) return "";
  return clientAliasMap_()[key] || String(name ?? "").trim();
}

function parseMasterDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function rateRows_() {
  if (_rateRows) return _rateRows;
  _rateRows = readSheetObjects_(BILLING.sheetRateMaster, HEADERS_RATE_MASTER).map((r) => ({
    client:   canonicalClient_(r["取引先"]),
    site:     String(r["現場"] ?? "").trim(),
    type:     normalizeContractType(r["契約種別"], "常用"),
    unit:     toNumber(r["請求単価"], 0),
    otFactor: toNumber(r["残業係数"], BILLING.defaultOtFactor),
    nightAdd: toNumber(r["夜勤割増"], 0),
    from:     parseMasterDate_(r["適用開始日"]),
  }));
  return _rateRows;
}

// 取引先×現場×契約種別で単価を引く。
// 現場一致 → 取引先の既定（現場空欄）の順、適用開始日は新しいものを優先。
function lookupRate_(client, site, type, dateObj) {
  const canonical = canonicalClient_(client);
  const siteTrim  = String(site ?? "").trim();
  const t         = normalizeContractType(type, "常用");

  const candidates = rateRows_().filter((r) =>
    r.client === canonical &&
    r.type === t &&
    (r.site === siteTrim || r.site === "") &&
    (!r.from || !dateObj || r.from.getTime() <= dateObj.getTime())
  );
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const siteScore = (b.site === siteTrim ? 1 : 0) - (a.site === siteTrim ? 1 : 0);
    if (siteScore !== 0) return siteScore;
    return (b.from ? b.from.getTime() : 0) - (a.from ? a.from.getTime() : 0);
  });
  return candidates[0];
}

// ============================================================
// 請求サマリ生成（当月の作業日報＋請負＋経費を取引先ごとに集計）
// ============================================================

function buildBillingSummary_(ym) {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const report = ss.getSheetByName(CONFIG.sheetReport);
  if (!report) throw new Error(`${CONFIG.sheetReport} シートが見つかりません`);

  resetBillingCache_(); // マスタ更新を反映

  const acc = {};
  const ensure = (client) => {
    if (!acc[client]) {
      acc[client] = { manDays: 0, otHours: 0, nightDays: 0, joyo: 0, lump: 0, expense: 0, missing: new Set() };
    }
    return acc[client];
  };

  // ── 常用：作業日報から人工・残業・夜勤を集計し請求額を計算 ──
  if (report.getLastRow() >= 2) {
    const rows = report.getRange(2, 1, report.getLastRow() - 1, HEADERS_DAILY_REPORT.length).getValues();
    for (const row of rows) {
      if (!row[1] || ymFromDateCell_(row[1]) !== String(ym).trim()) continue;
      if (normalizeContractType(row[4], "常用") !== "常用") continue; // 請負は案件マスタで計上

      const dateObj = row[1] instanceof Date ? row[1] : new Date(row[1]);
      const client  = canonicalClient_(row[3]);
      const site    = String(row[6] ?? "").trim();
      const qty     = toNumber(row[8], 0);
      const ot      = toNumber(row[9], 0);
      const isNight = String(row[5] ?? "").includes("夜勤");
      if (!client) continue;

      const a = ensure(client);
      a.manDays += qty;
      a.otHours += ot;
      if (isNight) a.nightDays += 1;

      const rate = lookupRate_(client, site, "常用", dateObj);
      if (!rate || rate.unit <= 0) {
        a.missing.add(site || "(現場未指定)");
        continue;
      }
      const base    = rate.unit * qty;
      const otAmt   = (rate.unit / BILLING.defaultHoursPerDay) * rate.otFactor * ot;
      const nightUp = isNight ? rate.nightAdd : 0;
      a.joyo += base + otAmt + nightUp;
    }
  }

  // ── 請負：案件マスタの契約金額を計上 ──
  for (const r of readSheetObjects_(BILLING.sheetLumpSum, HEADERS_LUMPSUM)) {
    if (String(r["計上月"] ?? "").trim() !== String(ym).trim()) continue;
    const client = canonicalClient_(r["取引先"]);
    if (!client) continue;
    ensure(client).lump += toNumber(r["契約金額"], 0);
  }

  // ── 経費：請求対象のみ取引先ごとに合算 ──
  for (const e of readSheetObjects_(BILLING.sheetExpense, HEADERS_EXPENSE)) {
    if (!e["日付"] || ymFromDateCell_(e["日付"]) !== String(ym).trim()) continue;
    if (!String(e["請求対象"] ?? "").includes("請求")) continue; // 「自社負担」は集計のみ
    const client = canonicalClient_(e["取引先"]);
    if (!client) continue;
    ensure(client).expense += toNumber(e["金額"], 0);
  }

  // ── 請求サマリへ出力（対象月ぶんを置き換え） ──
  const now     = Utilities.formatDate(new Date(), TZ, "yyyy/MM/dd HH:mm:ss");
  const clients = Object.keys(acc).sort();
  const outRows = clients.map((client) => {
    const a       = acc[client];
    const total   = a.joyo + a.lump + a.expense;
    const missing = a.missing.size > 0 ? [...a.missing].join(" / ") : "";
    return [
      ym, client, a.manDays, a.otHours, a.nightDays,
      Math.round(a.joyo), Math.round(a.lump), Math.round(a.expense), Math.round(total),
      computeBillingDate_(ym, client), "未請求", missing, now,
    ];
  });
  replaceMonthRows_(BILLING.sheetSummary, HEADERS_BILLING_SUMMARY, ym, outRows);

  const totalAmount = outRows.reduce((s, r) => s + Number(r[8] || 0), 0);
  const missingAll  = clients
    .filter((c) => acc[c].missing.size > 0)
    .map((c) => `${c}: ${[...acc[c].missing].join(" / ")}`);

  appendProcessLog_(
    new Date(), "", "", "",
    `[BILLING_SUMMARY] ${ym}`, "SUCCESS_BILLING",
    `clients=${clients.length} total=${totalAmount} missing=${missingAll.length}`
  );

  return { clientCount: clients.length, totalAmount, missing: missingAll };
}

// 請求日（=請求期限）。既定は月末。取引先マスタの請求日ルールが数字ならその日（月末でクランプ）。
function computeBillingDate_(ym, client) {
  const m = String(ym).match(/^(\d{4})-(\d{2})$/);
  if (!m) return "";
  const y = Number(m[1]), mo = Number(m[2]);
  const lastDay = new Date(y, mo, 0).getDate();

  let day = lastDay;
  const cm = clientMasterMap_()[client];
  if (cm) {
    const num = parseInt(String(cm["請求日ルール"] ?? "").trim(), 10);
    if (!isNaN(num) && num >= 1 && num <= 31) day = Math.min(num, lastDay);
  }
  return Utilities.formatDate(new Date(y, mo - 1, day), TZ, "yyyy/MM/dd");
}

// 対象月（A列）ぶんを置き換えて書き戻す（再実行で二重にならない）
function replaceMonthRows_(name, headers, ym, newRows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }

  const keep = [];
  if (sheet.getLastRow() >= 2) {
    const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
    for (const r of vals) {
      if (r.some((v) => String(v ?? "").trim()) && String(r[0]).trim() !== String(ym).trim()) {
        keep.push(r);
      }
    }
    sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).clearContent();
  }

  const all = keep.concat(newRows);
  if (all.length > 0) sheet.getRange(2, 1, all.length, headers.length).setValues(all);
}

// ============================================================
// freee取込データ生成（請求サマリ → 取引先ごとの品目明細）
// ============================================================

// セル値を yyyy/MM/dd へ正規化する。
// スプレッドシートは "2026/03/31" のような文字列を書き込むと自動で Date 値に変換する
// ことがあり、その場合 String() すると "Tue Mar 31 2026 ..." になってしまう。
// Date でも文字列でも一貫して yyyy/MM/dd を返す。
function dateCellToYmd_(v) {
  if (v instanceof Date) {
    return isNaN(v.getTime()) ? "" : Utilities.formatDate(v, TZ, "yyyy/MM/dd");
  }
  const s = String(v ?? "").trim();
  if (!s) return "";
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : Utilities.formatDate(d, TZ, "yyyy/MM/dd");
}

function exportFreee_(ym) {
  const summary = readSheetObjects_(BILLING.sheetSummary, HEADERS_BILLING_SUMMARY)
    .filter((r) => String(r["対象月"] ?? "").trim() === String(ym).trim());
  if (summary.length === 0) {
    throw new Error(`${ym} の請求サマリがありません。先に「請求サマリを作成」を実行してください。`);
  }

  const rows = [];
  for (const s of summary) {
    const client      = String(s["取引先"] ?? "").trim();
    const billingDate = dateCellToYmd_(s["請求日"]); // Sheetsが日付をDate化しても yyyy/MM/dd に統一
    const manDays     = toNumber(s["常用_人工合計"], 0);
    const joyo        = toNumber(s["常用請求額"], 0);
    const lump        = toNumber(s["請負請求額"], 0);
    const exp         = toNumber(s["経費請求額"], 0);

    // 請求日＝請求期限（同日）
    if (joyo > 0) {
      const unit = manDays > 0 ? Math.round(joyo / manDays) : joyo;
      rows.push([ym, client, billingDate, billingDate, "出面（常用）", manDays, unit, joyo, "人工合計に基づく請求"]);
    }
    if (lump > 0) {
      rows.push([ym, client, billingDate, billingDate, "請負工事一式", 1, lump, lump, "請負案件"]);
    }
    if (exp > 0) {
      rows.push([ym, client, billingDate, billingDate, "立替経費（駐車/燃料等）", 1, exp, exp, "経費"]);
    }
  }

  replaceMonthRows_(BILLING.sheetFreee, HEADERS_FREEE, ym, rows);
  return rows.length;
}

// ============================================================
// 任意（MVP-2）: 経費の手動登録 ＆ LINE本文からの抽出ユーティリティ
// ・手動登録: addExpenseRow_(...) を実行、または「経費」シートに直接入力
// ・LINE自動取込にする場合は webhook の processReport 内などから
//   extractExpensesFromText_(text) を呼んで addExpenseRow_ で書き込む
// ============================================================

// キーワードと金額の間は「代/金/料/:/￥/空白」等の短い連結のみ許可し、金額は3桁以上
// （≥100円）に限定する。これで現場名や人数（「高速道路高架下 5名」「第二駐車場 2台」）を
// 経費と誤検知して請求額を水増しするのを防ぐ。
const EXPENSE_CONNECTOR = "[\\s\\u3000代金料:：¥￥]*";
const EXPENSE_AMOUNT    = "([0-9][0-9,]{2,})"; // 3桁以上（カンマ区切り可）
const EXPENSE_PATTERNS = [
  { 種別: "パーキング", re: new RegExp(`(?:パーキング|駐車場?|ﾊﾟｰｷﾝｸﾞ|コインP|P代)${EXPENSE_CONNECTOR}${EXPENSE_AMOUNT}\\s*円?`, "i") },
  { 種別: "ガソリン",   re: new RegExp(`(?:ガソリン|燃料|給油|ｶﾞｿﾘﾝ)${EXPENSE_CONNECTOR}${EXPENSE_AMOUNT}\\s*円?`, "i") },
  { 種別: "高速",       re: new RegExp(`(?:高速|有料道路|ETC)${EXPENSE_CONNECTOR}${EXPENSE_AMOUNT}\\s*円?`, "i") },
];

// 経費行に「自社/自腹/自費」等があれば自社負担、無ければ請求対象（既定）。
// freeeへの請求水増しを避けつつ、現場の書き方で請求/自社を切り替えられる。
const SELF_BORNE_MARKERS = ["自社", "自腹", "自費", "請求しない", "請求不要", "経費なし"];
const isSelfBorneExpenseLine_ = (line) =>
  SELF_BORNE_MARKERS.some((k) => String(line ?? "").includes(k));

function extractExpensesFromText_(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r\n|\r|\n/)) {
    for (const p of EXPENSE_PATTERNS) {
      const m = line.match(p.re);
      if (m) {
        const amount = parseInt(String(m[1]).replace(/,/g, ""), 10);
        if (!isNaN(amount) && amount > 0) out.push({ 種別: p.種別, 金額: amount });
      }
    }
  }
  return out;
}

function addExpenseRow_(date, client, site, worker, type, amount, billable, messageId, via) {
  const sheet = billingSheet_(BILLING.sheetExpense, HEADERS_EXPENSE, null);
  sheet.appendRow([
    date || "",
    client || "",
    site || "",
    worker || "",
    type || "",
    toNumber(amount, 0),
    billable ? "請求" : "自社負担",
    messageId || "",
    via || "手動",
    "",
  ]);
}

// ============================================================
// MVP-2: LINEメッセージからの経費自動取込
// webhook（ファイル1）の handleLineEvent から呼ばれる。
// 日報ブロックの文脈（日付→取引先→現場）を辿りながら経費行を拾う。
// 既存の parseDate / parseClientLine / removeWorkShiftText（ファイル1）を再利用。
// ============================================================

function captureExpensesFromText_(text, messageId, ts) {
  const base = ts instanceof Date ? ts : new Date(ts); // 受信時刻（日付の年推定の基準）
  const lines = String(text ?? "")
    .split(/\r\n|\r|\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  let curDate = null, curClient = "", curSite = "", phase = "date";
  let count = 0;

  for (const line of lines) {
    // 日付行 → ブロックの先頭。文脈をリセット
    const d = parseDate(line, base);
    if (d) { curDate = d; curClient = ""; curSite = ""; phase = "client"; continue; }

    // 経費行（パーキング/ガソリン/高速）→ 現在の取引先・現場に紐付けて登録
    const exps = extractExpensesFromText_(line);
    if (exps.length > 0) {
      // 取引先が未確定（ブロック先頭前）の経費は帰属できないため記録しない
      if (!curClient) continue;
      const dateStr  = Utilities.formatDate(curDate || base, TZ, "yyyy/MM/dd");
      // 既定は「請求」（立替を元請けに請求）。行に自社/自腹/自費があれば自社負担
      const billable = !isSelfBorneExpenseLine_(line);
      for (const e of exps) {
        addExpenseRow_(dateStr, curClient, curSite, "", e["種別"], e["金額"], billable, messageId, "LINE");
        count++;
      }
      continue;
    }

    if (phase === "client") {
      const { clientName, siteName } = parseClientLine(line);
      curClient = clientName;
      if (siteName) { curSite = removeWorkShiftText(siteName); phase = "workers"; }
      else { phase = "site"; }
      continue;
    }

    if (phase === "site") { curSite = removeWorkShiftText(line); phase = "workers"; continue; }
    // 職人行・その他は経費の文脈維持のみ
  }

  return count;
}

// 送信取消（unsend）で、同一メッセージIDの経費行も連動削除する
function deleteExpensesByMessageId_(messageId) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(BILLING.sheetExpense);
  if (!sheet || sheet.getLastRow() < 2) return 0;

  const idCol = HEADERS_EXPENSE.indexOf("元メッセージID");
  if (idCol < 0) return 0;

  const ids = sheet.getRange(2, idCol + 1, sheet.getLastRow() - 1, 1).getValues();
  const toDelete = ids
    .map(([v], i) => (String(v) === String(messageId) ? i + 2 : null))
    .filter((r) => r !== null);

  [...toDelete].reverse().forEach((r) => sheet.deleteRow(r));
  return toDelete.length;
}

// 月末締めで、対象月の 経費／請求サマリ／freee取込 をリセットする
// （アーカイブ後に呼ばれる前提。他の月は残す）
function purgeBillingMonth_(ym) {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const exp = ss.getSheetByName(BILLING.sheetExpense);

  if (exp && exp.getLastRow() >= 2) {
    const last = exp.getLastRow();
    const vals = exp.getRange(2, 1, last - 1, HEADERS_EXPENSE.length).getValues();
    const keep = vals.filter((r) =>
      r.some((v) => String(v ?? "").trim()) &&
      (!r[0] || ymFromDateCell_(r[0]) !== String(ym).trim())
    );
    exp.getRange(2, 1, last - 1, HEADERS_EXPENSE.length).clearContent();
    if (keep.length > 0) {
      exp.getRange(2, 1, keep.length, HEADERS_EXPENSE.length).setValues(keep);
    }
  }

  // 請求サマリ・freee取込は対象月の行を削除（アーカイブ済み）
  replaceMonthRows_(BILLING.sheetSummary, HEADERS_BILLING_SUMMARY, ym, []);
  replaceMonthRows_(BILLING.sheetFreee,   HEADERS_FREEE, ym, []);
}

// ============================================================
// MVP-3: 月末締めへの組み込み
// management（ファイル2）の closeMonthAtEnd_ から、アーカイブ前に呼ばれる。
// 当月の請求サマリと請求書PDFを確定生成する（freee連携は任意・既定OFF）。
// 請求の失敗は月末アーカイブを止めないよう、ここで握りつぶしてログに残す。
// ============================================================

// freee連携の有効/無効（既定OFF）。スクリプトプロパティ FREEE_ENABLED=TRUE で有効化。
// OFFのときは freee取込の生成もAPIも一切行わない（LINE→集計→請求書PDFだけで完結）。
function freeeEnabled_() {
  return String(prop_("FREEE_ENABLED") ?? "").toUpperCase() === "TRUE";
}

function finalizeBillingForMonth_(ym) {
  try {
    buildBillingSummary_(ym);
    // 請求書PDFの自動発行（freee非依存・invoice_doc.js 導入時のみ）
    if (typeof issueInvoicesForMonth_ === "function") issueInvoicesForMonth_(ym);
    // freee連携は任意（既定OFF）。FREEE_ENABLED=TRUE のときだけ実行
    if (freeeEnabled_()) {
      exportFreee_(ym);
      if (typeof freeeCreateInvoices_ === "function") freeeCreateInvoices_(ym);
    }
    appendProcessLog_(new Date(), "", "", "", `[BILLING_CLOSE] ${ym}`, "INFO", "billing finalized");
  } catch (err) {
    appendProcessLog_(
      new Date(), "", "", "",
      `[BILLING_CLOSE_ERROR] ${ym}`, "ERROR", err && err.stack ? err.stack : String(err)
    );
  }
}

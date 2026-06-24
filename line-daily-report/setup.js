// ============================================================
// 【ファイル3】開発補助：初期セットアップ・トリガー設定・動作テスト
// ============================================================
// 本番稼働後は基本的に使いません。
// シート初期化・トリガー再設定・挙動確認のときだけ使います。
// ※ clasp push で本番から消えないよう、リポジトリに含めています。
// ============================================================

// 初期セットアップ（導入時に1回だけ実行）
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  [
    { name: CONFIG.sheetReport,     headers: HEADERS_DAILY_REPORT },
    { name: CONFIG.sheetProcessLog, headers: HEADERS_PROCESS_LOG },
    { name: CONFIG.sheetAdmin,      headers: HEADERS_ADMIN },
  ].forEach(({ name, headers }) => {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    const row1 = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    if (!row1.some((v) => String(v ?? "").trim())) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
  });

  installTriggers_();

  SpreadsheetApp.getUi().alert(
    "✅ 初期化完了！\n\n" +
    "作成シート: 作業日報 / メッセージ処理ログ / 管理者一覧\n" +
    "自動トリガー: 毎日23:59 → 月末なら締め＆アーカイブ\n\n" +
    "請求・経費を使う場合は setupBillingSheets / setupInvoiceSheet も実行してください。\n" +
    "次の手順: GASを「ウェブアプリ」としてデプロイ"
  );
}

// トリガー設定（closeCheckDailyTrigger を毎日23:59に登録）
function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === "closeCheckDailyTrigger") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger("closeCheckDailyTrigger")
    .timeBased()
    .everyDays(1)
    .atHour(23)
    .nearMinute(59)
    .create();
}

// 動作テスト（GASエディタから手動実行。データは匿名のサンプル）
function testWorkerLineParse() {
  const cases = [
    { line: "職人A 半日",                  expect: "職人A qty:0.5" },
    { line: "職人A 残業2 職人B 半日 職人C", expect: "職人A ot:2 / 職人B qty:0.5 / 職人C qty:1.0" },
    { line: "職人A 職人B 残業1",            expect: "職人B ot:1 他 ot:0" },
    { line: "職人A半日",                   expect: "職人A qty:0.5" },
  ];
  for (const { line, expect } of cases) {
    const result  = parseWorkerLine(removeWorkShiftText(line));
    const summary = result.map((w) => `${w.name}(qty:${w.qty} ot:${w.ot})`).join(" / ");
    Logger.log(`[${line}]\n  期待: ${expect}\n  結果: ${summary}\n`);
  }
}

function testFourPatterns() {
  const baseDate = new Date();
  const cases = [
    { label: "残業別行 全員",     text: "2月26日(木)\nサンプル取引先  常用\nサンプル現場\n職人A 職人B 職人C 職人D\n残1h" },
    { label: "残業末尾 最後の人", text: "2月24日(火)\nサンプル取引先  常用\nサンプル現場\n職人A 職人B 職人C 職人D 残業1" },
    { label: "半日別行 全員",     text: "2月24日(火)\nサンプル取引先  常用\nサンプル現場\n職人A 職人B 職人C\n半日" },
    { label: "全員通常",          text: "2月24日(火)\nサンプル取引先  常用\nサンプル現場\n職人A 職人B 職人C" },
    { label: "夜勤",              text: "2月24日(火)\nサンプル取引先\nサンプル現場 夜勤\n職人A 職人B" },
  ];
  for (const { label, text } of cases) {
    const result = parseByRules(text, `test_${baseDate.getTime()}`, baseDate);
    Logger.log(`=== ${label} ===\n登録件数: ${result.rows}\n`);
  }
}

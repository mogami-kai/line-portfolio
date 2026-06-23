// ============================================================
// 【ファイル2】管理機能
// 月末締め処理・アーカイブ・手動メニュー
// ============================================================


// ============================================================
// スプレッドシートUIメニュー（手動実行用）
// ============================================================

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  const now       = new Date();
  const thisYm    = Utilities.formatDate(now, TZ, "yyyy-MM");
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevYm    = Utilities.formatDate(prevMonth, TZ, "yyyy-MM");

  ui.createMenu("現場日報管理")
    .addItem(`今月分を締め処理（${thisYm}）`, "archiveCurrentMonthManual")
    .addItem(`先月分を締め処理（${prevYm}）`, "archivePrevMonthManual")
    .addToUi();
}


function archivePrevMonthManual() {
  const ui        = SpreadsheetApp.getUi();
  const now       = new Date();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const ym        = Utilities.formatDate(prevMonth, TZ, "yyyy-MM");

  const confirm = ui.alert(
    "手動締め処理の確認",
    `【対象月】${ym}（先月）\n\n` +
    "・対象月の作業日報行をアーカイブしてから削除します\n" +
    "・他の月のデータは削除されません\n" +
    "・月次集計（ピボット）と管理者一覧は保持されます\n" +
    "・メッセージ処理ログは削除されません\n\n" +
    "実行しますか？",
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) {
    ui.alert("キャンセルしました");
    return;
  }

  const result = closeMonthAtEnd_(ym);

  if (result.status === "SUCCESS") {
    ui.alert(`✅ ${ym} の手動締め処理が完了しました`);
  } else if (result.status === "SKIP") {
    ui.alert(
      `ℹ️ ${ym} の対象データが見つかりませんでした\n\n` +
      "確認ポイント:\n" +
      "・作業日報のB列（日付）に値が入っているか\n" +
      "・日付の形式が正しいか（例: 2026/02/01）\n" +
      "・メッセージ処理ログの [MONTH_CLOSE_TARGET] 行で件数を確認"
    );
  } else {
    ui.alert(
      `❌ 手動締め処理中にエラーが発生しました\n\n` +
      `${result.message}\n\n` +
      "メッセージ処理ログの [MONTH_CLOSE_ERROR] 行を確認してください。"
    );
  }
}

function archiveCurrentMonthManual() {
  const ui = SpreadsheetApp.getUi();
  const ym = Utilities.formatDate(new Date(), TZ, "yyyy-MM");

  const confirm = ui.alert(
    "手動締め処理の確認",
    `【対象月】${ym}\n\n` +
    "・対象月の作業日報行をアーカイブしてから削除します\n" +
    "・他の月のデータは削除されません\n" +
    "・月次集計（ピボット）と管理者一覧は保持されます\n" +
    "・メッセージ処理ログは削除されません\n\n" +
    "実行しますか？",
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) {
    ui.alert("キャンセルしました");
    return;
  }

  const result = closeMonthAtEnd_(ym);

  if (result.status === "SUCCESS") {
    ui.alert(`✅ ${ym} の手動締め処理が完了しました`);
  } else if (result.status === "SKIP") {
    ui.alert(
      `ℹ️ ${ym} の対象データが見つかりませんでした\n\n` +
      "確認ポイント:\n" +
      "・作業日報のB列（日付）に値が入っているか\n" +
      "・日付の形式が正しいか（例: 2026/03/01）\n" +
      "・メッセージ処理ログの [MONTH_CLOSE_TARGET] 行で件数を確認"
    );
  } else {
    ui.alert(
      `❌ 手動締め処理中にエラーが発生しました\n\n` +
      `${result.message}\n\n` +
      "メッセージ処理ログの [MONTH_CLOSE_ERROR] 行を確認してください。"
    );
  }
}

// ============================================================
// 月末自動トリガー
// ============================================================

// 毎日23:59に走る。月末なら当月を締める。
// 遅延で翌月1日の0〜3時に動いた場合のみ前月を救済する。
function closeCheckDailyTrigger() {
  const now      = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  // 正常ケース: 今日が月末 → 当月を締める
  if (tomorrow.getDate() === 1) {
    const ym = Utilities.formatDate(now, TZ, "yyyy-MM");
    closeMonthAtEnd_(ym);
    return;
  }

  // 遅延ケース: 翌月1日の深夜〜早朝（0〜3時）だけ前月を締める
  // hour <= 3 にすることで 1日23:59 の通常実行では発火しない
  const hour = Number(Utilities.formatDate(now, TZ, "H"));
  if (now.getDate() === 1 && hour <= 3) {
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const ym        = Utilities.formatDate(yesterday, TZ, "yyyy-MM");
    closeMonthAtEnd_(ym);
  }
}

// ============================================================
// 月末締め＆アーカイブ本体
// ============================================================

function closeMonthAtEnd_(ym) {
  try {
    // 月末確定: アーカイブ前に請求サマリ・freee取込を生成（billing.js 導入時のみ）
    if (typeof finalizeBillingForMonth_ === "function") finalizeBillingForMonth_(ym);

    const archiveId = archiveMonthToFolder_(ym);

    if (!archiveId) {
      appendProcessLog_(
        new Date(), "", "", "",
        `[MONTH_CLOSE_SKIP] ${ym}`, "SKIP", "no_target_data"
      );
      return { status: "SKIP", message: "対象データが見つかりません" };
    }

    purgeReportData_(ym);
    appendProcessLog_(
      new Date(), "", "", "",
      `[MONTH_CLOSE_DONE] ${ym}`, "SUCCESS_ARCHIVE", `archiveId=${archiveId}`
    );
    return { status: "SUCCESS", archiveId };

  } catch (error) {
    const msg = error && error.stack ? error.stack : String(error);
    appendProcessLog_(
      new Date(), "", "", "",
      `[MONTH_CLOSE_ERROR] ${ym}`, "ERROR", msg
    );
    return { status: "ERROR", message: msg };
  }
}

// ============================================================
// アーカイブ処理（makeCopy方式 + Drive REST APIでフォルダ移動）
// ============================================================

function archiveMonthToFolder_(ym) {
  const ss          = SpreadsheetApp.getActiveSpreadsheet();
  const reportSheet = ss.getSheetByName(CONFIG.sheetReport);

  // 対象件数を事前にログ出力（切り分け用）
  const reportLastRow = reportSheet ? reportSheet.getLastRow() : 0;
  appendProcessLog_(
    new Date(), "", "", "",
    `[MONTH_CLOSE_CHECK] ${ym}`, "INFO", `reportLastRow=${reportLastRow}`
  );

  if (!reportSheet || reportLastRow < 2) {
    appendProcessLog_(
      new Date(), "", "", "",
      `[MONTH_CLOSE_TARGET] ${ym}`, "INFO", "targetRows=0 (シートなし or データなし)"
    );
    return "";
  }

  const allData = reportSheet
    .getRange(2, 1, reportLastRow - 1, HEADERS_DAILY_REPORT.length)
    .getValues();

  // B列（row[1]）から年月を直接計算 → C列不整合に強い
  const targetRows = allData.filter(row => {
    if (!row[1]) return false;
    return ymFromDateCell_(row[1]) === String(ym).trim();
  });

  appendProcessLog_(
    new Date(), "", "", "",
    `[MONTH_CLOSE_TARGET] ${ym}`, "INFO", `targetRows=${targetRows.length}`
  );

  if (targetRows.length === 0) return "";

  // ── ① 現在のSSを丸ごとコピー ──
  const srcFile   = DriveApp.getFileById(ss.getId());
  const copyFile  = srcFile.makeCopy(`作業日報アーカイブ_${ym}`);
  const archiveSs = SpreadsheetApp.openById(copyFile.getId());

  SpreadsheetApp.flush();
  Utilities.sleep(1500);

  // ── ② コピー先の作業日報を対象月データだけに差し替え ──
  const archiveReport = archiveSs.getSheetByName(CONFIG.sheetReport);
  if (!archiveReport) {
    copyFile.setTrashed(true);
    throw new Error("アーカイブ先に作業日報シートが見つかりません");
  }
  const archiveLastRow = archiveReport.getLastRow();
  if (archiveLastRow >= 2) {
    archiveReport.deleteRows(2, archiveLastRow - 1);
  }
  archiveReport.getRange(2, 1, targetRows.length, HEADERS_DAILY_REPORT.length)
    .setValues(targetRows);
  archiveReport.setFrozenRows(1);

  // ── ③ 指定フォルダに移動（ARCHIVE_FOLDER_ID が設定されている場合のみ）──
  const folderId = prop_("ARCHIVE_FOLDER_ID");
  if (folderId) {
    const fileId = copyFile.getId();
    const token  = ScriptApp.getOAuthToken();

    const metaRes    = UrlFetchApp.fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`,
      { headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true }
    );
    const meta       = JSON.parse(metaRes.getContentText());
    const oldParents = (meta.parents || []).join(",");

    const moveRes = UrlFetchApp.fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}` +
      `?addParents=${encodeURIComponent(folderId)}&removeParents=${encodeURIComponent(oldParents)}&fields=id`,
      {
        method: "patch",
        headers: { Authorization: `Bearer ${token}` },
        muteHttpExceptions: true,
      }
    );
    if (moveRes.getResponseCode() >= 300) {
      throw new Error(`フォルダ移動に失敗しました: ${moveRes.getContentText()}`);
    }
  }

  return archiveSs.getId();
}

// ============================================================
// 対象月のデータのみ削除（他の月は残す）
// + メッセージ処理ログは全件クリア
// ============================================================

function purgeReportData_(ym) {
  const ss          = SpreadsheetApp.getActiveSpreadsheet();
  const reportSheet = ss.getSheetByName(CONFIG.sheetReport);
  const logSheet    = ss.getSheetByName(CONFIG.sheetProcessLog);

  // ── 作業日報: 対象月の行だけ削除、他の月は残す ──
  if (reportSheet && reportSheet.getLastRow() >= 2) {
    const lastRow = reportSheet.getLastRow();
    const allData = reportSheet
      .getRange(2, 1, lastRow - 1, HEADERS_DAILY_REPORT.length)
      .getValues();

    // 対象月「以外」の行だけ残す
    const keepRows = allData.filter(row => {
      if (!row[1]) return true;
      return ymFromDateCell_(row[1]) !== String(ym).trim();
    });

    // 全クリア → 残す行だけ書き戻す（deleteRow 1行ずつより大幅に速い）
    reportSheet.getRange(2, 1, lastRow - 1, HEADERS_DAILY_REPORT.length).clearContent();
    if (keepRows.length > 0) {
      reportSheet.getRange(2, 1, keepRows.length, HEADERS_DAILY_REPORT.length)
        .setValues(keepRows);
    }
  }

  // ── メッセージ処理ログ: データ行を全件クリア ──
  if (logSheet && logSheet.getLastRow() >= 2) {
    const logLastRow = logSheet.getLastRow();
    logSheet.getRange(2, 1, logLastRow - 1, HEADERS_PROCESS_LOG.length).clearContent();
  }

  // ── 経費・請求サマリ・freee取込: 対象月をリセット（billing.js 導入時のみ）──
  if (typeof purgeBillingMonth_ === "function") purgeBillingMonth_(ym);
}
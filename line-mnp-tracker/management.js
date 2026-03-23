// ============================================================
// 月末締め処理・アーカイブ・ランキング再計算・手動メニュー
// ============================================================

// ============================================================
// 手動メニュー
// ============================================================

function onOpen() {
  const ui        = SpreadsheetApp.getUi();
  const tz        = Session.getScriptTimeZone();
  const now       = new Date();
  const thisYm    = Utilities.formatDate(now, tz, "yyyy-MM");
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevYm    = Utilities.formatDate(prevMonth, tz, "yyyy-MM");

  ui.createMenu("実績管理")
    .addItem("ランキング再計算（MNP合計）", "rebuildRankingByMnpManual")
    .addItem("ランキング再計算（合計/日）",  "rebuildRankingByPerDayManual")
    .addSeparator()
    .addItem("今月分を締め処理（" + thisYm + "）", "archiveCurrentMonthManual")
    .addItem("先月分を締め処理（" + prevYm + "）", "archivePrevMonthManual")
    .addToUi();
}

function rebuildRankingByMnpManual() {
  buildMonthlyRanking_("mnp");
  SpreadsheetApp.getUi().alert("ランキングを再計算しました（MNP合計順）");
}

function rebuildRankingByPerDayManual() {
  buildMonthlyRanking_("perDay");
  SpreadsheetApp.getUi().alert("ランキングを再計算しました（合計/日順）");
}

// ============================================================
// 月末自動トリガー
// ============================================================

function rebuildRankingTrigger() {
  buildMonthlyRanking_("mnp");
}

function closeCheckDailyTrigger() {
  const tz       = Session.getScriptTimeZone();
  const now      = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  if (tomorrow.getDate() === 1) {
    const ym = Utilities.formatDate(now, tz, "yyyy-MM");
    closeMonthAtEnd_(ym);
    return;
  }

  const hour = Number(Utilities.formatDate(now, tz, "H"));
  if (now.getDate() === 1 && hour <= 3) {
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const ymPrev    = Utilities.formatDate(yesterday, tz, "yyyy-MM");
    closeMonthAtEnd_(ymPrev);
  }
}

// ============================================================
// 手動締め処理（今月）
// ============================================================

function archiveCurrentMonthManual() {
  const ui = SpreadsheetApp.getUi();
  const tz = Session.getScriptTimeZone();
  const ym = Utilities.formatDate(new Date(), tz, "yyyy-MM");

  const confirm = ui.alert(
    "手動締め処理の確認",
    "【対象月】" + ym + "\n\n" +
    "・現在のスプレッドシートを丸ごとアーカイブします\n" +
    "・実績_日次データ と 処理ログ のデータ行を全削除します\n" +
    "・月次ランキングは再計算後に残ります\n\n" +
    "実行しますか？",
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) { ui.alert("キャンセルしました"); return; }

  const result = closeMonthAtEnd_(ym);

  if (result.status === "SUCCESS") {
    ui.alert("✅ " + ym + " の手動締め処理が完了しました");
  } else if (result.status === "SKIP") {
    ui.alert("ℹ️ " + ym + " の対象データが見つかりませんでした");
  } else {
    ui.alert("❌ エラーが発生しました\n\n" + result.message);
  }
}

// ============================================================
// 手動締め処理（先月）
// ============================================================

function archivePrevMonthManual() {
  const ui        = SpreadsheetApp.getUi();
  const tz        = Session.getScriptTimeZone();
  const now       = new Date();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const ym        = Utilities.formatDate(prevMonth, tz, "yyyy-MM");

  const confirm = ui.alert(
    "手動締め処理の確認",
    "【対象月】" + ym + "（先月）\n\n" +
    "・現在のスプレッドシートを丸ごとアーカイブします\n" +
    "・実績_日次データ と 処理ログ のデータ行を全削除します\n" +
    "・月次ランキングは再計算後に残ります\n\n" +
    "実行しますか？",
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) { ui.alert("キャンセルしました"); return; }

  const result = closeMonthAtEnd_(ym);

  if (result.status === "SUCCESS") {
    ui.alert("✅ " + ym + " の手動締め処理が完了しました");
  } else if (result.status === "SKIP") {
    ui.alert("ℹ️ " + ym + " の対象データが見つかりませんでした");
  } else {
    ui.alert("❌ エラーが発生しました\n\n" + result.message);
  }
}

// ============================================================
// 月末締め本体
// ============================================================

function closeMonthAtEnd_(ym) {
  buildMonthlyRanking_("mnp");

  let archiveId = "";
  try {
    archiveId = archiveMonthOpsToFolder_(ym);
  } catch (error) {
    const msg = error && error.stack ? error.stack : String(error);
    appendLog_(new Date(), "", "", "", "[MONTH_CLOSE_ERROR] " + ym, "ERROR", msg);
    return { status: "ERROR", message: msg };
  }

  if (!archiveId) {
    appendLog_(new Date(), "", "", "", "[MONTH_CLOSE_SKIP] " + ym, "SKIP", "no_target_data");
    return { status: "SKIP", message: "対象データが見つかりません" };
  }

  purgeAllOpsData_();
  buildMonthlyRanking_("mnp");
  appendLog_(new Date(), "", "", "", "[MONTH_CLOSE_DONE] " + ym, "SUCCESS", "archiveId=" + archiveId);
  return { status: "SUCCESS", archiveId };
}

// ============================================================
// アーカイブ処理（makeCopy方式 + Drive REST APIでフォルダ移動）
// ============================================================

function archiveMonthOpsToFolder_(ym) {
  const ss         = SpreadsheetApp.getActiveSpreadsheet();
  const salesSheet = ss.getSheetByName(OPS_CFG.SALES_SHEET);

  if (!salesSheet || salesSheet.getLastRow() < 2) return "";

  const salesData = salesSheet
    .getRange(2, 1, salesSheet.getLastRow() - 1, SALES_SHEET_WIDTH)
    .getValues();

  const targetRows = salesData.filter((row) => cellToYmStr_(row[2]) === String(ym).trim());
  if (!targetRows.length) return "";

  // ── ① 現在のSSを丸ごとコピー ──
  const srcFile   = DriveApp.getFileById(ss.getId());
  const copyFile  = srcFile.makeCopy("実績アーカイブ_" + ym);
  const archiveSs = SpreadsheetApp.openById(copyFile.getId());

  SpreadsheetApp.flush();
  Utilities.sleep(1500);

  // ── ② コピー先の実績シートを対象月データだけに差し替え ──
  const archiveSalesSheet = archiveSs.getSheetByName(OPS_CFG.SALES_SHEET);
  if (!archiveSalesSheet) {
    copyFile.setTrashed(true);
    throw new Error("アーカイブ先に実績シートが見つかりません");
  }
  const archiveLastRow = archiveSalesSheet.getLastRow();
  if (archiveLastRow >= 2) archiveSalesSheet.deleteRows(2, archiveLastRow - 1);
  archiveSalesSheet.getRange(2, 1, targetRows.length, SALES_SHEET_WIDTH).setValues(targetRows);
  archiveSalesSheet.setFrozenRows(1);

  // ── ③ 指定フォルダに移動 ──
  const folderId = prop_("ARCHIVE_FOLDER_ID");
  if (folderId) {
    const fileId = copyFile.getId();
    const token  = ScriptApp.getOAuthToken();

    const metaRes    = UrlFetchApp.fetch(
      "https://www.googleapis.com/drive/v3/files/" + fileId + "?fields=parents",
      { headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true }
    );
    const meta       = JSON.parse(metaRes.getContentText());
    const oldParents = (meta.parents || []).join(",");

    const moveRes = UrlFetchApp.fetch(
      "https://www.googleapis.com/drive/v3/files/" + fileId +
      "?addParents=" + encodeURIComponent(folderId) +
      "&removeParents=" + encodeURIComponent(oldParents) +
      "&fields=id",
      { method: "patch", headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true }
    );
    if (moveRes.getResponseCode() >= 300) {
      throw new Error("フォルダ移動に失敗しました: " + moveRes.getContentText());
    }
  }

  return archiveSs.getId();
}

// ============================================================
// データ削除（実績_日次データ + 処理ログ 両方クリア）
// ============================================================

function purgeAllOpsData_() {
  const ss         = SpreadsheetApp.getActiveSpreadsheet();
  const salesSheet = ss.getSheetByName(OPS_CFG.SALES_SHEET);
  const logSheet   = ss.getSheetByName(OPS_CFG.LOG_SHEET);

  if (salesSheet) clearKeepHeader_(salesSheet, SALES_SHEET_WIDTH);
  if (logSheet)   clearKeepHeader_(logSheet,   LOG_SHEET_WIDTH);
}
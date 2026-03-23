// ============================================================
// LINE実績自動集計システム 
// ============================================================

const OPS_CFG = {
  SALES_SHEET:   "実績_日次データ",
  LOG_SHEET:     "処理ログ",
  RANKING_SHEET: "月次ランキング",
};

const SALES_SHEET_WIDTH   = 12;
const LOG_SHEET_WIDTH     = 7;
const RANKING_SHEET_WIDTH = 7;

// ============================================================
// Webhook入口
// ============================================================

function doPost(e) {
  if (!e?.postData?.contents) return ok_();

  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (error) {
    appendLog_(new Date(), "", "", "", String(e.postData.contents).slice(0, 200), "BAD_JSON", String(error));
    return ok_();
  }

  const events = payload.events || [];
  for (const event of events) {
    try {
      handleLineEvent_(event);
    } catch (error) {
      appendLog_(
        new Date(event?.timestamp || Date.now()),
        String(event?.message?.id || event?.unsend?.messageId || ""),
        String(event?.source?.groupId || ""),
        String(event?.source?.userId || ""),
        "[EXCEPTION]",
        "ERROR",
        String(error)
      );
    }
  }

  return ok_();
}

// ============================================================
// LINEイベント処理
// ============================================================

function handleLineEvent_(event) {
  const ts      = new Date(event.timestamp || Date.now());
  const groupId = String(event?.source?.groupId || "");
  const userId  = String(event?.source?.userId || "");

  if (event.type === "unsend") {
    const messageId = String(event?.unsend?.messageId || "");
    if (messageId) {
      const deleted = deleteByMessageId_(messageId);
      appendLog_(ts, messageId, groupId, userId, "[UNSEND]", "DELETED", `deleted=${deleted}`);
    }
    return;
  }

  if (!(event.type === "message" && event.message?.type === "text")) return;

  const messageId = String(event.message.id || "");
  const text      = String(event.message.text || "");

  if (!messageId) {
    appendLog_(ts, "", groupId, userId, text, "SKIP", "missing messageId");
    return;
  }

  if (isDuplicateMessage_(messageId)) {
    appendLog_(ts, messageId, groupId, userId, text.slice(0, 100), "DUPLICATE", "skip");
    return;
  }

  const normalized = normalizeText_(text);

  const hasHeader = /(【)?1日の(店舗|話数)実績(】)?/.test(normalized);
  const hasKojin  = /(【)?個人獲得(】)?/.test(normalized);

  if (!(hasHeader && hasKojin)) {
    appendLog_(ts, messageId, groupId, userId, text.slice(0, 100), "SKIP", "not_sales_format");
    return;
  }

  // ① まずルールベースパース
  let parsed = parseSales_(normalized, ts);

  if (parsed) {
    writeSalesRow_(parsed, messageId, ts);
    appendLog_(
      ts, messageId, groupId, userId, text.slice(0, 100),
      "SUCCESS",
      `parser=rule mnp=${parsed.mnp} mnpTotal=${parsed.mnpTotal ?? ""} hikari=${parsed.hikari} work=${parsed.workCount} explicit=${parsed.workExplicit}`
    );
    return;
  }

  // ② ルール失敗時のみ Gemini
  parsed = parseSalesByGemini_(normalized, ts);

  if (parsed) {
    writeSalesRow_(parsed, messageId, ts);
    appendLog_(
      ts, messageId, groupId, userId, text.slice(0, 100),
      "SUCCESS_GEMINI",
      `parser=gemini mnp=${parsed.mnp} mnpTotal=${parsed.mnpTotal ?? ""} hikari=${parsed.hikari} work=${parsed.workCount} explicit=${parsed.workExplicit}`
    );
    return;
  }

  appendLog_(ts, messageId, groupId, userId, text.slice(0, 100), "SKIP_GEMINI_FAILED", "rule_and_gemini_failed");
}

// ============================================================
// ルールベースパース
// ============================================================

function parseSales_(text, baseDate) {
  const lines = String(text || "")
    .split(/\r\n|\r|\n/)
    .map((line) => normalizeText_(String(line)).trim())
    .filter(Boolean);

  let date         = null;
  let store        = "";
  let name         = "";
  let mnp          = 0;
  let mnpTotal     = null;
  let hikari       = 0;
  let workCount    = 0;
  let workExplicit = false;

  for (const line of lines) {
    const compact = line.replace(/\s/g, "");

    // 日付抽出
    {
      let match = compact.match(/日付[（(]?\s*([0-9]{1,2})[\/\-月]([0-9]{1,2})日?[）)]?/);
      if (!match) match = compact.match(/^([0-9]{1,2})[\/\-]([0-9]{1,2})$/);
      if (!match) match = compact.match(/^([0-9]{1,2})月([0-9]{1,2})日$/);
      if (match) date = fixFuture_(baseDate, Number(match[1]), Number(match[2]));
    }

    // 店舗抽出
    {
      const matchExplicit = line.match(/^店舗[（(【\s：:]*(.+?)[）)】\s]*$/);
      if (matchExplicit && !/^店舗名/.test(line)) {
        store = matchExplicit[1].trim();
      } else if (!store) {
        const isKnownStore = /ビック?カメラ|コジマ|ヤマダ|エディオン|ケーズ|ノジマ/.test(line);
        const isStoreLabel = /^店舗/.test(line);
        const isExcluded   =
          /^1日の/.test(line) || /^個人獲得/.test(line) ||
          /^名前/.test(line)  || /^日付/.test(line) ||
          /^稼働数/.test(line) || /^当日/.test(line);
        if (!isExcluded && (isKnownStore || isStoreLabel)) {
          store = line.replace(/^[（(【\s]+|[）)】\s]+$/g, "").trim();
        }
      }
    }

    // 名前抽出（【】を含む行を除外）
    {
      const matchExplicit = line.match(/^名前[（(【\s：:]*(.+?)[）)】\s]*$/);
      if (matchExplicit) {
        name = matchExplicit[1].trim();
      } else if (!name) {
        const trimmed          = line.trim();
        const isExcludedPrefix =
          /^日付/.test(trimmed)     || /^店舗/.test(trimmed) ||
          /^稼働数/.test(trimmed)   || /^1日の/.test(trimmed) ||
          /^個人獲得/.test(trimmed) || /^当日/.test(trimmed) ||
          /^不明$/.test(trimmed);
        const isStoreLike   = /店/.test(trimmed);
        const isDateLike    = isDateLikeLine_(trimmed);
        const isNumberOnly  = /^[0-9０-９]+$/.test(trimmed);
        const hasBrackets   = /[【】]/.test(trimmed);
        const isShortEnough = trimmed.length <= 20;

        if (!isExcludedPrefix && !isStoreLike && !isDateLike && !isNumberOnly && !hasBrackets && isShortEnough) {
          name = trimmed;
        }
      }
    }

    // 稼働数抽出
    {
      const match1 = compact.match(/稼働数[（(]?([0-9]+)(日間?|日)?[）)]?/);
      if (match1) { workCount = safeInt_(match1[1], workCount); workExplicit = true; }
      const match2 = compact.match(/日数[（(]?([0-9]+)[）)]?/);
      if (match2) { workCount = safeInt_(match2[1], workCount); workExplicit = true; }
    }

    // 当日MNP + /計○件
    {
      const result = extractTodayMnp_(line);
      if (result !== null) {
        mnp = result.today;
        if (result.total !== null) mnpTotal = result.total;
      }
    }

    // 光合計
    {
      const value1 = extractTodayKen_(line, /当日.*?(1g光|光1g)/i);
      if (value1 != null) hikari += value1;
      const value2 = extractTodayKen_(line, /当日.*?(10g光|光10g)/i);
      if (value2 != null) hikari += value2;
    }
  }

  if (!date || !store || !name) return null;
  return { date, store, name, mnp, mnpTotal, hikari, workCount, workExplicit };
}

function extractTodayMnp_(line) {
  const compact = normalizeText_(line).replace(/\s/g, "");
  if (!/当日.*?mnp/i.test(compact)) return null;

  const matchBoth = compact.match(/当日[^\d]*(\d+)件[\/／]計(\d+)件/i);
  if (matchBoth) return { today: Number(matchBoth[1]), total: Number(matchBoth[2]) };

  const matchKen = compact.match(/当日[^\d]*(\d+)件/i);
  if (matchKen) return { today: Number(matchKen[1]), total: null };

  const matchEnd = compact.match(/当日[^\d]*(\d+)$/i);
  if (matchEnd) return { today: Number(matchEnd[1]), total: null };

  return null;
}

function isDateLikeLine_(line) {
  const s = normalizeText_(line).replace(/\s/g, "");
  return (
    /^([0-9]{1,2})[\/\-]([0-9]{1,2})$/.test(s) ||
    /^([0-9]{1,2})月([0-9]{1,2})日$/.test(s) ||
    /^日付[（(]?\s*([0-9]{1,2})[\/\-月]([0-9]{1,2})日?[）)]?$/.test(s) ||
    /^日付[（(][0-9]{1,2}[\/\-][0-9]{1,2}[）)]$/.test(s)
  );
}

function extractTodayKen_(line, labelRegex) {
  const compact = normalizeText_(line).replace(/\s/g, "");
  if (!labelRegex.test(compact)) return null;
  const matchKen = compact.match(/(\d+)件/);
  if (matchKen) return Number(matchKen[1]);
  const matchEnd = compact.match(/(\d+)$/);
  if (matchEnd) return Number(matchEnd[1]);
  return null;
}

// ============================================================
// Geminiフォールバック
// ============================================================

function parseSalesByGemini_(text, baseDate) {
  const apiKey = prop_("GEMINI_API_KEY");
  if (!apiKey) return null;

  const model       = prop_("GEMINI_MODEL") || "gemini-2.5-flash";
  const tz          = Session.getScriptTimeZone();
  const baseDateStr = Utilities.formatDate(baseDate, tz, "yyyy-MM-dd");

  const prompt =
    `あなたはLINE営業実績メッセージの厳密なデータ抽出アシスタントです。
以下のルールに従って、テキストから実績データを抽出してください。

【抽出ルール】
- 基準日: ${baseDateStr}
- 日付: 本文中の情報を最優先。特定できない場合は月と日を 0 にする。
- 店舗: 店舗名をそのまま抽出。見出しは含めない。
- 名前: 担当者名のみ。【個人獲得】などの【】を含むラベルは絶対に名前にしない。
- 稼働数: 明示がある場合のみ workExplicit=true。
- MNP当日(mnp): 「当日MNP X件/計Y件」または「当日MNP X件」の X のみ抽出。
- MNP累計(mnp_total): 「当日MNP X件/計Y件」の Y を抽出。/計がない場合は 0。
- 光: 「当日光1G」「当日1G光」「当日光10G」「当日10G光」の当日件数を合算。
- 除外: 新規、機変、キヘン、homeルーター、でんき、ガス等は一切計上しない。
- 不明な数値はすべて 0。

【本文】
${text}`;

  const responseSchema = {
    type: "OBJECT",
    properties: {
      date_mm:      { type: "INTEGER" },
      date_dd:      { type: "INTEGER" },
      store:        { type: "STRING"  },
      name:         { type: "STRING"  },
      workCount:    { type: "INTEGER" },
      workExplicit: { type: "BOOLEAN" },
      mnp:          { type: "INTEGER" },
      mnp_total:    { type: "INTEGER" },
      hikari:       { type: "INTEGER" },
    },
    required: ["date_mm", "date_dd", "store", "name", "workCount", "workExplicit", "mnp", "mnp_total", "hikari"],
  };

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent";

  const response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { "x-goog-api-key": apiKey },
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema },
    }),
    muteHttpExceptions: true,
  });

  const statusCode = response.getResponseCode();
  const body       = response.getContentText();
  if (statusCode < 200 || statusCode >= 300) { console.error(`Gemini Error [${statusCode}]: ${body}`); return null; }

  let parsedJson;
  try {
    const data = JSON.parse(body);
    const txt  = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    parsedJson = JSON.parse(txt);
  } catch (error) { console.error("Gemini JSON Parse Error:", error); return null; }

  if (!parsedJson?.store || !parsedJson?.name) return null;
  if (!parsedJson.date_mm || !parsedJson.date_dd) return null;
  if (/[【】]/.test(String(parsedJson.name || ""))) return null;

  const date = fixFuture_(baseDate, Number(parsedJson.date_mm), Number(parsedJson.date_dd));
  if (!date) return null;

  const mnpTotalRaw = toNumberRobust_(parsedJson.mnp_total);
  const mnpTotal    = mnpTotalRaw > 0 ? mnpTotalRaw : null;

  return {
    date,
    store:        String(parsedJson.store).trim(),
    name:         String(parsedJson.name).trim(),
    mnp:          toNumberRobust_(parsedJson.mnp),
    mnpTotal,
    hikari:       toNumberRobust_(parsedJson.hikari),
    workCount:    toNumberRobust_(parsedJson.workCount),
    workExplicit: !!parsedJson.workExplicit,
  };
}

// ============================================================
// 書き込み
// ============================================================

function writeSalesRow_(parsed, messageId, receivedAt) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(OPS_CFG.SALES_SHEET);
  const tz    = Session.getScriptTimeZone();

  sheet.appendRow([
    String(messageId),
    Utilities.formatDate(parsed.date, tz, "yyyy/MM/dd"),
    Utilities.formatDate(parsed.date, tz, "yyyy-MM"),
    parsed.store,
    parsed.name,
    parsed.workExplicit ? parsed.workCount : 0,
    parsed.mnp    || 0,
    parsed.hikari || 0,
    String(messageId),
    Utilities.formatDate(receivedAt, tz, "yyyy/MM/dd HH:mm:ss"),
    Utilities.formatDate(new Date(), tz, "yyyy/MM/dd HH:mm:ss"),
    parsed.mnpTotal != null ? parsed.mnpTotal : "",
  ]);
}

// ============================================================
// ランキング集計
// ============================================================

function buildMonthlyRanking_(sortBy) {
  sortBy = sortBy || "mnp";

  const ss         = SpreadsheetApp.getActiveSpreadsheet();
  const salesSheet = ss.getSheetByName(OPS_CFG.SALES_SHEET);
  const rankSheet  = ss.getSheetByName(OPS_CFG.RANKING_SHEET);
  if (!salesSheet || !rankSheet) return;

  clearKeepHeader_(rankSheet, RANKING_SHEET_WIDTH);

  const lastRow = salesSheet.getLastRow();
  if (lastRow < 2) return;

  const width = Math.min(salesSheet.getLastColumn(), SALES_SHEET_WIDTH);
  const data  = salesSheet.getRange(2, 1, lastRow - 1, width).getValues();

  const aggMap         = new Map();
  const mnpTotalMaxMap = new Map();
  const workMaxMap     = new Map();
  const submitDatesMap = new Map();

  for (const row of data) {
    const ym          = cellToYmStr_(row[2]);
    const name        = String(row[4] || "").trim();
    if (!ym || !name) continue;

    const date        = cellToDateStr_(row[1]);
    const work        = toNumberRobust_(row[5]);
    const mnp         = toNumberRobust_(row[6]);
    const hikari      = toNumberRobust_(row[7]);
    const mnpTotalRaw = row[11];
    const key         = `${ym}__${name}`;

    if (!aggMap.has(key)) aggMap.set(key, { ym, name, mnpSum: 0, hikari: 0 });

    const agg = aggMap.get(key);
    agg.mnpSum += mnp;
    agg.hikari += hikari;

    const mnpTotal = toNumberRobust_(mnpTotalRaw);
    if (mnpTotal > 0) mnpTotalMaxMap.set(key, Math.max(mnpTotalMaxMap.get(key) || 0, mnpTotal));

    if (!submitDatesMap.has(key)) submitDatesMap.set(key, new Set());
    if (date) submitDatesMap.get(key).add(date);

    if (work > 0) workMaxMap.set(key, Math.max(workMaxMap.get(key) || 0, work));
  }

  const ymGroupMap = new Map();

  for (const [key, agg] of aggMap.entries()) {
    if (!ymGroupMap.has(agg.ym)) ymGroupMap.set(agg.ym, []);

    const days =
      (workMaxMap.get(key) || 0) > 0
        ? workMaxMap.get(key) || 0
        : (submitDatesMap.get(key)?.size || 0);

    const mnpForRanking = mnpTotalMaxMap.has(key) ? mnpTotalMaxMap.get(key) : agg.mnpSum;
    const perDay        = days ? mnpForRanking / days : 0;

    ymGroupMap.get(agg.ym).push({ ym: agg.ym, name: agg.name, mnp: mnpForRanking, hikari: agg.hikari, days, perDay });
  }

  const outputRows = [];

  for (const ym of Array.from(ymGroupMap.keys()).sort()) {
    const rows = ymGroupMap.get(ym);

    // sortBy で並び順を切り替え
    if (sortBy === "perDay") {
      rows.sort((a, b) => b.perDay - a.perDay);
    } else {
      rows.sort((a, b) => b.mnp - a.mnp);
    }

    rows.forEach((row, index) => {
      let rank;
      if (index === 0) {
        rank = 1;
      } else {
        const prevScore = sortBy === "perDay" ? rows[index - 1].perDay : rows[index - 1].mnp;
        const curScore  = sortBy === "perDay" ? row.perDay             : row.mnp;
        rank = prevScore === curScore ? outputRows[outputRows.length - 1][1] : index + 1;
      }

      outputRows.push([ym, rank, row.name, row.mnp, row.hikari, row.days, Math.round(row.perDay * 100) / 100]);
    });
  }

  if (!outputRows.length) return;

  rankSheet.getRange(2, 1, outputRows.length, RANKING_SHEET_WIDTH).setValues(outputRows);
  rankSheet.getRange(2, 2, outputRows.length, 1).setNumberFormat("0");
  rankSheet.getRange(2, 4, outputRows.length, 3).setNumberFormat("0");
  rankSheet.getRange(2, 7, outputRows.length, 1).setNumberFormat("0.00");
}

// ============================================================
// 取り消し・重複排除
// ============================================================

function deleteByMessageId_(messageId) {
  const sheet   = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OPS_CFG.SALES_SHEET);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const messageIds = sheet.getRange(2, 9, lastRow - 1, 1).getValues().flat().map((v) => String(v || ""));
  const toDelete   = [];
  messageIds.forEach((v, i) => { if (v === String(messageId)) toDelete.push(i + 2); });
  toDelete.reverse().forEach((r) => sheet.deleteRow(r));
  return toDelete.length;
}

function isDuplicateMessage_(messageId) {
  const lookback = Number(prop_("DEDUPE_LOOKBACK_ROWS") || 3000);
  const sheet    = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OPS_CFG.LOG_SHEET);
  const lastRow  = sheet.getLastRow();
  if (lastRow < 2) return false;

  const readCount = Math.min(lastRow - 1, lookback);
  const ids = sheet.getRange(lastRow - readCount + 1, 1, readCount, 1).getValues().flat().map((v) => String(v || ""));
  return ids.includes(String(messageId));
}

// ============================================================
// ログ
// ============================================================

function appendLog_(ts, messageId, groupId, userId, text, status, detail) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OPS_CFG.LOG_SHEET);
  sheet.appendRow([
    String(messageId || ""),
    Utilities.formatDate(ts, Session.getScriptTimeZone(), "yyyy/MM/dd HH:mm:ss"),
    String(groupId || ""),
    String(userId  || ""),
    String(text    || ""),
    String(status  || ""),
    String(detail  || ""),
  ]);
}

// ============================================================
// ユーティリティ
// ============================================================

const clearKeepHeader_ = (sheet, width) => {
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) sheet.getRange(2, 1, lastRow - 1, width).clearContent();
};

const normalizeText_ = (text) => {
  if (!text) return "";
  let s = String(text);
  if (s.normalize) s = s.normalize("NFKC");
  return s;
};

const fixFuture_ = (baseDate, month, day) => {
  const limit = Number(prop_("FUTURE_DAY_LIMIT") || 30);
  const year  = baseDate.getFullYear();
  let date    = new Date(year, month - 1, day);
  if ((date - baseDate) / (1000 * 60 * 60 * 24) > limit) date = new Date(year - 1, month - 1, day);
  return date;
};

const safeInt_ = (value, defaultValue) => {
  const n = Number(String(value).replace(/[,\s　]/g, ""));
  return Number.isFinite(n) ? Math.trunc(n) : defaultValue;
};

const cellToDateStr_ = (value, format) => {
  if (!value) return "";
  if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone(), format || "yyyy/MM/dd");
  return String(value).trim();
};

const cellToYmStr_ = (value) => cellToDateStr_(value, "yyyy-MM");

const toNumberRobust_ = (value) => {
  if (value == null) return 0;
  if (typeof value === "number") return isNaN(value) ? 0 : value;
  let text = String(value);
  if (text.normalize) text = text.normalize("NFKC");
  text = text.replace(/[,\s　]/g, "");
  if (!text || /[a-zA-Z]/.test(text)) return 0;
  if (!/^[-+]?\d+(\.\d+)?$/.test(text)) return 0;
  const n = Number(text);
  return isNaN(n) ? 0 : n;
};

const prop_ = (key) => PropertiesService.getScriptProperties().getProperty(key);

const ok_ = () => ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
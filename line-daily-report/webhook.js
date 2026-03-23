// ============================================================
// 【ファイル1】本番必須コード
// LINE現場日報 自動登録システム
// ============================================================

const TZ = "Asia/Tokyo";

const CONFIG = {
  sheetReport:     "作業日報",
  sheetProcessLog: "メッセージ処理ログ",
  sheetAdmin:      "管理者一覧",

  futureDateThreshold: 30,
  dedupeRowLimit:      2000,
  geminiDefaultModel:  "gemini-2.5-flash",

  adminRegisterKeyword:   "管理者登録",
  adminUnregisterKeyword: "管理者解除",
};

const HEADERS_DAILY_REPORT = [
  "管理ID", "日付", "年月", "取引先", "契約種別", "勤務体系",
  "現場", "職人名", "人工", "残業時間", "元メッセージID",
  "登録日時", "判定方法", "確認状態", "AI要約",
];

const HEADERS_PROCESS_LOG = [
  "メッセージID", "処理日時", "グループID", "ユーザーID",
  "本文", "ステータス", "詳細",
];

const HEADERS_ADMIN = [
  "管理者名", "LINEユーザーID", "通知受信", "登録日時", "備考",
];

// ============================================================
// 表記揺れ正規化テーブル
// ============================================================

const OT_PATTERNS = [
  /残業\s*([0-9]+(?:[.][0-9]+)?)\s*(?:h|時間)?/i,
  /残\s*([0-9]+(?:[.][0-9]+)?)\s*(?:h|時間)?/i,
  /(?:ot|OT)\s*([0-9]+(?:[.][0-9]+)?)\s*h?/i,
  /[+]\s*([0-9]+(?:[.][0-9]+)?)\s*h/i,
  /([0-9]+(?:[.][0-9]+)?)\s*h\s*(?:残業|残|ot|OT)/i,
  /^残業$/i,
];

const HALF_DAY_KEYWORDS = [
  "半日", "半勤", "半", "午前", "午後",
  "午前のみ", "午後のみ", "午前半日", "午後半日",
  "am", "pm", "AM", "PM", "半日勤務", "半勤務", "0.5",
];

const FULL_DAY_KEYWORDS = ["一日", "1日", "全日", "フル", "full"];

const NIGHT_SHIFT_KEYWORDS = ["夜勤", "夜間", "ナイト", "night", "NIGHT"];

const BRACKET_OPEN_CLASS  = "[（(【「『\\[]";
const BRACKET_CLOSE_CLASS = "[)）】」』\\]]";

// ============================================================
// 汎用ユーティリティ
// ============================================================

const toHalfWidthDigits = (s) =>
  String(s ?? "").replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xFEE0)
  );

const normalize = (text) => {
  const s = String(text ?? "").normalize("NFKC");
  return s
    .replace(/\u3000/g, " ")
    .replace(/[、，,]/g, " ")
    .replace(/[。．]/g, ".")
    .replace(/[＋]/g, "+")
    .replace(/／/g, "/")
    .replace(/｜/g, "|");
};

const toNumber = (v, fallback) => {
  const n = Number(v);
  return isNaN(n) ? fallback : n;
};

const parseISODate = (s) => {
  const m = String(s ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = Utilities.parseDate(`${m[1]}-${m[2]}-${m[3]}`, TZ, "yyyy-MM-dd");
  return isNaN(d.getTime()) ? null : d;
};

const prop_ = (key) =>
  String(PropertiesService.getScriptProperties().getProperty(key) ?? "").trim();

const requireScriptProp = (key) => {
  const v = prop_(key);
  if (!v) throw new Error(`${key} が未設定です`);
  return v;
};

const resolveDate = (baseDate, mm, dd) => {
  const y = baseDate.getFullYear();
  const d = new Date(y, mm - 1, dd);
  const diff = (d - baseDate) / (1000 * 60 * 60 * 24);
  if (diff > CONFIG.futureDateThreshold) return new Date(y - 1, mm - 1, dd);
  if (diff < -300) return new Date(y + 1, mm - 1, dd);
  return d;
};

const extractWorkShift = (s) => {
  const text = normalize(s).toLowerCase();
  return NIGHT_SHIFT_KEYWORDS.some((k) => text.includes(String(k).toLowerCase()))
    ? "夜勤" : "";
};

const removeWorkShiftText = (s) => {
  let text = normalize(s);
  for (const k of NIGHT_SHIFT_KEYWORDS) {
    const escaped = String(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(escaped, "gi"), " ");
  }
  return text.replace(/\s+/g, " ").trim();
};

const normalizeContractType = (value, fallback = "常用") => {
  const s = String(value ?? "").trim();
  if (s === "常用") return "常用";
  if (s === "請負") return "請負";
  return fallback;
};

// B列の日付値から年月文字列を直接算出（C列不整合に強い）
const ymFromDateCell_ = (dateVal) => {
  if (!dateVal) return "";
  if (dateVal instanceof Date) {
    return Utilities.formatDate(dateVal, TZ, "yyyy-MM");
  }
  const parsed = new Date(dateVal);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, TZ, "yyyy-MM");
  }
  return "";
};

// 日付行用: 曜日だけを安全に除去する
const stripWeekdayForDate = (s) => {
  let text = String(s ?? "");

  // 例: (月), （火）, 【水】, 「木」
  text = text.replace(
    new RegExp(`${BRACKET_OPEN_CLASS}\\s*[月火水木金土日祝]\\s*${BRACKET_CLOSE_CLASS}`, "g"),
    ""
  );

  // 例: 3/18 月, 3月18日 火
  text = text.replace(/\s+[月火水木金土日祝]\s*$/g, "");

  return text.replace(/\s+/g, " ").trim();
};

// ============================================================
// Webhook本体
// ============================================================

function doPost(e) {
  if (!e || !e.postData || !e.postData.contents) {
    return ContentService.createTextOutput("OK");
  }

  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput("JSON Parse Error");
  }

  const events = Array.isArray(payload.events) ? payload.events : [];
  if (events.length === 0) return ContentService.createTextOutput("No Event");

  for (const event of events) {
    try {
      handleLineEvent(event);
    } catch (err) {
      const ts        = new Date(event?.timestamp ?? Date.now());
      const groupId   = event?.source?.groupId ?? "";
      const userId    = event?.source?.userId ?? "";
      const messageId = event?.message?.id ?? "";
      const text      = event?.message?.text ?? "";
      const errMsg    = err && err.stack ? err.stack : String(err);

      appendProcessLog_(ts, messageId, groupId, userId, text, "ERROR", errMsg);

      try {
        const adminIds = getActiveAdminIds();
        const notice = "⚠️ システムエラーが発生しました\n詳細はメッセージ処理ログをご確認ください";
        adminIds.forEach((uid) => linePush(uid, notice));
      } catch (notifyErr) {
        // 通知失敗は握りつぶす
      }
    }
  }

  return ContentService.createTextOutput("OK");
}

function handleLineEvent(event) {
  const ts      = new Date(event?.timestamp ?? Date.now());
  const groupId = event?.source?.groupId ?? "";
  const userId  = event?.source?.userId ?? "";

  if (event?.type === "unsend") {
    const unsentId = event?.unsend?.messageId ?? "";
    if (unsentId) {
      const count = deleteRowsByMessageId(unsentId);
      appendProcessLog_(ts, unsentId, groupId, userId, "[送信取消]", "DELETED", `削除件数: ${count}`);
    }
    return;
  }

  if (!(event?.type === "message" && event?.message?.type === "text")) return;

  const messageId = String(event.message.id ?? "");
  const text      = String(event.message.text ?? "");

  if (isDuplicateMessage(messageId)) {
    appendProcessLog_(ts, messageId, groupId, userId, text.slice(0, 100), "DUPLICATE", "処理スキップ");
    return;
  }

  if (isAdminCommand(event, text)) {
    handleAdminCommand(event, text);
    appendProcessLog_(ts, messageId, groupId, userId, text.slice(0, 100), "ADMIN_COMMAND", "処理完了");
    return;
  }

  const result = processReport(text, messageId, ts);

  appendProcessLog_(
    ts,
    messageId,
    groupId,
    userId,
    text.slice(0, 100),
    result.status,
    `登録件数: ${result.rows} / 判定: ${result.mode}`
  );

  if (groupId && result.rows > 0) {
    notifyAdmins(text, messageId, ts, result);
  }
}

// ============================================================
// メイン処理（従来ルール優先、例外時のみGemini）
// ============================================================

function processReport(text, messageId, receivedAt) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.sheetReport);
  if (!sheet) throw new Error("作業日報シートが見つかりません");

  // ① まず従来ルールでパース
  const ruleResult = parseByRules(text, messageId, receivedAt);
  if (ruleResult.rows > 0) {
    return {
      rows:    ruleResult.rows,
      mode:    "従来ルール",
      status:  "SUCCESS_RULE",
      summary: ruleResult.summary || "",
      entries: ruleResult.entries || [],
    };
  }

  // ② 従来ルールで取れなかった場合のみGemini
  try {
    const ai = callGemini(text, receivedAt, messageId);
    const normalizedSummary = buildAiSummaryFromEntries(ai.entries) || ai.summary;
    const rows = entriesToRows(ai.entries, messageId, normalizedSummary);

    if (rows.length > 0) {
      appendReportRows(sheet, rows);
      return {
        rows:    rows.length,
        mode:    "Gemini",
        status:  "SUCCESS_GEMINI",
        summary: normalizedSummary,
        entries: ai.entries,
      };
    }
  } catch (err) {
    Logger.log(`Geminiも失敗: ${err}`);
    return { rows: 0, mode: "失敗", status: "SKIP_PARSE_FAILED", summary: "", entries: [] };
  }

  return { rows: 0, mode: "Gemini(登録なし)", status: "SKIP_GEMINI_EMPTY", summary: "", entries: [] };
}

// ============================================================
// 従来ルール解析
// ============================================================

function parseByRules(text, messageId, receivedAt) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.sheetReport);
  if (!sheet) throw new Error("作業日報シートがありません");

  const lines = String(text)
    .split(/\r\n|\r|\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const nowStr = Utilities.formatDate(new Date(), TZ, "yyyy/MM/dd HH:mm:ss");

  let currentDate      = null;
  let currentClient    = "";
  let currentWorkType  = "常用";
  let currentWorkShift = "";
  let currentSite      = "";
  let phase            = "date";

  let blockDefaultQty = null;
  let blockDefaultOt  = null;
  let blockStartIndex = 0;

  const newRows       = [];
  const summaryBlocks = [];
  const entries       = [];
  let currentEntry    = null;

  for (const rawLine of lines) {
    const dateObj = parseDate(rawLine, receivedAt);
    if (dateObj) {
      if (currentEntry) entries.push(currentEntry);
      currentDate      = dateObj;
      currentClient    = "";
      currentWorkType  = "常用";
      currentWorkShift = "";
      currentSite      = "";
      blockDefaultQty  = null;
      blockDefaultOt   = null;
      blockStartIndex  = newRows.length;
      phase            = "client";
      currentEntry     = { date: dateObj, client: "", workType: "常用", workShift: "", site: "", workers: [] };
      continue;
    }

    if (!currentDate) continue;

    if (extractWorkShift(rawLine) === "夜勤" && removeWorkShiftText(rawLine) === "") {
      currentWorkShift = "夜勤";
      if (currentEntry) currentEntry.workShift = "夜勤";
      continue;
    }

    if (phase === "client") {
      const { clientName, workType, workShift, siteName } = parseClientLine(rawLine);
      currentClient   = clientName;
      currentWorkType = normalizeContractType(workType, "常用");
      if (workShift) currentWorkShift = workShift;
      if (currentEntry) {
        currentEntry.client   = currentClient;
        currentEntry.workType = currentWorkType;
        if (workShift) currentEntry.workShift = workShift;
      }

      if (siteName) {
        currentSite = removeWorkShiftText(siteName);
        if (extractWorkShift(siteName)) currentWorkShift = "夜勤";
        if (currentEntry) currentEntry.site = currentSite;
        blockStartIndex = newRows.length;
        phase = "workers";
      } else {
        phase = "site";
      }
      continue;
    }

    if (phase === "site") {
      if (extractWorkShift(rawLine)) currentWorkShift = "夜勤";
      currentSite = removeWorkShiftText(rawLine);
      if (currentEntry) currentEntry.site = currentSite;
      blockStartIndex = newRows.length;
      phase = "workers";
      continue;
    }

    if (isHalfDayOnlyLine(rawLine)) {
      blockDefaultQty = 0.5;
      for (let i = blockStartIndex; i < newRows.length; i++) {
        newRows[i][8] = 0.5;
        newRows[i][5] = buildWorkStyleLabel({ workShift: newRows[i][5], qty: 0.5, ot: newRows[i][9] });
      }
      continue;
    }

    if (isFullDayOnlyLine(rawLine)) {
      blockDefaultQty = 1.0;
      for (let i = blockStartIndex; i < newRows.length; i++) {
        newRows[i][8] = 1.0;
        newRows[i][5] = buildWorkStyleLabel({ workShift: newRows[i][5], qty: 1.0, ot: newRows[i][9] });
      }
      continue;
    }

    if (isOtOnlyLine(rawLine)) {
      const ot = extractOt(rawLine);
      if (ot !== null) {
        blockDefaultOt = ot;
        for (let i = blockStartIndex; i < newRows.length; i++) {
          newRows[i][9] = ot;
          newRows[i][5] = buildWorkStyleLabel({ workShift: newRows[i][5], qty: newRows[i][8], ot });
        }
      }
      continue;
    }

    if (extractWorkShift(rawLine)) currentWorkShift = "夜勤";

    const workers = parseWorkerLine(removeWorkShiftText(rawLine));
    if (workers.length === 0) continue;

    const ym             = Utilities.formatDate(currentDate, TZ, "yyyy-MM");
    const dateFormatted  = Utilities.formatDate(currentDate, TZ, "yyyy/MM/dd");
    const summaryWorkers = [];

    for (const [wi, w] of workers.entries()) {
      const qtyFinal  = w.hasQty ? w.qty : (blockDefaultQty ?? 1.0);
      const otFinal   = w.hasOt  ? w.ot  : (blockDefaultOt  ?? 0);
      const workStyle = buildWorkStyleLabel({ workShift: currentWorkShift, qty: qtyFinal, ot: otFinal });

      newRows.push([
        `${messageId}_${newRows.length}_${wi}`,
        dateFormatted,
        ym,
        currentClient,
        normalizeContractType(currentWorkType, "常用"),
        workStyle,
        currentSite,
        w.name,
        qtyFinal,
        otFinal,
        messageId,
        nowStr,
        "従来ルール",
        "自動登録",
        "",
      ]);

      summaryWorkers.push({ name: w.name, qty: qtyFinal, ot: otFinal });
      if (currentEntry) {
        currentEntry.workers.push({ name: w.name, qty: qtyFinal, ot: otFinal });
      }
    }

    if (summaryWorkers.length > 0) {
      summaryBlocks.push(buildRuleSummary({
        date:     currentDate,
        client:   currentClient,
        workType: normalizeContractType(currentWorkType, "常用"),
        site:     currentSite,
        workers:  summaryWorkers,
      }));
    }
  }

  if (currentEntry) entries.push(currentEntry);

  const summaryText = summaryBlocks.join("\n\n");

  if (newRows.length > 0) {
    newRows.forEach((row) => { row[14] = summaryText; });
    appendReportRows(sheet, newRows);
  }

  return { rows: newRows.length, summary: summaryText, entries };
}

// ============================================================
// 職人行解析
// ============================================================

function parseWorkerLine(line) {
  const tokens = tokenize(toHalfWidthDigits(normalize(line)));
  if (tokens.length === 0) return [];

  const workers = [];
  let current = null;

  for (const t of tokens) {
    const tl = t.toLowerCase();

    // 半日系
    if (HALF_DAY_KEYWORDS.some((k) => tl === String(k).toLowerCase())) {
      if (current) {
        current.qty = 0.5;
        current.hasQty = true;
      }
      continue;
    }

    // 全日系
    if (FULL_DAY_KEYWORDS.some((k) => tl === String(k).toLowerCase())) {
      if (current) {
        current.qty = 1.0;
        current.hasQty = true;
      }
      continue;
    }

    // 残業系
    const tokenOt = extractOt(t);
    if (tokenOt !== null) {
      if (current) {
        current.ot = tokenOt;
        current.hasOt = true;
      }
      continue;
    }

    // 名前
    if (/^[一-龥々ぁ-んァ-ヶ]{1,12}$/.test(t)) {
      if (current) workers.push(current);
      current = { name: t, qty: 1.0, ot: 0, hasQty: false, hasOt: false };
      continue;
    }

    // 単独数値は人工扱い
    const num = parseFloat(t);
    if (!isNaN(num) && current) {
      current.qty = num;
      current.hasQty = true;
    }
  }

  if (current) workers.push(current);
  return workers;
}

// ============================================================
// パース補助
// ============================================================

const extractOt = (s) => {
  const normalized = toHalfWidthDigits(normalize(s)).replace(/\s/g, "");
  for (const pattern of OT_PATTERNS) {
    const m = normalized.match(pattern);
    if (!m) continue;
    if (m[1] === undefined) return 1.0;
    const v = parseFloat(m[1].replace(/,/g, "."));
    return isNaN(v) ? null : v;
  }
  return null;
};

const isOtOnlyLine = (line) => {
  const s = toHalfWidthDigits(normalize(line)).replace(/\s/g, "").toLowerCase();
  for (const pattern of OT_PATTERNS) {
    if (!pattern.test(s)) continue;
    const stripped = s.replace(pattern, "").replace(/[0-9h+残業ot]/gi, "");
    if (stripped.length === 0) return true;
  }
  return false;
};

const isHalfDayOnlyLine = (line) => {
  const normalized = toHalfWidthDigits(normalize(line)).trim().toLowerCase();
  return HALF_DAY_KEYWORDS.some((k) => normalized === String(k).toLowerCase());
};

const isFullDayOnlyLine = (line) => {
  const normalized = toHalfWidthDigits(normalize(line)).trim().toLowerCase();
  return FULL_DAY_KEYWORDS.some((k) => normalized === String(k).toLowerCase());
};

const extractContractType = (s) => {
  if (s.includes("常用")) return "常用";
  if (s.includes("請負")) return "請負";
  return "";
};

const parseDate = (text, baseDate) => {
  const s = String(text ?? "").trim();
  if (!/\d/.test(s)) return null;

  let normalizedText = stripWeekdayForDate(normalize(s));
  normalizedText = toHalfWidthDigits(normalizedText).replace(/\s/g, "");

  let m;

  // yyyy/mm/dd, yyyy-mm-dd
  m = normalizedText.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  // m/d
  m = normalizedText.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (m) return resolveDate(baseDate, Number(m[1]), Number(m[2]));

  // m月d日 / m月d
  m = normalizedText.match(/^(\d{1,2})月(\d{1,2})日?$/);
  if (m) return resolveDate(baseDate, Number(m[1]), Number(m[2]));

  return null;
};

const parseClientLine = (line) => {
  let normalizedLine = normalize(line).replace(/\s+/g, " ").trim();
  const workShift    = extractWorkShift(normalizedLine);
  normalizedLine     = removeWorkShiftText(normalizedLine);

  let clientPart = normalizedLine;
  let sitePart   = "";

  if (/[/|]/.test(normalizedLine)) {
    const parts = normalizedLine.split(/[/|]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      clientPart = parts[0];
      sitePart   = parts.slice(1).join(" / ");
    }
  }

  let workType = extractContractType(clientPart);
  workType     = normalizeContractType(workType, "常用");
  const clientName = clientPart.replace(/常用|請負/g, "").replace(/\s+/g, " ").trim();

  return { clientName, workType, workShift, siteName: sitePart };
};

const tokenize = (line) => {
  let s = normalize(line);

  s = s.replace(/[（）()\[\]【】「」『』]/g, " ");
  s = s.replace(/[/|]/g, " ");
  s = toHalfWidthDigits(s);

  // 1 h → 1h
  s = s.replace(/(\d)\s*h\b/gi, "$1h");

  // 名前+半日 / 名前+午前 / 名前+午後 を分離
  s = s.replace(/([一-龥々ぁ-んァ-ヶ]+)(半日|半勤|午前のみ|午後のみ|午前半日|午後半日|午前|午後|am|pm|AM|PM)/g, "$1 $2");

  // 名前+残業1 / 名前+残業1h / 名前+残1h を分離
  s = s.replace(/([一-龥々ぁ-んァ-ヶ]+)(残業?[0-9]+(?:[.][0-9]+)?h?)/g, "$1 $2");
  s = s.replace(/([一-龥々ぁ-んァ-ヶ]+)(残[0-9]+(?:[.][0-9]+)?h?)/g, "$1 $2");

  s = s.replace(/\s+/g, " ").trim();
  return s ? s.split(" ").filter(Boolean) : [];
};

// ============================================================
// Gemini（従来ルール失敗時のフォールバック）
// ============================================================

function callGemini(text, receivedAt, messageId) {
  const apiKey = prop_("GEMINI_API_KEY");
  const model  = prop_("GEMINI_MODEL") || CONFIG.geminiDefaultModel;
  if (!apiKey) throw new Error("GEMINI_API_KEY が未設定です");

  const baseDate = Utilities.formatDate(new Date(receivedAt), TZ, "yyyy-MM-dd");

  const prompt = [
    "あなたはLINE現場報告を表形式に正規化する業務エンジンです。",
    "説明文は禁止です。必ずJSONのみ返してください。",
    "",
    "## 契約種別ルール",
    "- 必ず「常用」または「請負」のどちらかに正規化。空白なら「常用」",
    "",
    "## 勤務体系ルール",
    "- 夜勤は workShift に反映。半日は qty=0.5。残業は ot に数値",
    "",
    "## AI要約ルール（summary）",
    "- 1行目: 『何月何日 取引先 契約種別 現場』",
    "- 2行目: 『各職人名+働き方』を空白区切り",
    "- 例: '2月24日 恵興業 常用 追浜造船所\\n後藤1 石渡0.5 齋1残業1'",
    "",
    `baseDate: ${baseDate}`,
    `messageId: ${messageId}`,
    "",
    "## 入力本文",
    text,
  ].join("\n");

  const schema = {
    type: "OBJECT",
    properties: {
      summary: { type: "STRING" },
      entries: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            date:      { type: "STRING" },
            client:    { type: "STRING" },
            workType:  { type: "STRING" },
            workShift: { type: "STRING" },
            site:      { type: "STRING" },
            workers: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  name: { type: "STRING" },
                  qty:  { type: "NUMBER" },
                  ot:   { type: "NUMBER" },
                },
                required: ["name", "qty", "ot"],
              },
            },
          },
          required: ["date", "client", "workType", "site", "workers"],
        },
      },
    },
    required: ["summary", "entries"],
  };

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: schema,
      },
    }),
    muteHttpExceptions: true,
  });

  const status = res.getResponseCode();
  const body   = res.getContentText();
  if (status < 200 || status >= 300) throw new Error(`Gemini API エラー: ${status} / ${body}`);

  const json    = JSON.parse(body);
  const textOut = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textOut) throw new Error("Gemini の返却本文が空です");

  const parsed = JSON.parse(textOut);
  if (!Array.isArray(parsed?.entries)) throw new Error("Gemini の返却JSONが不正です");

  return {
    summary: String(parsed.summary ?? "").trim(),
    entries: sanitizeAiEntries(parsed.entries),
  };
}

const sanitizeAiEntries = (entries) =>
  entries
    .filter(Boolean)
    .flatMap((entry) => {
      const date      = String(entry.date ?? "").trim();
      const client    = String(entry.client ?? "").trim();
      const workType  = normalizeContractType(entry.workType, "常用");
      const workShift = extractWorkShift(entry.workShift) ? "夜勤" : "";
      const site      = String(entry.site ?? "").trim();
      if (!date || !client) return [];
      const workers = (Array.isArray(entry.workers) ? entry.workers : [])
        .map((w) => ({
          name: String(w?.name ?? "").trim(),
          qty:  toNumber(w?.qty, 1.0),
          ot:   toNumber(w?.ot, 0),
        }))
        .filter((w) => w.name);
      if (workers.length === 0) return [];
      return [{ date, client, workType, workShift, site, workers }];
    });

const entriesToRows = (entries, messageId, summary) => {
  const nowStr = Utilities.formatDate(new Date(), TZ, "yyyy/MM/dd HH:mm:ss");
  let idx = 0;

  return entries.flatMap((entry) => {
    const dateObj = parseISODate(entry.date);
    if (!dateObj) return [];
    const dateStr            = Utilities.formatDate(dateObj, TZ, "yyyy/MM/dd");
    const ym                 = Utilities.formatDate(dateObj, TZ, "yyyy-MM");
    const normalizedWorkType = normalizeContractType(entry.workType, "常用");
    const normalizedShift    = extractWorkShift(entry.workShift) ? "夜勤" : "";

    return entry.workers.map((w) => {
      const qty       = toNumber(w.qty, 1.0);
      const ot        = toNumber(w.ot, 0);
      const workStyle = buildWorkStyleLabel({ workShift: normalizedShift, qty, ot });
      return [
        `${messageId}_${idx++}`,
        dateStr,
        ym,
        entry.client,
        normalizedWorkType,
        workStyle,
        entry.site,
        w.name,
        qty,
        ot,
        messageId,
        nowStr,
        "Gemini",
        "自動登録",
        summary ?? "",
      ];
    });
  });
};

// ============================================================
// 管理者通知
// ============================================================

function notifyAdmins(text, messageId, receivedAt, result) {
  const adminIds = getActiveAdminIds();
  if (adminIds.length === 0) return;
  if (!result || Number(result.rows || 0) <= 0) return;

  const dateStr   = Utilities.formatDate(receivedAt, TZ, "MM月dd日 HH:mm");
  const modeLabel = result.status === "SUCCESS_GEMINI" ? "AI補助" : "自動";

  const entries = result.entries || [];
  let detailText = "";

  if (entries.length > 0) {
    const blocks = entries.map((entry) => {
      const entryDate = entry.date instanceof Date
        ? Utilities.formatDate(entry.date, TZ, "MM月dd日")
        : String(entry.date || "");

      const workerLines = (entry.workers || []).map((w) => {
        let label = w.name;
        if (w.qty === 0.5) label += "（半日）";
        if (w.ot > 0)      label += `（残業${w.ot}h）`;
        return `  ・${label}`;
      }).join("\n");

      return [
        `【日付】${entryDate}`,
        `【取引先】${entry.client}`,
        `【契約種別】${entry.workType}`,
        `【現場】${entry.site}`,
        "【職人】",
        workerLines,
      ].join("\n");
    });
    detailText = blocks.join("\n\n");
  } else {
    detailText = String(result.summary || "").trim() || String(text || "").trim().slice(0, 300);
  }

  const msg = [
    "📋 現場日報が登録されました",
    `受信: ${dateStr}（${modeLabel}）`,
    `登録件数: ${result.rows}件`,
    "",
    "━━━━━━━━━━━━━━",
    detailText,
    "━━━━━━━━━━━━━━",
    "誤りがあればシートで修正してください。",
  ].join("\n");

  for (const uid of adminIds) {
    try {
      linePush(uid, msg);
    } catch (err) {
      Logger.log(`通知失敗 ${uid}: ${err}`);
    }
  }
}

// ============================================================
// 管理者登録・解除
// ============================================================

function isAdminCommand(event, text) {
  if ((event?.source?.type ?? "") !== "user") return false;
  const s = String(text ?? "").trim();
  return s === CONFIG.adminRegisterKeyword || s === CONFIG.adminUnregisterKeyword;
}

function handleAdminCommand(event, text) {
  const userId = event?.source?.userId ?? "";
  if (!userId) return;
  const msg = String(text ?? "").trim();

  if (msg === CONFIG.adminRegisterKeyword) {
    const name = getLineDisplayName(userId) ?? "管理者";
    upsertAdmin(name, userId, true, "LINE個人チャットから登録");
    lineReply(event.replyToken, `管理者登録が完了しました（${name}）。\nグループに日報が届くたびにこちらへ通知します。`);
    return;
  }

  if (msg === CONFIG.adminUnregisterKeyword) {
    disableAdminNotify(userId);
    lineReply(event.replyToken, "管理者通知を停止しました。");
  }
}

function getLineDisplayName(userId) {
  try {
    const token = requireScriptProp("LINE_CHANNEL_ACCESS_TOKEN");
    const res = UrlFetchApp.fetch(
      `https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`,
      { headers: { Authorization: `Bearer ${token}` }, muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) return null;
    const body = JSON.parse(res.getContentText());
    return body.displayName ? String(body.displayName) : null;
  } catch (err) {
    return null;
  }
}

function upsertAdmin(name, userId, notifyOn, note) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.sheetAdmin);
  if (!sheet) throw new Error("管理者一覧シートがありません");
  const now = Utilities.formatDate(new Date(), TZ, "yyyy/MM/dd HH:mm:ss");
  const row = [name, userId, notifyOn ? "TRUE" : "FALSE", now, note ?? ""];
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const values = sheet.getRange(2, 1, lastRow - 1, HEADERS_ADMIN.length).getValues();
    const idx    = values.findIndex((r) => String(r[1] ?? "") === userId);
    if (idx !== -1) {
      sheet.getRange(idx + 2, 1, 1, HEADERS_ADMIN.length).setValues([row]);
      return;
    }
  }
  sheet.appendRow(row);
}

function disableAdminNotify(userId) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.sheetAdmin);
  if (!sheet || sheet.getLastRow() < 2) return;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS_ADMIN.length).getValues();
  const idx    = values.findIndex((r) => String(r[1] ?? "") === userId);
  if (idx !== -1) sheet.getRange(idx + 2, 3).setValue("FALSE");
}

function getActiveAdminIds() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.sheetAdmin);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet
    .getRange(2, 1, sheet.getLastRow() - 1, HEADERS_ADMIN.length)
    .getValues()
    .filter((r) => String(r[2] ?? "").toUpperCase() === "TRUE")
    .map((r) => String(r[1] ?? "").trim())
    .filter(Boolean);
}

// ============================================================
// 書き込み・削除
// ============================================================

function appendReportRows(sheet, rows) {
  if (!rows || rows.length === 0) return;
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, HEADERS_DAILY_REPORT.length).setValues(rows);
}

function isDuplicateMessage(msgId) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.sheetProcessLog);
  if (!sheet || sheet.getLastRow() < 2) return false;

  const headerRow    = sheet.getRange(1, 1, 1, HEADERS_PROCESS_LOG.length).getValues()[0];
  const msgIdColIdx  = headerRow.map(String).indexOf("メッセージID");
  const statusColIdx = headerRow.map(String).indexOf("ステータス");
  if (msgIdColIdx < 0 || statusColIdx < 0) return false;

  const lastRow  = sheet.getLastRow();
  const startRow = Math.max(2, lastRow - CONFIG.dedupeRowLimit + 1);
  const numRows  = lastRow - startRow + 1;
  const values   = sheet.getRange(startRow, 1, numRows, HEADERS_PROCESS_LOG.length).getValues();

  const DEDUP_STATUSES = new Set(["SUCCESS_RULE", "SUCCESS_GEMINI", "ADMIN_COMMAND", "DELETED"]);
  return values.some(
    (row) => String(row[msgIdColIdx]) === String(msgId) && DEDUP_STATUSES.has(String(row[statusColIdx]))
  );
}

function deleteRowsByMessageId(msgId) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.sheetReport);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const headerRow   = sheet.getRange(1, 1, 1, HEADERS_DAILY_REPORT.length).getValues()[0];
  const msgIdColIdx = headerRow.map(String).indexOf("元メッセージID");
  if (msgIdColIdx < 0) return 0;
  const ids      = sheet.getRange(2, msgIdColIdx + 1, sheet.getLastRow() - 1, 1).getValues();
  const toDelete = ids.map(([v], i) => (String(v) === String(msgId) ? i + 2 : null)).filter(Boolean);
  [...toDelete].reverse().forEach((r) => sheet.deleteRow(r));
  return toDelete.length;
}

// ============================================================
// ログ保存
// ============================================================

function appendProcessLog_(ts, messageId, groupId, userId, text, status, detail) {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.sheetProcessLog);

  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.sheetProcessLog);
    sheet.getRange(1, 1, 1, HEADERS_PROCESS_LOG.length).setValues([HEADERS_PROCESS_LOG]);
  } else if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS_PROCESS_LOG.length).setValues([HEADERS_PROCESS_LOG]);
  } else {
    const header = sheet.getRange(1, 1, 1, HEADERS_PROCESS_LOG.length).getValues()[0].map(String);
    const sameHeader = JSON.stringify(header) === JSON.stringify(HEADERS_PROCESS_LOG);
    if (!sameHeader) {
      sheet.getRange(1, 1, 1, HEADERS_PROCESS_LOG.length).setValues([HEADERS_PROCESS_LOG]);
    }
  }

  sheet.appendRow([
    String(messageId ?? ""),
    Utilities.formatDate(ts, TZ, "yyyy/MM/dd HH:mm:ss"),
    String(groupId ?? ""),
    String(userId ?? ""),
    String(text ?? ""),
    String(status ?? ""),
    String(detail ?? ""),
  ]);
}

// ============================================================
// LINE送信
// ============================================================

function lineReply(replyToken, text) {
  if (!replyToken) return;
  const token = requireScriptProp("LINE_CHANNEL_ACCESS_TOKEN");
  UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
    muteHttpExceptions: true,
  });
}

function linePush(userId, text) {
  const token = requireScriptProp("LINE_CHANNEL_ACCESS_TOKEN");
  const res = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify({ to: userId, messages: [{ type: "text", text }] }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error(`LINE push 送信失敗: ${code} / ${res.getContentText()}`);
}

// ============================================================
// ラベル生成ユーティリティ
// ============================================================

const buildWorkStyleLabel = ({ workShift = "", qty = 1.0, ot = 0 }) => {
  const labels = [];
  if (extractWorkShift(workShift) === "夜勤") labels.push("夜勤");
  if (Number(qty) === 0.5) labels.push("半日");
  if (Number(ot) > 0) labels.push("残業");
  return labels.join(",");
};

const buildWorkerShortLabel = ({ name, qty = 1.0, ot = 0 }) => {
  const qtyPart = Number(qty) === 0.5 ? "0.5" : "1";
  const otPart  = Number(ot) > 0 ? `残業${Number(ot)}` : "";
  return `${name}${qtyPart}${otPart}`;
};

const formatSummaryDate = (dateObj) =>
  `${dateObj.getMonth() + 1}月${dateObj.getDate()}日`;

const buildRuleSummary = ({ date, client, workType, site, workers }) => {
  const line1 = [formatSummaryDate(date), client || "", workType || "常用", site || ""]
    .filter(Boolean).join(" ");
  const line2 = workers.map((w) => buildWorkerShortLabel(w)).join(" ");
  return `${line1}\n${line2}`.trim();
};

const buildAiSummaryFromEntries = (entries) => {
  if (!entries || entries.length === 0) return "";
  const blocks = entries.map((entry) => {
    const dateObj = parseISODate(entry.date);
    if (!dateObj) return "";
    const line1 = [
      formatSummaryDate(dateObj),
      entry.client || "",
      normalizeContractType(entry.workType, "常用"),
      entry.site || "",
    ].filter(Boolean).join(" ");
    const line2 = (entry.workers || [])
      .map((w) => buildWorkerShortLabel({
        name: w.name,
        qty:  toNumber(w.qty, 1.0),
        ot:   toNumber(w.ot, 0),
      }))
      .join(" ");
    return `${line1}\n${line2}`.trim();
  }).filter(Boolean);
  return blocks.join("\n\n");
};
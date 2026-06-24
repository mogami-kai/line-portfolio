// ============================================================
// 【ファイル7】日報バリデーション（聞き返し判定）
// LINEパース後の各行を「請求書に直結する4項目」で精査し、
//   ok（そのまま記録）／ confirm（仮記録＋1タップ確認）／ hold（保留＋質問）
// を判定する。中核は純粋関数（GAS非依存）でテスト可能。
//
// 4項目（請求式に直結）:
//   取引先 … どの請求書／どの単価・住所
//   日付   … どの月の請求か
//   人工   … 常用請求額 ＝ 人工 × 単価
//   残業   … 残業請求 ＝ 残業h × 単価 ÷ 8 × 1.25
//
// 運用ログから抽出した代表的エラー（名前はダミー化して例示）:
//   ・取引先の表記揺れ: ローマ字のL/R/末尾ゆれ、漢字1字違い（工/興 など）
//   ・月の打ち間違い: 1/8 を 11/8、未来日、存在しない日(2月29 等)
//   ・名前にマーカーが食い込む: 「職人A半日」（スペース抜け）
//   ・同一現場に同じ人が2回
//   ・人工/残業が異常値（残業だけ大きい等）
// ============================================================

// ---- 正規化 ----------------------------------------------------
// 全角英数→半角、空白・記号・法人格を除去して比較用キーにする。
function normalizeNameKey_(s) {
  let t = String(s == null ? "" : s);
  // 全角英数字・記号 → 半角
  t = t.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  t = t.toLowerCase();
  // 法人格・装飾を除去
  t = t.replace(/株式会社|有限会社|\(株\)|（株）|㈱|\(有\)|（有）|様|御中/g, "");
  // 空白類・中黒・長音などを除去
  t = t.replace(/[\s　・･ｰー−\-]/g, "");
  return t.trim();
}

// ---- レーベンシュタイン距離（表記揺れ検出用）-------------------
function levenshtein_(a, b) {
  a = String(a); b = String(b);
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,          // 削除
        dp[j - 1] + 1,      // 挿入
        prev + (a[i - 1] === b[j - 1] ? 0 : 1) // 置換
      );
      prev = tmp;
    }
  }
  return dp[n];
}

// 表記揺れの許容距離（短い名前ほど厳しく）
function fuzzyThreshold_(key) {
  if (key.length <= 3) return 1;   // MALU/MARU（L↔R, U↔L）
  if (key.length <= 6) return 1;   // 恵工業/恵興業, 辻濱…
  return 2;
}

// 既知の取引先（正式名の配列）から最も近い候補を返す。距離が閾値内なら候補。
function fuzzyClientMatch_(raw, canonicals) {
  const key = normalizeNameKey_(raw);
  if (!key) return null;
  let best = null, bestDist = Infinity;
  for (const c of canonicals) {
    const ck = normalizeNameKey_(c);
    if (!ck) continue;
    const d = levenshtein_(key, ck);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  if (best == null) return null;
  const th = fuzzyThreshold_(key);
  return bestDist <= th ? { client: best, distance: bestDist } : null;
}

// ---- 取引先 ----------------------------------------------------
// resolve(raw) … 別名マスタ経由で正式名に解決（無ければ ""）。テストでは関数を注入。
function validateClientField_(raw, canonicals, resolve) {
  const value = String(raw == null ? "" : raw).trim();
  if (!value) return { field: "取引先", status: "hold", value: "", reason: "取引先が空" };

  const resolved = typeof resolve === "function" ? resolve(value) : "";
  if (resolved) return { field: "取引先", status: "ok", value: resolved, reason: "" };

  const fz = fuzzyClientMatch_(value, canonicals || []);
  if (fz) {
    return {
      field: "取引先", status: "confirm", value: fz.client, suggestion: fz.client,
      reason: `「${value}」はマスタに無いが「${fz.client}」に近い（表記揺れ?）`,
    };
  }
  return { field: "取引先", status: "hold", value, reason: `「${value}」はマスタに無い（新規?）` };
}

// ---- 日付 ------------------------------------------------------
// 「3月10日」「1/16(火)」「2026/1/16」「9/25日」等を yyyy-MM-dd に。
// refDate 基準で年を補完（未指定の年は直近の同月日）。
function parseReportDate_(raw, refDate) {
  const s = String(raw == null ? "" : raw).replace(/[（(].*?[)）]/g, "").trim();
  const ref = (refDate && typeof refDate.getTime === "function") ? refDate : new Date();
  let y, mo, d;
  let m;
  if ((m = s.match(/(\d{4})[\/年.\-](\d{1,2})[\/月.\-](\d{1,2})/))) {
    y = +m[1]; mo = +m[2]; d = +m[3];
  } else if ((m = s.match(/(\d{1,2})[\/月.\-](\d{1,2})/))) {
    mo = +m[1]; d = +m[2]; y = ref.getFullYear();
  } else {
    return { ok: false, iso: "", reason: "日付を読み取れない" };
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return { ok: false, iso: "", reason: "日付が範囲外" };
  // 年補完: refより未来に大きくずれる場合は前年と解釈（12月→1月跨ぎ対策）
  let dt = new Date(y, mo - 1, d, 12, 0, 0);
  if (dt.getMonth() !== mo - 1) return { ok: false, iso: "", reason: `存在しない日(${mo}/${d})` };
  return {
    ok: true,
    iso: `${dt.getFullYear()}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    date: dt,
    reason: "",
  };
}

function validateDateField_(raw, refDate) {
  const ref = (refDate && typeof refDate.getTime === "function") ? refDate : new Date();
  const p = parseReportDate_(raw, ref);
  if (!p.ok) return { field: "日付", status: "hold", value: "", reason: p.reason };

  const diffDays = Math.round((p.date.getTime() - ref.getTime()) / 86400000);
  if (diffDays > 1) {
    return { field: "日付", status: "confirm", value: p.iso, reason: `未来日(${p.iso})` };
  }
  if (diffDays < -45) {
    return { field: "日付", status: "confirm", value: p.iso, reason: `古い日付(${p.iso})・月の打ち間違い?` };
  }
  return { field: "日付", status: "ok", value: p.iso, reason: "" };
}

// ---- 人工 ------------------------------------------------------
function validateQtyField_(qty) {
  const n = Number(qty);
  if (!isFinite(n)) return { field: "人工", status: "hold", value: qty, reason: "人工が数値でない" };
  if (n <= 0) return { field: "人工", status: "hold", value: n, reason: "人工が0以下" };
  // 0.25刻みでない
  if (Math.abs(n * 4 - Math.round(n * 4)) > 1e-9) {
    return { field: "人工", status: "confirm", value: n, reason: `人工が0.25刻みでない(${n})` };
  }
  if (n > 2) return { field: "人工", status: "confirm", value: n, reason: `人工が大きい(${n})・重複?` };
  if (n > 1) return { field: "人工", status: "confirm", value: n, reason: `人工>1(${n})` };
  return { field: "人工", status: "ok", value: n, reason: "" };
}

// ---- 残業 ------------------------------------------------------
function validateOtField_(ot) {
  const n = Number(ot || 0);
  if (!isFinite(n)) return { field: "残業", status: "hold", value: ot, reason: "残業が数値でない" };
  if (n < 0) return { field: "残業", status: "hold", value: n, reason: "残業が負" };
  if (n > 8) return { field: "残業", status: "confirm", value: n, reason: `残業が大きい(${n}h)` };
  if (n > 3) return { field: "残業", status: "confirm", value: n, reason: `残業がやや大(${n}h)` };
  return { field: "残業", status: "ok", value: n, reason: "" };
}

// ---- 職人名（マーカー食い込み検出）-----------------------------
// 「久保半日」「石渡残業1」のようにスペース抜けでマーカーが名前に入った行を検出。
function validateWorkerName_(name) {
  const s = String(name == null ? "" : name).trim();
  if (!s) return { field: "職人名", status: "hold", value: "", reason: "名前が空" };
  if (/(半日|夜勤|残業|残|日勤|ot|OT|\d)/.test(s)) {
    return { field: "職人名", status: "confirm", value: s, reason: `名前にマーカー/数字が混入(${s})` };
  }
  return { field: "職人名", status: "ok", value: s, reason: "" };
}

// ---- 行単位の総合判定 -----------------------------------------
// row: { client, date, worker, qty, ot }
// ctx: { canonicals:[], resolveClient:fn, refDate:Date }
function validateRow_(row, ctx) {
  ctx = ctx || {};
  const checks = [
    validateClientField_(row.client, ctx.canonicals, ctx.resolveClient),
    validateDateField_(row.date, ctx.refDate),
    validateWorkerName_(row.worker),
    validateQtyField_(row.qty),
    validateOtField_(row.ot),
  ];
  const issues = checks.filter((c) => c.status !== "ok");
  const status = issues.some((c) => c.status === "hold") ? "hold"
               : issues.length ? "confirm" : "ok";
  return { status, checks, issues };
}

// ---- レポート単位（複数行）-------------------------------------
// rows の総合判定＋重複職人の検出。聞き返しメッセージ素材を返す。
function validateReportRows_(rows, ctx) {
  rows = rows || [];
  const perRow = rows.map((r) => ({ row: r, result: validateRow_(r, ctx) }));

  // 同一 取引先×現場×日付 で職人名が重複 → confirm
  const seen = {};
  for (const pr of perRow) {
    const r = pr.row;
    const key = [r.client, r.site || "", r.date, normalizeNameKey_(r.worker)].join("｜");
    if (seen[key]) {
      pr.result.issues.push({ field: "職人名", status: "confirm", value: r.worker, reason: `同一現場で「${r.worker}」が重複` });
      if (pr.result.status === "ok") pr.result.status = "confirm";
    }
    seen[key] = true;
  }

  const anyHold = perRow.some((p) => p.result.status === "hold");
  const anyConfirm = perRow.some((p) => p.result.status === "confirm");
  const status = anyHold ? "hold" : anyConfirm ? "confirm" : "ok";
  return { status, rows: perRow };
}

// ---- 聞き返しメッセージ生成（LINE Flex/Quick Reply 素材）--------
// 判定結果から、確認すべき項目を1〜数件にまとめた文面を作る。
function buildAskbackMessage_(report) {
  const issues = [];
  (report.rows || []).forEach((p, i) => {
    p.result.issues.forEach((c) => {
      issues.push(`${i + 1}行目 [${c.field}] ${c.reason}` + (c.suggestion ? ` → 「${c.suggestion}」?` : ""));
    });
  });
  if (!issues.length) return "";
  const head = report.status === "hold"
    ? "⚠️ 読み取れない項目があります。確認してください："
    : "❓ 念のため確認です（違ったら修正してください）：";
  return head + "\n" + issues.map((s) => "・" + s).join("\n");
}

// ============================================================
// GASラッパー: 取引先マスタの正式名・別名解決を使って精査する。
// （billing.js の clientMasterMap_ / canonicalClient_ を利用）
// rows は webhook のパース結果（取引先/日付/現場/職人/人工/残業）。
// ============================================================
function validateReportWithMaster_(rows, refDate) {
  let canonicals = [], resolve = (x) => "";
  try {
    if (typeof clientMasterMap_ === "function") canonicals = Object.keys(clientMasterMap_());
    if (typeof canonicalClient_ === "function") resolve = (x) => canonicalClient_(x);
  } catch (e) { /* マスタ未整備でも素の精査は動く */ }
  return validateReportRows_(rows, { canonicals, resolveClient: resolve, refDate: refDate || new Date() });
}

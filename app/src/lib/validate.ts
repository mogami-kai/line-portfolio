// ============================================================
// 日報バリデーション（聞き返し判定）
// v1 GAS（line-daily-report/report_validate.js）の純粋関数を忠実にTS化。
//
// 入力後の各行を「請求書に直結する4項目」で精査し、
//   ok（そのまま記録）／ confirm（仮記録＋1タップ確認）／ hold（保留＋質問）
// を判定する。閾値・日本語理由文は v1 と同一。
//
// 4項目（請求式に直結）:
//   取引先 … どの請求書／どの単価・住所
//   日付   … どの月の請求か
//   人工   … 常用請求額 ＝ 人工 × 単価
//   残業   … 残業請求 ＝ 残業h × 単価 ÷ 8 × 1.25
// ============================================================

/** 各項目の判定ステータス。 */
export type VStatus = "ok" | "confirm" | "hold";

/** 1項目の判定結果。 */
export interface FieldCheck {
  field: string;
  status: VStatus;
  value: unknown;
  reason: string;
  suggestion?: string;
}

/** バリデーション対象の1行（パース結果）。 */
export interface RowInput {
  client: string;
  site?: string;
  date: string;
  worker: string;
  qty: number | string;
  ot: number | string;
}

/** 取引先名 → 正式名に解決する関数（別名マスタ経由）。無ければ ""。 */
export type ResolveClient = (raw: string) => string;

/** 行判定のコンテキスト（既知取引先・別名解決・基準日）。 */
export interface ValidateContext {
  canonicals?: string[];
  resolveClient?: ResolveClient;
  refDate?: Date;
}

/** 1行の総合判定結果。 */
export interface RowResult {
  status: VStatus;
  checks: FieldCheck[];
  issues: FieldCheck[];
}

/** レポート（複数行）の総合判定結果。 */
export interface ReportResult {
  status: VStatus;
  rows: Array<{ row: RowInput; result: RowResult }>;
}

// ---- 正規化 ----------------------------------------------------
// 全角英数→半角、空白・記号・法人格を除去して比較用キーにする。
export function normalizeNameKey(s: unknown): string {
  let t = String(s == null ? "" : s);
  // 全角英数字・記号 → 半角
  t = t.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );
  t = t.toLowerCase();
  // 法人格・装飾を除去
  t = t.replace(/株式会社|有限会社|\(株\)|（株）|㈱|\(有\)|（有）|様|御中/g, "");
  // 空白類・中黒・長音などを除去
  t = t.replace(/[\s　・･ｰー−\-]/g, "");
  return t.trim();
}

// ---- レーベンシュタイン距離（表記揺れ検出用）-------------------
export function levenshtein(a: unknown, b: unknown): number {
  const sa = String(a);
  const sb = String(b);
  const m = sa.length;
  const n = sb.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1, // 削除
        dp[j - 1] + 1, // 挿入
        prev + (sa[i - 1] === sb[j - 1] ? 0 : 1), // 置換
      );
      prev = tmp;
    }
  }
  return dp[n];
}

// 表記揺れの許容距離（短い名前ほど厳しく）
function fuzzyThreshold(key: string): number {
  if (key.length <= 3) return 1; // MALU/MARU（L↔R, U↔L）
  if (key.length <= 6) return 1; // 恵工業/恵興業, 辻濱…
  return 2;
}

/** 既知の取引先（正式名の配列）から最も近い候補を返す。距離が閾値内なら候補。 */
export function fuzzyClientMatch(
  raw: unknown,
  canonicals: string[],
): { client: string; distance: number } | null {
  const key = normalizeNameKey(raw);
  if (!key) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const c of canonicals) {
    const ck = normalizeNameKey(c);
    if (!ck) continue;
    const d = levenshtein(key, ck);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  if (best == null) return null;
  const th = fuzzyThreshold(key);
  return bestDist <= th ? { client: best, distance: bestDist } : null;
}

// ---- 取引先 ----------------------------------------------------
// resolve(raw) … 別名マスタ経由で正式名に解決（無ければ ""）。テストでは関数を注入。
export function validateClientField(
  raw: unknown,
  canonicals?: string[],
  resolve?: ResolveClient,
): FieldCheck {
  const value = String(raw == null ? "" : raw).trim();
  if (!value)
    return { field: "取引先", status: "hold", value: "", reason: "取引先が空" };

  const resolved = typeof resolve === "function" ? resolve(value) : "";
  if (resolved)
    return { field: "取引先", status: "ok", value: resolved, reason: "" };

  const fz = fuzzyClientMatch(value, canonicals || []);
  if (fz) {
    return {
      field: "取引先",
      status: "confirm",
      value: fz.client,
      suggestion: fz.client,
      reason: `「${value}」はマスタに無いが「${fz.client}」に近い（表記揺れ?）`,
    };
  }
  return {
    field: "取引先",
    status: "hold",
    value,
    reason: `「${value}」はマスタに無い（新規?）`,
  };
}

// ---- 日付 ------------------------------------------------------
// 「3月10日」「1/16(火)」「2026/1/16」「9/25日」等を yyyy-MM-dd に。
// refDate 基準で年を補完（未指定の年は基準日の年）。
export interface ParseDateResult {
  ok: boolean;
  iso: string;
  reason: string;
  date?: Date;
}

export function parseReportDate(raw: unknown, refDate?: Date): ParseDateResult {
  const s = String(raw == null ? "" : raw)
    .replace(/[（(].*?[)）]/g, "")
    .trim();
  const ref =
    refDate && typeof refDate.getTime === "function" ? refDate : new Date();
  let y: number;
  let mo: number;
  let d: number;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/(\d{4})[\/年.\-](\d{1,2})[\/月.\-](\d{1,2})/))) {
    y = +m[1];
    mo = +m[2];
    d = +m[3];
  } else if ((m = s.match(/(\d{1,2})[\/月.\-](\d{1,2})/))) {
    mo = +m[1];
    d = +m[2];
    y = ref.getFullYear();
  } else {
    return { ok: false, iso: "", reason: "日付を読み取れない" };
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31)
    return { ok: false, iso: "", reason: "日付が範囲外" };
  // 年補完: refより未来に大きくずれる場合は前年と解釈（12月→1月跨ぎ対策）
  const dt = new Date(y, mo - 1, d, 12, 0, 0);
  if (dt.getMonth() !== mo - 1)
    return { ok: false, iso: "", reason: `存在しない日(${mo}/${d})` };
  return {
    ok: true,
    iso: `${dt.getFullYear()}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    date: dt,
    reason: "",
  };
}

export function validateDateField(raw: unknown, refDate?: Date): FieldCheck {
  const ref =
    refDate && typeof refDate.getTime === "function" ? refDate : new Date();
  const p = parseReportDate(raw, ref);
  if (!p.ok || !p.date)
    return { field: "日付", status: "hold", value: "", reason: p.reason };

  const diffDays = Math.round((p.date.getTime() - ref.getTime()) / 86400000);
  if (diffDays > 1) {
    return {
      field: "日付",
      status: "confirm",
      value: p.iso,
      reason: `未来日(${p.iso})`,
    };
  }
  if (diffDays < -45) {
    return {
      field: "日付",
      status: "confirm",
      value: p.iso,
      reason: `古い日付(${p.iso})・月の打ち間違い?`,
    };
  }
  return { field: "日付", status: "ok", value: p.iso, reason: "" };
}

// ---- 人工 ------------------------------------------------------
export function validateQtyField(qty: number | string): FieldCheck {
  const n = Number(qty);
  if (!isFinite(n))
    return { field: "人工", status: "hold", value: qty, reason: "人工が数値でない" };
  if (n <= 0) return { field: "人工", status: "hold", value: n, reason: "人工が0以下" };
  // 0.25刻みでない
  if (Math.abs(n * 4 - Math.round(n * 4)) > 1e-9) {
    return {
      field: "人工",
      status: "confirm",
      value: n,
      reason: `人工が0.25刻みでない(${n})`,
    };
  }
  if (n > 2)
    return { field: "人工", status: "confirm", value: n, reason: `人工が大きい(${n})・重複?` };
  if (n > 1) return { field: "人工", status: "confirm", value: n, reason: `人工>1(${n})` };
  return { field: "人工", status: "ok", value: n, reason: "" };
}

// ---- 残業 ------------------------------------------------------
export function validateOtField(ot: number | string): FieldCheck {
  const n = Number(ot || 0);
  if (!isFinite(n))
    return { field: "残業", status: "hold", value: ot, reason: "残業が数値でない" };
  if (n < 0) return { field: "残業", status: "hold", value: n, reason: "残業が負" };
  if (n > 8) return { field: "残業", status: "confirm", value: n, reason: `残業が大きい(${n}h)` };
  if (n > 3) return { field: "残業", status: "confirm", value: n, reason: `残業がやや大(${n}h)` };
  return { field: "残業", status: "ok", value: n, reason: "" };
}

// ---- 職人名（マーカー食い込み検出）-----------------------------
// 「久保半日」「石渡残業1」のようにスペース抜けでマーカーが名前に入った行を検出。
export function validateWorkerName(name: unknown): FieldCheck {
  const s = String(name == null ? "" : name).trim();
  if (!s) return { field: "職人名", status: "hold", value: "", reason: "名前が空" };
  if (/(半日|夜勤|残業|残|日勤|ot|OT|\d)/.test(s)) {
    return {
      field: "職人名",
      status: "confirm",
      value: s,
      reason: `名前にマーカー/数字が混入(${s})`,
    };
  }
  return { field: "職人名", status: "ok", value: s, reason: "" };
}

// ---- 行単位の総合判定 -----------------------------------------
// row: { client, date, worker, qty, ot }
// ctx: { canonicals:[], resolveClient:fn, refDate:Date }
export function validateRow(row: RowInput, ctx?: ValidateContext): RowResult {
  const c = ctx || {};
  const checks: FieldCheck[] = [
    validateClientField(row.client, c.canonicals, c.resolveClient),
    validateDateField(row.date, c.refDate),
    validateWorkerName(row.worker),
    validateQtyField(row.qty),
    validateOtField(row.ot),
  ];
  const issues = checks.filter((ck) => ck.status !== "ok");
  const status: VStatus = issues.some((ck) => ck.status === "hold")
    ? "hold"
    : issues.length
      ? "confirm"
      : "ok";
  return { status, checks, issues };
}

// ---- レポート単位（複数行）-------------------------------------
// rows の総合判定＋重複職人の検出。聞き返しメッセージ素材を返す。
export function validateReportRows(
  rows: RowInput[],
  ctx?: ValidateContext,
): ReportResult {
  const list = rows || [];
  const perRow = list.map((r) => ({ row: r, result: validateRow(r, ctx) }));

  // 同一 取引先×現場×日付 で職人名が重複 → confirm
  const seen: Record<string, boolean> = {};
  for (const pr of perRow) {
    const r = pr.row;
    const key = [
      r.client,
      r.site || "",
      r.date,
      normalizeNameKey(r.worker),
    ].join("｜");
    if (seen[key]) {
      pr.result.issues.push({
        field: "職人名",
        status: "confirm",
        value: r.worker,
        reason: `同一現場で「${r.worker}」が重複`,
      });
      if (pr.result.status === "ok") pr.result.status = "confirm";
    }
    seen[key] = true;
  }

  const anyHold = perRow.some((p) => p.result.status === "hold");
  const anyConfirm = perRow.some((p) => p.result.status === "confirm");
  const status: VStatus = anyHold ? "hold" : anyConfirm ? "confirm" : "ok";
  return { status, rows: perRow };
}

// ---- 聞き返しメッセージ生成（LINE Flex/Quick Reply 素材）--------
// 判定結果から、確認すべき項目を1〜数件にまとめた文面を作る。
export function buildAskbackMessage(report: ReportResult): string {
  const issues: string[] = [];
  (report.rows || []).forEach((p, i) => {
    p.result.issues.forEach((c) => {
      issues.push(
        `${i + 1}行目 [${c.field}] ${c.reason}` +
          (c.suggestion ? ` → 「${c.suggestion}」?` : ""),
      );
    });
  });
  if (!issues.length) return "";
  const head =
    report.status === "hold"
      ? "⚠️ 読み取れない項目があります。確認してください："
      : "❓ 念のため確認です（違ったら修正してください）：";
  return head + "\n" + issues.map((s) => "・" + s).join("\n");
}

// ============================================================
// 単価・金額計算（純粋関数）
// v1 GAS（billing.js / invoice_doc.js）の計算ロジックを忠実に移植。
//
// 時給 = 単価 ÷ 8、残業係数 = 1.25（REQUIREMENTS.md §7）。
//   1日   = 単価 × 1
//   半日   = 単価 × 0.5
//   0.75日 = 単価 × 0.75
//   夜勤   = 人工は1日扱い。ただし従業員（職人）の給料は単価 × 1.25（夜勤割増）
//   残業 Nh = ＋ 単価 ÷ 8 × 1.25 × N
//
// 丸めは v1（ROUND(...,0)）に合わせ Math.round で統一する。
// ============================================================

/** 勤務区分（Prisma enum Shift と一致）。 */
export type Shift = "DAY" | "HALF" | "NIGHT";

/** 残業係数（請求単価 ÷ 8 × 係数 / h）。 */
export const OT_FACTOR = 1.25;

/**
 * 夜勤割増係数（従業員の夜勤単価 = 人工単価 × 1.25）。
 * 取引先への請求は取引先ごとの夜勤単価（Client.nightUnitPrice）を使うため、
 * この係数は「自社従業員の給料」側にだけ効く。
 */
export const NIGHT_FACTOR = 1.25;

/** 1人工あたりの想定労働時間（時給 = 単価 ÷ 8）。 */
export const HOURS_PER_DAY = 8;

/** 勤務区分 → 人工（man-days）。DAY/NIGHT=1.0、HALF=0.5。 */
export function shiftManDays(shift: Shift): number {
  switch (shift) {
    case "HALF":
      return 0.5;
    case "DAY":
    case "NIGHT":
      return 1;
    default:
      return 1;
  }
}

/** 常用金額 = round(人工 × 単価)。 */
export function joyoAmount(manDays: number, unitPrice: number): number {
  return Math.round(manDays * unitPrice);
}

/**
 * 従業員の夜勤単価 = round(人工単価 × 1.25)。
 * 夜勤の人工は 1 日扱い（shiftManDays(NIGHT)=1）のまま、単価側で 1.25 倍する。
 */
export function nightUnit(unitPrice: number): number {
  const unit = Number(unitPrice);
  if (!isFinite(unit) || unit <= 0) return 0;
  return Math.round(unit * NIGHT_FACTOR);
}

/**
 * 従業員1人の給料（概算）。
 *   日勤＋半日 … 人工 × 人工単価
 *   夜勤      … 人工 × 夜勤単価（＝人工単価 × 1.25）
 *   残業      … 時間 × 残業単価（明示設定 or 人工単価÷8×1.25）
 * 人工単価が未設定（0以下）なら 0（画面では「単価未設定」と出す）。
 */
export function workerPay(input: {
  /** 日勤(DAY)＋半日(HALF)の人工合計。 */
  dayManDays: number;
  /** 夜勤(NIGHT)の人工合計。 */
  nightManDays: number;
  otHours: number;
  unitPrice: number;
  otUnitPrice?: number | null;
}): number {
  const unit = Number(input.unitPrice);
  if (!isFinite(unit) || unit <= 0) return 0;
  const day = Number(input.dayManDays) || 0;
  const night = Number(input.nightManDays) || 0;
  const ot = Number(input.otHours) || 0;
  return (
    joyoAmount(day, unit) +
    joyoAmount(night, nightUnit(unit)) +
    overtimeLineAmountResolved(ot, unit, input.otUnitPrice)
  );
}

/** 残業金額 = round(残業h × (単価 / 8) × 1.25)。 */
export function overtimeAmount(otHours: number, unitPrice: number): number {
  return Math.round(otHours * (unitPrice / HOURS_PER_DAY) * OT_FACTOR);
}

/** 残業の表示単価（1時間あたり）= round(単価 / 8 × 1.25)。請求書に出す単価セル。 */
export function overtimeUnit(unitPrice: number): number {
  return Math.round((unitPrice / HOURS_PER_DAY) * OT_FACTOR);
}

/**
 * 残業の時間単価を解決する。明示の残業単価(otUnitPrice)が正の数なら最優先で使い、
 * 未設定（null/0/非数）なら従来通り 人工単価÷8×1.25 を自動計算する。
 */
export function resolveOvertimeUnit(
  unitPrice: number,
  otUnitPrice?: number | null,
): number {
  const explicit = Number(otUnitPrice);
  if (isFinite(explicit) && explicit > 0) return Math.round(explicit);
  return overtimeUnit(unitPrice);
}

/** 残業明細の金額 = round(解決済み残業単価 × 時間)。 */
export function overtimeLineAmountResolved(
  otHours: number,
  unitPrice: number,
  otUnitPrice?: number | null,
): number {
  return Math.round(resolveOvertimeUnit(unitPrice, otUnitPrice) * otHours);
}

/**
 * 残業明細の金額 = round(表示残業単価 × 時間)。
 * overtimeAmount（生値で丸め）と違い「表示単価 × 数量 = 金額」が帳票上で一致するため、
 * 請求書フェイスで利用者・税理士が検算しても矛盾しない（明細はこちらを使う）。
 */
export function overtimeLineAmount(otHours: number, unitPrice: number): number {
  return Math.round(overtimeUnit(unitPrice) * otHours);
}

/**
 * 出面 entry の人工を解決する。保存済みの manDays を優先し、未設定（0・負・非数）の
 * ときだけ勤務区分（shift）から補完する。集計・請求で同一規約を使うための共通関数。
 */
export function resolveManDays(shift: Shift, manDays: unknown): number {
  const n = Number(manDays);
  return n > 0 ? n : shiftManDays(shift);
}

/** 1明細（人工＋残業）の金額 = 常用金額 ＋ 残業金額。 */
export function entryAmount(input: {
  manDays: number;
  otHours: number;
  unitPrice: number;
}): number {
  const { manDays, otHours, unitPrice } = input;
  return joyoAmount(manDays, unitPrice) + overtimeAmount(otHours, unitPrice);
}

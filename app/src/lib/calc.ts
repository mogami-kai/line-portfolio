// ============================================================
// 単価・金額計算（純粋関数）
// v1 GAS（billing.js / invoice_doc.js）の計算ロジックを忠実に移植。
//
// 時給 = 単価 ÷ 8、残業係数 = 1.25（REQUIREMENTS.md §7）。
//   1日   = 単価 × 1
//   半日   = 単価 × 0.5
//   0.75日 = 単価 × 0.75
//   夜勤   = 1日扱い（割増なし。現場により別途）
//   残業 Nh = ＋ 単価 ÷ 8 × 1.25 × N
//
// 丸めは v1（ROUND(...,0)）に合わせ Math.round で統一する。
// ============================================================

/** 勤務区分（Prisma enum Shift と一致）。 */
export type Shift = "DAY" | "HALF" | "NIGHT";

/** 残業係数（請求単価 ÷ 8 × 係数 / h）。 */
export const OT_FACTOR = 1.25;

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

/** 残業金額 = round(残業h × (単価 / 8) × 1.25)。 */
export function overtimeAmount(otHours: number, unitPrice: number): number {
  return Math.round(otHours * (unitPrice / HOURS_PER_DAY) * OT_FACTOR);
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

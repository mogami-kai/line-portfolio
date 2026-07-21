// ============================================================
// 請求書の日付ロジック（純粋関数・prisma 非依存＝単体テスト可能）
//   ・jstTodayDate  : 請求日（＝制作日）＝作成した当日（JST）。
//   ・computeDueDate: 支払期限＝対象月の「翌月」の指定日（取引先設定）。
// @db.Date 慣習に合わせ、いずれも UTC 午前0時の Date を返す。
// ============================================================

/** JST（Asia/Tokyo）の「今日」を UTC 午前0時の Date で返す。 */
export function jstTodayDate(now: Date = new Date()): Date {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()),
  );
}

/** JST の「今の時」（0-23）。入金リマインドの送信時刻判定に使う。 */
export function jstHour(now: Date = new Date()): number {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.getUTCHours();
}

/**
 * 支払期限＝対象月の「翌月」の paymentDay（取引先設定）。
 *   ・支払月は翌月で固定（12月なら翌年1月）。
 *   ・paymentDay=null → 翌月末日。
 *   ・指定日が翌月に存在しなければ末日へ丸める（例: 翌月=2月に31指定→28/29日）。
 * @param yearMonth 対象月 "YYYY-MM"
 * @param paymentDay 翌月の支払日（1-31）。null=末日。
 */
export function computeDueDate(
  yearMonth: string,
  paymentDay: number | null,
): Date {
  const [y, m] = yearMonth.split("-").map(Number); // m は 1-12
  const dueY = m === 12 ? y + 1 : y;
  const dueM = m === 12 ? 1 : m + 1; // 翌月（1-12）
  // Date.UTC(dueY, dueM, 0) = dueM 月の0日目 = dueM 月の末日。
  const lastDay = new Date(Date.UTC(dueY, dueM, 0)).getUTCDate();
  const day =
    paymentDay == null ? lastDay : Math.min(Math.max(1, paymentDay), lastDay);
  return new Date(Date.UTC(dueY, dueM - 1, day));
}

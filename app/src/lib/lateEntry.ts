// ============================================================
// 後日入力（出面の日付から何日もたってからの入力）の判定
//
//   「忘れてた」と後から入れた出面を、黙って集計・請求に入れないための判定。
//     遅れ日数 = 入力した日（JST）− 出面の日付。当日の入力=0 / 翌日の入力=1。
//     設定 lateEntryDays 日以上遅れた LIFF からの入力は「後日入力」＝要確認
//     （管理者が承認するまで集計・請求に入らない）。
//     既定 2 = 当日・翌日の入力はそのまま、2日以上たってからの入力は承認制。
//     null = 判定しない（どの日付でもそのまま登録）。
//   請求書を作成済みの月への入力も同じく要確認にする（請求書と数字がずれるため）。
//
//   判定は純粋関数（単体テスト対象）。設定の読み込みだけ DB を使う。
// ============================================================

import { prisma } from "./db.js";
import { jstTodayDate } from "./invoiceDates.js";

/** 設定が未作成のときの既定（migration の列既定と同じ）。 */
export const DEFAULT_LATE_ENTRY_DAYS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 遅れ日数（入力した日 JST − 出面の日付）。
 * workDate は UTC 0時保存の @db.Date。未来日の出面は負になる。
 */
export function entryLateDays(workDate: Date, enteredAt: Date): number {
  return Math.round((jstTodayDate(enteredAt).getTime() - workDate.getTime()) / DAY_MS);
}

/** 後日入力か（しきい値が null / 0 以下なら判定しない）。 */
export function isLateEntry(
  lateDays: number,
  threshold: number | null | undefined,
): boolean {
  return threshold != null && threshold > 0 && lateDays >= threshold;
}

/** 要確認にした理由を、入力した本人に返す文面（LIFF の完了画面に出す）。 */
export function buildLateEntryNotice(reasons: string[]): string {
  if (reasons.length === 0) return "";
  return [
    "【管理者の承認待ち】",
    ...reasons.map((r) => `・${r}`),
    "管理者が確認するまで、集計・請求には入りません。",
  ].join("\n");
}

/** 後日入力のしきい値（設定が未作成なら既定）。 */
export async function loadLateEntryDays(): Promise<number | null> {
  const s = await prisma.invoiceSetting.findFirst({
    select: { lateEntryDays: true },
  });
  return s ? s.lateEntryDays : DEFAULT_LATE_ENTRY_DAYS;
}

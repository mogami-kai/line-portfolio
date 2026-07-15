// ============================================================
// 操作履歴（AuditLog）
//   「誰が・いつ・何をしたか」を LINE アカウント（User）に紐づけて記録する。
//   - フォーム入力（LIFF からの出面作成）
//   - 管理者のデータ加工（編集 / 削除 / 承認 / 再投稿 / 投稿済みにする）
//   記録失敗は本処理を壊さない（fire-and-forget・console.error のみ）。
//   閲覧は /admin/logs（履歴ページ）と編集モーダルのメタ表示。
// ============================================================

import { prisma } from "./db.js";

/** 操作種別（履歴ページの表示ラベルは ACTION_LABEL を使う）。 */
export type AuditAction =
  | "REPORT_CREATE"
  | "REPORT_UPDATE"
  | "REPORT_DELETE"
  | "REPORT_CONFIRM"
  | "REPORT_RESEND"
  | "REPORT_DISMISS";

export const ACTION_LABEL: Record<AuditAction, string> = {
  REPORT_CREATE: "フォーム入力",
  REPORT_UPDATE: "編集",
  REPORT_DELETE: "削除",
  REPORT_CONFIRM: "承認",
  REPORT_RESEND: "LINE再投稿",
  REPORT_DISMISS: "再投稿しない",
};

/** 出面の1行要約（例: "7/9 辻濱興業 みなとみらい"）。 */
export function reportLabel(
  workDate: Date,
  clientName: string,
  siteName?: string | null,
): string {
  const md = `${workDate.getUTCMonth() + 1}/${workDate.getUTCDate()}`;
  const site = (siteName ?? "").trim();
  return [md, clientName, site].filter(Boolean).join(" ");
}

/**
 * 履歴を1件書き込む。失敗しても throw しない（本処理を優先）。
 *   actorId  : User.id（LINE アカウントに紐づく実ユーザー）。
 *   actorName: 表示名のスナップショット（ユーザー削除後も履歴が読めるように）。
 */
export async function writeAuditLog(entry: {
  actorId: string | null;
  actorName: string;
  action: AuditAction;
  reportId?: string | null;
  summary: string;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: entry.actorId,
        actorName: entry.actorName || "(不明)",
        action: entry.action,
        reportId: entry.reportId ?? null,
        summary: entry.summary,
      },
    });
  } catch (e) {
    console.error("[audit] write failed", e);
  }
}

// ============================================================
// /admin/logs — 操作履歴（Server Component）
//
//   フォーム入力（LIFFからの出面作成）と管理者のデータ加工
//   （編集/削除/承認/LINE再投稿/再投稿しない）を時系列で一覧する。
//   「誰が（LINEアカウント）・いつ・何をしたか」の監査用。
//   ガード: 全社管理者（ADMIN）のみ。スコープ管理者はホームへ戻す。
// ============================================================

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db.js";
import { getAdminContext, adminScopeOrgId } from "@/lib/auth.js";
import { ACTION_LABEL, type AuditAction } from "@/lib/audit.js";

export const dynamic = "force-dynamic";

/** UTC保存の日時を日本時間で "M/D(曜) HH:mm" 表示。 */
const WEEKDAY_JP = ["日", "月", "火", "水", "木", "金", "土"] as const;
function fmtJst(d: Date): { day: string; time: string } {
  // 日本時間に変換（UTC+9）。
  const j = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const day = `${j.getUTCMonth() + 1}/${j.getUTCDate()}(${WEEKDAY_JP[j.getUTCDay()]})`;
  const time = `${String(j.getUTCHours()).padStart(2, "0")}:${String(
    j.getUTCMinutes(),
  ).padStart(2, "0")}`;
  return { day, time };
}

/** 操作種別ごとのバッジ配色クラス。 */
function actionClass(action: string): string {
  switch (action) {
    case "REPORT_CREATE":
      return "log-badge log-badge--create";
    case "REPORT_DELETE":
      return "log-badge log-badge--delete";
    default:
      return "log-badge";
  }
}

export default async function LogsPage() {
  const admin = await getAdminContext();
  if (!admin) redirect("/admin?error=login");
  // 履歴は全社管理者のみ（スコープ管理者には出さない）。
  if (adminScopeOrgId(admin)) redirect("/admin");

  const logs = await prisma.auditLog.findMany({
    orderBy: { at: "desc" },
    take: 200,
    select: {
      id: true,
      at: true,
      actorName: true,
      action: true,
      summary: true,
    },
  });

  // 日本時間の日付でグループ化（新しい日が先頭）。
  const groups: { day: string; rows: typeof logs }[] = [];
  for (const l of logs) {
    const { day } = fmtJst(l.at);
    const g = groups[groups.length - 1];
    if (g && g.day === day) g.rows.push(l);
    else groups.push({ day, rows: [l] });
  }

  return (
    <main className="container container--admin">
      <div className="page-head">
        <h1 className="page-title">履歴</h1>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        フォーム入力と管理者のデータ加工の記録です（新しい順・直近200件）。
      </p>

      {logs.length === 0 ? (
        <div className="empty-state">
          <div className="es-title">まだ履歴がありません</div>
          <p className="es-sub">
            出面の入力・編集・削除などが行われると、ここに記録されます。
          </p>
        </div>
      ) : (
        groups.map((g) => (
          <section className="block" key={g.day}>
            <div className="section-head">
              <h2 className="section-title">{g.day}</h2>
            </div>
            <div className="log-list">
              {g.rows.map((l) => {
                const { time } = fmtJst(l.at);
                return (
                  <div className="log-row" key={l.id}>
                    <span className="log-time">{time}</span>
                    <span className={actionClass(l.action)}>
                      {ACTION_LABEL[l.action as AuditAction] ?? l.action}
                    </span>
                    <span className="log-actor">{l.actorName}</span>
                    <span className="log-summary">{l.summary}</span>
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}
    </main>
  );
}

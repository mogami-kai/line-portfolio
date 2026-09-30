// ============================================================
// 出面の LINE 通知（管理者への個別送信）
//
//   以前は自社の出面を LINE グループへ投稿していたが、グループ投稿はやめ、
//   管理画面に入れる管理者へ公式アカウントから個別に送る（内容は従来のログと同じ）。
//
//   送り先（設定の「通知先ロール」で選ぶ）:
//     自社の出面    : ADMIN / SELF_ADMIN / ORG_ADMIN（その自社組織の）
//     協力会社の出面: ADMIN / ORG_ADMIN（その協力会社の）。自社管理者には絶対に送らない
//                     （自社側にパートナーの存在を出さない不変条件）。
//   共通: 承認済み・有効・通知ON・友だち未追加(false)ではない・本人の登録分は本人に送らない。
//
//   送り先の選定（selectReportRecipients）は DB 非依存の純粋関数にして単体テストする。
// ============================================================

import type { ContractType, OrgKind, Role, Shift } from "@prisma/client";
import { prisma } from "./db.js";
import {
  formatReportCancelLog,
  formatReportLog,
  multicastToUsers,
  pushToUser,
  type ReportLogInput,
} from "./line.js";

/** 自社の出面の通知先に選べるロール。 */
export const NOTIFY_SELF_ROLE_OPTIONS = ["ADMIN", "SELF_ADMIN", "ORG_ADMIN"] as const;
/** 協力会社の出面の通知先に選べるロール（自社管理者は選べない）。 */
export const NOTIFY_PARTNER_ROLE_OPTIONS = ["ADMIN", "ORG_ADMIN"] as const;

/** 設定が未作成のときの既定（migration の列既定と同じ）。 */
export const DEFAULT_NOTIFY_SELF_ROLES: Role[] = ["ADMIN", "SELF_ADMIN", "ORG_ADMIN"];
export const DEFAULT_NOTIFY_PARTNER_ROLES: Role[] = ["ADMIN"];

/** 通知先の候補（管理者ユーザー）。 */
export interface NotifyCandidate {
  id: string;
  lineUserId: string;
  role: Role;
  orgId: string;
  orgKind: OrgKind;
  approved: boolean;
  status: "ACTIVE" | "DISABLED";
  notifyReports: boolean;
  lineFriend: boolean | null;
}

/** 通知する出面（区分・所属組織・登録者）。 */
export interface NotifyReportTarget {
  source: OrgKind;
  orgId: string;
  createdById?: string | null;
}

/** 出面1件の通知先を決める（DB非依存の純粋関数）。 */
export function selectReportRecipients(
  report: NotifyReportTarget,
  candidates: NotifyCandidate[],
  roles: { self: readonly Role[]; partner: readonly Role[] },
): NotifyCandidate[] {
  const allowed =
    report.source === "SELF"
      ? roles.self.filter((r) =>
          (NOTIFY_SELF_ROLE_OPTIONS as readonly Role[]).includes(r),
        )
      : roles.partner.filter((r) =>
          (NOTIFY_PARTNER_ROLE_OPTIONS as readonly Role[]).includes(r),
        );
  const seen = new Set<string>();
  const out: NotifyCandidate[] = [];
  for (const u of candidates) {
    if (!u.approved || u.status !== "ACTIVE" || !u.notifyReports) continue;
    if (!u.lineUserId || u.lineFriend === false) continue;
    if (report.createdById && u.id === report.createdById) continue;
    if (!allowed.includes(u.role)) continue;
    // ロールごとの見える範囲（管理画面の閲覧範囲と同じ）。
    if (u.role === "SELF_ADMIN" && (report.source !== "SELF" || u.orgKind !== "SELF")) {
      continue;
    }
    if (u.role === "ORG_ADMIN" && u.orgId !== report.orgId) continue;
    if (seen.has(u.lineUserId)) continue;
    seen.add(u.lineUserId);
    out.push(u);
  }
  return out;
}

/** 通知の本文に使う出面（Prisma の Report + relations の必要部分）。 */
export interface ReportForNotify {
  workDate: Date;
  contractType: ContractType;
  contractAmount: number | null;
  siteName: string | null;
  client: { name: string };
  entries: Array<{ shift: Shift; manDays: number; otHours: number; worker: { name: string } }>;
  expenses: Array<{ kind: string; amount: number }>;
}

/**
 * 通知用の ReportLogInput を組み立てる（登録・再通知・取消で共通）。
 * 現場表記は自由入力（siteName）優先。請負(UKEOI)は請負金額を現場行に併記する。
 */
export function toReportLogInput(rep: ReportForNotify): ReportLogInput {
  const baseSiteName = rep.siteName ?? "";
  const ukeoiNote =
    rep.contractType === "UKEOI" && rep.contractAmount != null
      ? `（請負 ¥${rep.contractAmount.toLocaleString("ja-JP")}）`
      : "";
  const displaySiteName = `${baseSiteName}${ukeoiNote}`.trim();
  return {
    workDate: rep.workDate,
    contractType: rep.contractType,
    client: rep.client,
    site: displaySiteName ? { name: displaySiteName } : null,
    entries: rep.entries.map((e) => ({
      shift: e.shift,
      manDays: e.manDays,
      otHours: e.otHours,
      worker: e.worker,
    })),
    expenses: rep.expenses.map((x) => ({ kind: x.kind, amount: x.amount })),
  };
}

/**
 * 通知本文。自社は従来のグループ投稿と同じ文面。協力会社は先頭に会社名を付ける
 * （協力会社の出面は自社管理者には送らないので、受け取るのは全社/その会社の管理者のみ）。
 */
export function reportNotifyText(
  rep: ReportForNotify,
  opts: { kind: "created" | "canceled"; partnerOrgName?: string | null },
): string {
  const input = toReportLogInput(rep);
  const body =
    opts.kind === "canceled" ? formatReportCancelLog(input) : formatReportLog(input);
  return opts.partnerOrgName ? `【協力会社 ${opts.partnerOrgName}】\n${body}` : body;
}

/** 通知先ロールの設定（未作成なら既定）。 */
async function loadNotifyRoles(): Promise<{ self: Role[]; partner: Role[] }> {
  const s = await prisma.invoiceSetting.findFirst({
    select: { notifySelfRoles: true, notifyPartnerRoles: true },
  });
  return {
    self: s?.notifySelfRoles ?? DEFAULT_NOTIFY_SELF_ROLES,
    partner: s?.notifyPartnerRoles ?? DEFAULT_NOTIFY_PARTNER_ROLES,
  };
}

/** 管理画面に入れるロールのユーザー（通知先の候補）。 */
async function loadCandidates(): Promise<NotifyCandidate[]> {
  const users = await prisma.user.findMany({
    where: {
      role: { in: ["ADMIN", "SELF_ADMIN", "ORG_ADMIN"] },
      approved: true,
      status: "ACTIVE",
      notifyReports: true,
    },
    select: {
      id: true,
      lineUserId: true,
      role: true,
      orgId: true,
      approved: true,
      status: true,
      notifyReports: true,
      lineFriend: true,
      org: { select: { kind: true } },
    },
  });
  return users.map((u) => ({ ...u, orgKind: u.org.kind }));
}

/**
 * 出面を管理者へ通知する。送り先が0人なら何もしない（送るべき相手がいない＝完了扱い）。
 * LINE の送信に失敗したら throw（呼び出し側で「未通知」のまま残して再通知できるようにする）。
 */
export async function notifyReportToAdmins(
  report: NotifyReportTarget,
  text: string,
): Promise<{ recipients: number }> {
  const [roles, candidates] = await Promise.all([loadNotifyRoles(), loadCandidates()]);
  const to = selectReportRecipients(report, candidates, roles);
  if (to.length === 0) return { recipients: 0 };
  await multicastToUsers(
    to.map((u) => u.lineUserId),
    text,
  );
  return { recipients: to.length };
}

/** 設定画面の「テスト送信」: ログイン中の管理者本人に1通送る。 */
export async function sendTestNotification(lineUserId: string): Promise<void> {
  await pushToUser(
    lineUserId,
    "【テスト】出面の通知はこのように届きます。\nこのメッセージが見えていれば、管理者への個別通知は設定できています。",
  );
}

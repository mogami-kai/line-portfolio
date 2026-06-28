// ============================================================
// 管理ダッシュボードの「今月の状態」と「次にやること」
//   ダッシュボード上部のカード＋導線に使う軽量集計（count 中心）。
//   出面/承認/請求の状態から、管理者が次に取るべき行動を1リストにまとめる。
// ============================================================

import { prisma } from "./db.js";
import { monthRange } from "./aggregate.js";

export interface NextAction {
  key: string;
  text: string;
  href: string;
  level: "warn" | "info" | "ok";
}

export interface AdminHome {
  metrics: {
    monthReports: number; // 今月の入力件数
    needsReview: number; // 要確認の出面
    pendingUsers: number; // 承認待ちユーザー
    invoiceCandidates: number; // 今月の請求候補（出面のある取引先数）
    draftInvoices: number; // 未発行（下書き）の請求書
    partnerReports: number; // 今月のパートナー入力件数
  };
  nextActions: NextAction[];
}

export async function getAdminHome(ym: string): Promise<AdminHome> {
  const { from, to } = monthRange(ym);
  const [
    monthRows,
    needsReview,
    pendingUsers,
    tempSites,
    setting,
    activeClients,
    draftInvoices,
    partnerReports,
  ] = await Promise.all([
    prisma.report.findMany({
      where: { workDate: { gte: from, lt: to } },
      select: { clientId: true },
    }),
    prisma.report.count({ where: { status: "NEEDS_REVIEW" } }),
    prisma.user.count({ where: { approved: false, status: "ACTIVE" } }),
    prisma.site.count({ where: { isTemporary: true, isActive: true } }),
    prisma.invoiceSetting.findFirst({ select: { issuerName: true } }),
    prisma.client.count({ where: { active: true } }),
    prisma.invoice.count({ where: { yearMonth: ym, status: "DRAFT" } }),
    prisma.report.count({
      where: { workDate: { gte: from, lt: to }, source: "PARTNER" },
    }),
  ]);

  const monthReports = monthRows.length;
  const invoiceCandidates = new Set(monthRows.map((r) => r.clientId)).size;

  const nextActions: NextAction[] = [];
  if (!setting?.issuerName?.trim()) {
    nextActions.push({
      key: "issuer",
      text: "発行元（自社情報）が未登録です",
      href: "/admin/masters#setting",
      level: "warn",
    });
  }
  if (activeClients === 0) {
    nextActions.push({
      key: "clients",
      text: "取引先が未登録です",
      href: "/admin/masters#clients",
      level: "warn",
    });
  }
  if (pendingUsers > 0) {
    nextActions.push({
      key: "users",
      text: `承認待ちユーザーが ${pendingUsers}人 います`,
      href: "/admin/users",
      level: "warn",
    });
  }
  if (needsReview > 0) {
    nextActions.push({
      key: "review",
      text: `要確認の出面が ${needsReview}件 あります`,
      href: "/admin",
      level: "warn",
    });
  }
  if (tempSites > 0) {
    nextActions.push({
      key: "spot",
      text: `要確認のスポット現場が ${tempSites}件 あります`,
      href: "/admin/masters#sites",
      level: "info",
    });
  }
  if (invoiceCandidates > 0) {
    nextActions.push({
      key: "invoice",
      text: `今月の請求書を作成できます（取引先 ${invoiceCandidates}社）`,
      href: `/admin/invoices?ym=${ym}`,
      level: "info",
    });
  }
  if (nextActions.length === 0) {
    nextActions.push({
      key: "ok",
      text: "対応が必要な項目はありません。",
      href: `/admin/invoices?ym=${ym}`,
      level: "ok",
    });
  }

  return {
    metrics: {
      monthReports,
      needsReview,
      pendingUsers,
      invoiceCandidates,
      draftInvoices,
      partnerReports,
    },
    nextActions,
  };
}

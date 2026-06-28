// ============================================================
// ロール/組織種別の表示ラベル・説明（管理画面共通）
//   実態に即した説明: 管理画面に入れるのは ADMIN のみ。OWNER/VIEWER/PARTNER は
//   LIFF入力のみ（approved 必須）。SELF はグループ投稿あり / PARTNER は保存のみ。
// ============================================================

import type { OrgKind, Role } from "@prisma/client";

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "管理者",
  OWNER: "自社メンバー",
  VIEWER: "閲覧",
  PARTNER: "パートナー",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  ADMIN: "すべて管理できる（マスタ・集計・請求・ユーザー承認）。管理画面に入れる唯一のロール。",
  OWNER: "自社の出面を入力・確認できる（管理画面には入れません）。",
  PARTNER: "所属するパートナー会社の出面だけ入力できる（管理画面には入れません）。",
  VIEWER: "閲覧のみ想定（現状は自社メンバーと同等の入力ができます）。",
};

export const ROLE_OPTIONS: Role[] = ["PARTNER", "OWNER", "VIEWER", "ADMIN"];

export const ORG_KIND_LABELS: Record<OrgKind, string> = {
  SELF: "自社入力",
  PARTNER: "パートナー入力",
};

/**
 * そのロール×組織種別で「承認後に実際できること」を1行ずつ返す（承認画面の案内用）。
 */
export function describeAccess(role: Role, orgKind: OrgKind): string[] {
  if (role === "ADMIN") {
    return [
      "管理画面に入れる（マスタ・集計・請求・ユーザー承認）",
      "全社のデータを集約して確認できる",
    ];
  }
  const where = orgKind === "PARTNER" ? "パートナー会社" : "自社";
  const post =
    orgKind === "SELF"
      ? "入力した出面は自社LINEグループに投稿される"
      : "入力した出面は保存のみ（自社グループには投稿されない）";
  return [
    `LIFF（入力フォーム）から${where}の出面を入力できる`,
    post,
    "管理画面には入れない",
  ];
}

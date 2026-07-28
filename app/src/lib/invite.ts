// ============================================================
// 招待リンク（Invite）
//
//   管理者が /admin/users で発行した URL（例: https://…/invite/<token>）を
//   LINE で送る → 受け取った本人が踏んで LINE ログイン → role/org が自動で付く。
//
//   フロー:
//     1) /invite/<token>            … 招待内容を表示（誰でも閲覧可・ログイン不要）
//     2) /api/auth/line/login?invite=<token>
//                                   … token を httpOnly クッキーに退避して LINE 認可へ
//     3) /api/auth/line/callback    … 本人確定後に redeemInvite() でロール付与
//
//   安全側の設計:
//     - token は 32 バイト乱数（base64url）。URL を知らなければ絶対に使えない。
//     - 期限（expiresAt）・使用回数（maxUses）・手動無効化（revokedAt）で失効する。
//     - 👑最高管理者は招待では変更されない（降格させない）。
//     - status=DISABLED（無効化済み）のユーザーは招待では復活しない。
//     - 使用回数の加算は条件付き UPDATE（usedCount < maxUses）で行い、
//       同時に踏まれても上限を超えない。
// ============================================================

import crypto from "node:crypto";
import type { Role } from "@prisma/client";
import { prisma } from "./db.js";

/** LINE 認可の往復で招待 token を持ち回るためのクッキー名。 */
export const INVITE_COOKIE = "demen_invite";

/** 招待リンクで付与できるロール（👑superAdmin は招待では付与しない）。 */
export const INVITABLE_ROLES = [
  "ADMIN",
  "SELF_ADMIN",
  "ORG_ADMIN",
  "OWNER",
  "PARTNER",
] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export const INVITE_ROLE_LABEL: Record<InvitableRole, string> = {
  ADMIN: "管理者（全社）",
  SELF_ADMIN: "自社管理者（自社のみ閲覧）",
  ORG_ADMIN: "協力会社管理者（その会社のみ閲覧）",
  OWNER: "自社メンバー（入力のみ）",
  PARTNER: "協力会社メンバー（入力のみ）",
};

/** 管理画面に入れるロールか（＝招待受諾後にそのままログインさせてよいか）。 */
export function roleCanEnterAdmin(role: string): boolean {
  return role === "ADMIN" || role === "SELF_ADMIN" || role === "ORG_ADMIN";
}

/** 推測不能な招待トークンを生成する（32 バイト → base64url 43 文字）。 */
export function generateInviteToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** token として形が妥当か（URL/クッキー経由の値を DB に投げる前の足切り）。 */
export function isValidInviteTokenFormat(token: string): boolean {
  return /^[A-Za-z0-9_-]{20,128}$/.test(token);
}

/** 招待 URL を組み立てる。 */
export function buildInviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/invite/${token}`;
}

export type InviteWithOrg = Awaited<ReturnType<typeof findInviteByToken>>;

/** token から招待を引く（状態は問わない。表示用）。 */
export async function findInviteByToken(token: string) {
  if (!isValidInviteTokenFormat(token)) return null;
  return prisma.invite.findUnique({
    where: { token },
    include: { org: { select: { id: true, name: true, kind: true } } },
  });
}

export type InviteState = "OK" | "REVOKED" | "EXPIRED" | "USED_UP" | "NOT_FOUND";

/** 招待の現在の状態（表示・受諾前チェックの共通判定）。 */
export function inviteState(
  invite: { revokedAt: Date | null; expiresAt: Date; maxUses: number; usedCount: number } | null,
  now: Date = new Date(),
): InviteState {
  if (!invite) return "NOT_FOUND";
  if (invite.revokedAt) return "REVOKED";
  if (invite.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  if (invite.usedCount >= invite.maxUses) return "USED_UP";
  return "OK";
}

export const INVITE_STATE_MESSAGE: Record<Exclude<InviteState, "OK">, string> = {
  NOT_FOUND: "この招待リンクは存在しません。発行者にご確認ください。",
  REVOKED: "この招待リンクは無効化されています。発行者にご確認ください。",
  EXPIRED: "この招待リンクは期限切れです。発行者に再発行を依頼してください。",
  USED_UP: "この招待リンクは使用済みです。発行者に再発行を依頼してください。",
};

export interface RedeemResult {
  ok: boolean;
  /** 失敗理由（ok=false のとき）。 */
  reason?: Exclude<InviteState, "OK"> | "DISABLED_USER" | "ERROR";
  /** 付与後のロール（ok=true のとき）。 */
  role?: Role;
  /** そのロールで管理画面に入れるか。 */
  canEnterAdmin?: boolean;
}

/**
 * 招待を消費して、本人（lineUserId）にロール／所属組織を付与する。
 * 未登録なら作成、既存なら更新。成功したら usedCount を 1 増やす。
 */
export async function redeemInvite(
  token: string,
  lineUserId: string,
  displayName: string,
): Promise<RedeemResult> {
  if (!lineUserId) return { ok: false, reason: "ERROR" };

  const invite = await findInviteByToken(token);
  const state = inviteState(invite);
  if (!invite || state !== "OK") {
    return { ok: false, reason: state === "OK" ? "ERROR" : state };
  }

  // 付与先の組織。未指定なら自社(SELF)。
  let orgId = invite.orgId;
  if (!orgId) {
    const self = await prisma.organization.findFirst({
      where: { kind: "SELF" },
      orderBy: { createdAt: "asc" },
    });
    if (!self) return { ok: false, reason: "ERROR" };
    orgId = self.id;
  }

  const existing = await prisma.user.findUnique({ where: { lineUserId } });
  // 管理者が無効化した人を招待リンクで復活させない。
  if (existing?.status === "DISABLED") {
    return { ok: false, reason: "DISABLED_USER" };
  }

  // 使用枠をここで確保する（条件付き UPDATE）。同時に踏まれても上限を超えない。
  const claimed = await prisma.invite.updateMany({
    where: {
      id: invite.id,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      usedCount: { lt: invite.maxUses },
    },
    data: {
      usedCount: { increment: 1 },
      lastUsedAt: new Date(),
      lastUsedName: displayName || "(不明)",
    },
  });
  if (claimed.count === 0) {
    // 直前に使い切られた／無効化された。
    const fresh = await findInviteByToken(token);
    const s = inviteState(fresh);
    return { ok: false, reason: s === "OK" ? "USED_UP" : s };
  }

  try {
    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: {
            // 👑最高管理者のロールは招待では動かさない（降格させない）。
            ...(existing.superAdmin ? {} : { role: invite.role, orgId }),
            approved: true,
            displayName: existing.displayName || displayName || "未設定ユーザー",
          },
        })
      : await prisma.user.create({
          data: {
            lineUserId,
            displayName: displayName?.trim() || "未設定ユーザー",
            role: invite.role,
            approved: true,
            orgId,
          },
        });

    return {
      ok: true,
      role: user.role,
      canEnterAdmin: roleCanEnterAdmin(user.role),
    };
  } catch {
    // ユーザー更新に失敗したら使用枠を戻す（リンクを無駄にしない）。
    await prisma.invite
      .update({
        where: { id: invite.id },
        data: { usedCount: { decrement: 1 } },
      })
      .catch(() => undefined);
    return { ok: false, reason: "ERROR" };
  }
}

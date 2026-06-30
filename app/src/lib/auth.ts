// ============================================================
// 認証・組織解決（アプリ層ガード）
//   - resolveUser(lineUserId)        : User+Organization を解決（初回は自動作成）
//   - resolveUserFromAccessToken(..) : LIFF アクセストークン → User+Org
//   - requireApproved(...)           : 承認済みチェック
//   - requireAdmin(...)              : ADMIN ロールチェック
//
// 3 段階ロール:
//   管理者(ADMIN)   : 管理画面に入れる。一度付与したら降格不可。
//   自社(OWNER)     : LIFF フォームのみ。出面は自社 LINE グループに投稿される。
//   協力会社(PARTNER): LIFF フォームのみ。出面は保存のみ（グループ投稿なし）。
// ============================================================

import type { Organization, User } from "@prisma/client";
import { prisma } from "./db.js";
import { resolveLineUserFromToken } from "./line.js";
import { verifySession, type SessionPayload } from "./session.js";

export interface ResolvedUser {
  user: User;
  org: Organization;
}

/**
 * 既定の SELF 組織を取得（無ければ作成）。
 * 初回 ADMIN ユーザーの所属先として使う。SELF が複数ある場合は最初の1件。
 */
async function ensureSelfOrg(): Promise<Organization> {
  const existing = await prisma.organization.findFirst({
    where: { kind: "SELF" },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;
  // SELF は DB の部分ユニークインデックス（Organization_one_self_idx）で1件に制限。
  // 初回ログインがほぼ同時に走ると、片方の create は競合で失敗する。その場合は
  // 例外にせず、既に作られた1件を取得して返す（重複は構造的に作れない）。
  try {
    return await prisma.organization.create({
      data: { name: "自社", kind: "SELF" },
    });
  } catch {
    const again = await prisma.organization.findFirst({
      where: { kind: "SELF" },
      orderBy: { createdAt: "asc" },
    });
    if (again) return again;
    throw new Error("SELF 組織の作成に失敗しました。");
  }
}

/**
 * lineUserId から User+Organization を解決する。
 * 未登録なら初回ユーザーとして作成する（自社メンバーとして登録、管理画面は入れない）。
 *
 * @param displayName  初回作成時の表示名（無ければ仮名）。
 */
export async function resolveUser(
  lineUserId: string,
  displayName?: string,
): Promise<ResolvedUser | null> {
  if (!lineUserId) return null;

  const found = await prisma.user.findUnique({
    where: { lineUserId },
    include: { org: true },
  });
  if (found) {
    return { user: found, org: found.org };
  }

  // 初回ユーザー作成。自社メンバー(OWNER)として登録。管理画面は管理者が昇格させる。
  const org = await ensureSelfOrg();
  const created = await prisma.user.create({
    data: {
      lineUserId,
      displayName: displayName?.trim() || "未設定ユーザー",
      role: "OWNER",
      approved: true,
      orgId: org.id,
    },
    include: { org: true },
  });

  return { user: created, org: created.org };
}

/**
 * LIFF アクセストークンから User+Organization を解決する。
 * トークン検証 → lineUserId → resolveUser。失敗時 null。
 */
export async function resolveUserFromAccessToken(
  accessToken: string,
): Promise<ResolvedUser | null> {
  const resolved = await resolveLineUserFromToken(accessToken);
  if (!resolved) return null;
  return resolveUser(resolved.lineUserId, resolved.displayName);
}

/**
 * Authorization ヘッダから生トークンを取り出す。
 * ★ "Bearer <token>" 形式のみ受け付ける（生トークンの直入れは拒否＝厳格化）。
 */
export function bearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const m = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const t = m[1].trim();
  return t || null;
}

/** 承認済みか。未承認なら例外向けに false。 */
export function isApproved(u: ResolvedUser): boolean {
  return u.user.approved === true;
}

/** ADMIN ロールか。 */
export function isAdmin(u: ResolvedUser): boolean {
  return u.user.role === "ADMIN";
}

/**
 * ADMIN を要求。違反時は Error を投げる（ページ/ハンドラ側で 403 等に変換）。
 */
export function requireAdmin(u: ResolvedUser | null): ResolvedUser {
  if (!u) throw new Error("UNAUTHENTICATED");
  if (u.user.status === "DISABLED") throw new Error("DISABLED");
  if (!u.user.approved) throw new Error("NOT_APPROVED");
  if (u.user.role !== "ADMIN") throw new Error("FORBIDDEN");
  return u;
}

/**
 * 承認済みを要求（入力 API 用）。違反時は Error。
 * 無効化（status=DISABLED）ユーザーは承認状態に関わらず拒否。
 */
export function requireApproved(u: ResolvedUser | null): ResolvedUser {
  if (!u) throw new Error("UNAUTHENTICATED");
  if (u.user.status === "DISABLED") throw new Error("DISABLED");
  if (!u.user.approved) throw new Error("NOT_APPROVED");
  return u;
}

// ============================================================
// 管理ダッシュボード（Server Component）向けガード
//
//  本人認証は LINE Login（OAuth）→ 署名付きクッキー（demen_session）で確定する。
//  getAdminContext() はクッキーの lineUserId から「承認済み・role=ADMIN の
//  実ユーザー」を引く（＝実際にログイン中の管理者）。クッキーが無い/失効/
//  改竄、または該当ユーザーが ADMIN でない場合は null。
//  ルート保護（/admin・管理 API）は src/middleware.ts でも二重に行う。
// ============================================================

/**
 * lineUserId が「承認済み・role=ADMIN の実ユーザー」かを引く（新規作成しない）。
 * LINE Login コールバックでセッション発行可否を判断するために使う。
 */
export async function findApprovedAdminByLineUserId(
  lineUserId: string,
): Promise<ResolvedUser | null> {
  if (!lineUserId) return null;
  const admin = await prisma.user.findFirst({
    where: { lineUserId, role: "ADMIN", approved: true, status: "ACTIVE" },
    include: { org: true },
  });
  if (!admin) return null;
  return { user: admin, org: admin.org };
}

/**
 * セッションペイロード（検証済み）から ADMIN コンテキストを解決する。
 * payload.lineUserId が現に承認済み ADMIN であることを DB で再確認する
 * （ロール剥奪・承認取消が即座に効くよう、毎リクエスト DB を引く）。
 */
export async function getAdminContextFromSession(
  session: SessionPayload | null,
): Promise<ResolvedUser | null> {
  if (!session) return null;
  return findApprovedAdminByLineUserId(session.lineUserId);
}

/**
 * 現在のリクエストの管理者コンテキストを返す。
 *   1) next/headers の cookies() から demen_session を読む
 *   2) 署名検証 → lineUserId
 *   3) 承認済み ADMIN を DB から解決（無ければ null）
 *
 * Server Component / Server Action / Route Handler から呼べる。
 * 該当が無ければ null（呼び出し側で 403/ログイン誘導）。
 */
export async function getAdminContext(): Promise<ResolvedUser | null> {
  // next/headers は Server Component / Action / Route Handler でのみ利用可。
  // 動的 import で middleware（Edge）からの誤用時に副作用を避ける。
  const { cookies } = await import("next/headers");
  const store = await cookies();
  // cookies().get().value は復号済みの生値。verifySession に直接渡す
  // （parseCookie の再 decode を避ける）。
  const raw = store.get("demen_session")?.value;
  const session = verifySession(raw);
  return getAdminContextFromSession(session);
}

/**
 * セッションが存在するが ADMIN でないユーザーを返す（ロール問わず）。
 * 「管理者に招待してもらってください」画面の表示判定に使う。
 */
export async function getSessionUserIfExists(): Promise<ResolvedUser | null> {
  const { cookies } = await import("next/headers");
  const store = await cookies();
  const raw = store.get("demen_session")?.value;
  const session = verifySession(raw);
  if (!session) return null;
  const user = await prisma.user.findFirst({
    where: { lineUserId: session.lineUserId, status: "ACTIVE" },
    include: { org: true },
  });
  if (!user) return null;
  return { user, org: user.org };
}

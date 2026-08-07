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

import { cache } from "react";
import type { Organization, User } from "@prisma/client";
import { prisma } from "./db.js";
import { resolveLineUserFromToken } from "./line.js";
import { verifySession, type SessionPayload } from "./session.js";

export interface ResolvedUser {
  user: User;
  org: Organization;
}

// ============================================================
// 初期 ADMIN 付与（ブートストラップ）
//
//   `ADMIN_LINE_USER_IDS`（カンマ区切りの lineUserId）に載っている本人は、
//   LIFF を開いた時／管理ログインした時に自動で role=ADMIN・approved=true へ
//   昇格する（README / DEPLOY.md に書かれている挙動の実装）。
//   これが無いと、初回ユーザーは OWNER で作られるため誰も管理画面に入れない
//   ＝「管理権限がありません」で詰む。
//
//   安全側の制約:
//     - 環境変数に明示された lineUserId のみ（＝URL を知った第三者は昇格しない）
//     - status=DISABLED の無効化ユーザーは復活させない
//     - 👑最高管理者(superAdmin) は「まだ 1 人もいない時」だけ立てる
// ============================================================

/** `ADMIN_LINE_USER_IDS` を配列で返す（空要素は捨てる）。 */
export function adminBootstrapLineUserIds(): string[] {
  return (process.env.ADMIN_LINE_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** その lineUserId が初期 ADMIN 指定に含まれるか。 */
export function isBootstrapAdminLineUserId(lineUserId: string): boolean {
  if (!lineUserId) return false;
  return adminBootstrapLineUserIds().includes(lineUserId);
}

/**
 * 初期 ADMIN 指定のユーザーを ADMIN・承認済みへ昇格させる（該当しなければ何もしない）。
 * 既に ADMIN かつ承認済みなら DB を触らない（毎リクエスト呼ばれても実質ノーコスト）。
 */
export async function applyAdminBootstrap(
  u: ResolvedUser,
): Promise<ResolvedUser> {
  if (!isBootstrapAdminLineUserId(u.user.lineUserId)) return u;
  // 管理者が意図的に無効化したユーザーを env で復活させない。
  if (u.user.status === "DISABLED") return u;
  if (u.user.role === "ADMIN" && u.user.approved) return u;

  // 👑最高管理者が不在なら、この初期 ADMIN を最高管理者にする。
  const hasSuperAdmin =
    (await prisma.user.count({ where: { superAdmin: true } })) > 0;

  const updated = await prisma.user.update({
    where: { id: u.user.id },
    data: {
      role: "ADMIN",
      approved: true,
      ...(hasSuperAdmin ? {} : { superAdmin: true }),
    },
    include: { org: true },
  });
  return { user: updated, org: updated.org };
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
    // 初期 ADMIN 指定（ADMIN_LINE_USER_IDS）なら管理者へ昇格させる。
    return applyAdminBootstrap({ user: found, org: found.org });
  }

  // 初回ユーザー作成。自社メンバー(OWNER)として登録。管理画面は管理者が昇格させる。
  // ただし初期 ADMIN 指定の本人は、最初から ADMIN（承認済み）で作る。
  const isBootstrapAdmin = isBootstrapAdminLineUserId(lineUserId);
  const org = await ensureSelfOrg();
  const hasSuperAdmin = isBootstrapAdmin
    ? (await prisma.user.count({ where: { superAdmin: true } })) > 0
    : true;
  const created = await prisma.user.create({
    data: {
      lineUserId,
      displayName: displayName?.trim() || "未設定ユーザー",
      role: isBootstrapAdmin ? "ADMIN" : "OWNER",
      approved: true,
      superAdmin: isBootstrapAdmin && !hasSuperAdmin,
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

/**
 * 管理画面に入れる「スコープ管理者」ロール（自分の所属組織のみ閲覧）。
 *   SELF_ADMIN … 自社のみ閲覧（所属＝自社 SELF 組織）。
 *   ORG_ADMIN  … 自分の所属組織のみ閲覧（自社でも特定の協力会社でも可）。
 * いずれも閲覧範囲は u.org（自分の所属組織）に限定される。
 */
const SCOPED_ADMIN_ROLES = ["SELF_ADMIN", "ORG_ADMIN"] as const;

/** 管理画面に入れるロールか（ADMIN またはスコープ管理者）。 */
export function isAdmin(u: ResolvedUser): boolean {
  return (
    u.user.role === "ADMIN" ||
    (SCOPED_ADMIN_ROLES as readonly string[]).includes(u.user.role)
  );
}

/**
 * 管理者の閲覧スコープ。
 *   "ALL" : 自社＋全協力会社（フル管理者 ADMIN）。
 *   "ORG" : 自分の所属組織のみ（SELF_ADMIN / ORG_ADMIN）。
 */
export function adminScope(u: ResolvedUser): "ALL" | "ORG" {
  return (SCOPED_ADMIN_ROLES as readonly string[]).includes(u.user.role)
    ? "ORG"
    : "ALL";
}

/** スコープ管理者（自組織のみ閲覧）なら、その対象 orgId。フル管理者は null。 */
export function adminScopeOrgId(u: ResolvedUser): string | null {
  return adminScope(u) === "ORG" ? u.org.id : null;
}

/** スコープ管理者（自組織のみ閲覧）か。 */
export function isScopedAdmin(u: ResolvedUser): boolean {
  return adminScope(u) === "ORG";
}

/** 👑最高管理者か（降格/無効化/削除されず、他の管理者を降格できる）。 */
export function isSuperAdmin(u: ResolvedUser): boolean {
  return u.user.superAdmin === true;
}

/**
 * 管理者（ADMIN / スコープ管理者）を要求。違反時は Error を投げる
 * （ページ/ハンドラ側で 403 等に変換）。
 */
export function requireAdmin(u: ResolvedUser | null): ResolvedUser {
  if (!u) throw new Error("UNAUTHENTICATED");
  if (u.user.status === "DISABLED") throw new Error("DISABLED");
  if (!u.user.approved) throw new Error("NOT_APPROVED");
  if (!isAdmin(u)) throw new Error("FORBIDDEN");
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
 * lineUserId が「承認済み・管理者タイプ（ADMIN / SELF_ADMIN）の実ユーザー」かを
 * 引く（新規作成しない）。LINE Login コールバックでセッション発行可否を判断する
 * ために使う。SELF_ADMIN も管理画面に入れる（閲覧スコープは自社のみ）。
 */
export async function findApprovedAdminByLineUserId(
  lineUserId: string,
): Promise<ResolvedUser | null> {
  if (!lineUserId) return null;
  const admin = await prisma.user.findFirst({
    where: {
      lineUserId,
      role: { in: ["ADMIN", "SELF_ADMIN", "ORG_ADMIN"] },
      approved: true,
      status: "ACTIVE",
    },
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
// React cache() で「同一リクエスト内は1回だけ」に絞る。/admin は layout と page の
// 両方がこれを呼ぶため、素のままだと 1 画面ごとに同じ user 検索が 2 回以上 DB へ飛ぶ。
// リクエストをまたいだキャッシュではないので、ロール剥奪・承認取消は次のリクエストで
// 即座に効く（多層防御の前提は変わらない）。
export const getAdminContext = cache(
  async function getAdminContext(): Promise<ResolvedUser | null> {
    // next/headers は Server Component / Action / Route Handler でのみ利用可。
    // 動的 import で middleware（Edge）からの誤用時に副作用を避ける。
    const { cookies } = await import("next/headers");
    const store = await cookies();
    // cookies().get().value は復号済みの生値。verifySession に直接渡す
    // （parseCookie の再 decode を避ける）。
    const raw = store.get("demen_session")?.value;
    const session = verifySession(raw);
    return getAdminContextFromSession(session);
  },
);

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

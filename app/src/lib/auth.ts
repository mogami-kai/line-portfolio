// ============================================================
// 認証・組織解決（アプリ層ガード）
//   - resolveUser(lineUserId)        : User+Organization を解決（初回は自動作成）
//   - resolveUserFromAccessToken(..) : LIFF アクセストークン → User+Org
//   - requireApproved(...)           : 承認済みチェック
//   - requireAdmin(...)              : ADMIN ロールチェック
//
// 初回ユーザーは未承認（approved=false）で作成。
//   ADMIN_LINE_USER_IDS に含まれる lineUserId → role=ADMIN・SELF 組織に所属。
//   それ以外                              → role=PARTNER（管理者が後で org/role 承認）。
// ============================================================

import type { Organization, Role, User } from "@prisma/client";
import { prisma } from "./db.js";
import { resolveLineUserFromToken } from "./line.js";

export interface ResolvedUser {
  user: User;
  org: Organization;
}

/** ADMIN_LINE_USER_IDS（カンマ区切り）を配列で返す。 */
function adminLineUserIds(): string[] {
  return (process.env.ADMIN_LINE_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAdminLineUserId(lineUserId: string): boolean {
  return adminLineUserIds().includes(lineUserId);
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
  return prisma.organization.create({
    data: { name: "自社", kind: "SELF" },
  });
}

/**
 * 非ADMIN初回ユーザーの暫定所属先（PARTNER）。SELFには絶対入れないための受け皿。
 * 承認漏れでも自社グループに漏れないことを構造で担保する。管理者が後で正式な
 * パートナー組織へ付け替える。
 */
async function ensurePendingPartnerOrg(): Promise<Organization> {
  const name = "未割当（承認待ち）";
  const existing = await prisma.organization.findFirst({
    where: { kind: "PARTNER", name },
  });
  if (existing) return existing;
  return prisma.organization.create({ data: { name, kind: "PARTNER" } });
}

/**
 * lineUserId から User+Organization を解決する。
 * 未登録なら初回ユーザーとして作成（未承認）。
 *   - ADMIN_LINE_USER_IDS に一致 → role=ADMIN / approved=true / SELF 組織
 *   - それ以外                    → role=PARTNER / approved=false / 暫定 SELF 組織
 *     （管理者が後で org（パートナー）/role を割り当てる）
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

  // 初回ユーザー作成。
  const isAdmin = isAdminLineUserId(lineUserId);
  const role: Role = isAdmin ? "ADMIN" : "PARTNER";
  // ★不可視性の担保: 非ADMINは絶対にSELF組織に入れない（承認漏れでも自社に出ない）。
  //   ADMIN → SELF / それ以外 → PARTNER「未割当（承認待ち）」。管理者が後で正式orgへ。
  const org = isAdmin ? await ensureSelfOrg() : await ensurePendingPartnerOrg();

  const created = await prisma.user.create({
    data: {
      lineUserId,
      displayName: displayName?.trim() || "未設定ユーザー",
      role,
      // ADMIN は即時利用可。一般初回ユーザーは管理者承認待ち。
      approved: isAdmin,
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

/** Authorization ヘッダ（"Bearer xxx" 形式可）から生トークンを取り出す。 */
export function bearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const m = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : authorizationHeader.trim();
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
  if (!u.user.approved) throw new Error("NOT_APPROVED");
  if (u.user.role !== "ADMIN") throw new Error("FORBIDDEN");
  return u;
}

/**
 * 承認済みを要求（入力 API 用）。違反時は Error。
 */
export function requireApproved(u: ResolvedUser | null): ResolvedUser {
  if (!u) throw new Error("UNAUTHENTICATED");
  if (!u.user.approved) throw new Error("NOT_APPROVED");
  return u;
}

// ============================================================
// 管理ダッシュボード（Server Component）向けガード
//
//  本番では LINE Login のセッション Cookie で本人を確定すべきだが、
//  本フェーズでは LINE Login セッション基盤を未導入のため、
//  「ADMIN_LINE_USER_IDS で設定された ADMIN ユーザーが存在するか」を最低限の
//  存在ガードとして用いる（実運用ではミドルウェア/プロキシでの保護を併用）。
//  TODO(P2+): NextAuth 等で LINE Login セッション化し、本人 lineUserId で厳格判定。
// ============================================================

/**
 * 管理画面の表示可否を返す。設定済み ADMIN（ADMIN_LINE_USER_IDS のいずれか）が
 * DB に存在し、承認済み・role=ADMIN であれば、その代表ユーザーを返す。
 * 該当が無ければ null（呼び出し側で 403/未設定案内）。
 */
export async function getAdminContext(): Promise<ResolvedUser | null> {
  const ids = adminLineUserIds();
  if (ids.length === 0) return null;
  const admin = await prisma.user.findFirst({
    where: { lineUserId: { in: ids }, role: "ADMIN", approved: true },
    include: { org: true },
  });
  if (!admin) return null;
  return { user: admin, org: admin.org };
}

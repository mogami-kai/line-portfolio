// ============================================================
// /admin/users — ユーザー管理（ロール付与・ロール作成）
//
//   タブ: 管理者 / 自社 / 協力会社（?tab=admin|self|partner）。
//   ロール体系:
//     - 👑管理者(superAdmin): 最高権限。降格/無効化/削除されない。他の管理者を降格できる。
//     - 管理者(ADMIN): 全社の全権限。👑により降格され得る。
//     - 自社管理者(SELF_ADMIN): 自社の集計のみ閲覧。
//     - 協力会社管理者(ORG_ADMIN): 割り当てた協力会社のみ閲覧。
//     - 自社(OWNER)/協力会社(PARTNER): 入力のみ。
//   「ロール作成」= 協力会社（PARTNER 組織）を量産する入口。
//   ガード: 全社管理者のみ（スコープ管理者はホームへ）。
// ============================================================

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db.js";
import { getAdminContext, adminScope } from "@/lib/auth.js";
import { setUserStatusAction, deleteUserAction } from "../_actions.js";
import { ConfirmDeleteButton } from "../_confirmDelete.js";
import { RoleCreateButton } from "./_roleCreateButton.js";
import { UserRoleForm } from "./_userRoleForm.js";

export const dynamic = "force-dynamic";

type Tab = "admin" | "self" | "partner";

const fmtDateTime = (d: Date) =>
  d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const admin = await getAdminContext();
  if (!admin) redirect("/admin?error=login");
  // スコープ管理者（自社/協力会社管理者）はユーザー管理を見られない（ホームへ）。
  if (adminScope(admin) === "ORG") redirect("/admin");

  const sp = await searchParams;
  const tab: Tab =
    sp.tab === "self" ? "self" : sp.tab === "partner" ? "partner" : "admin";

  const [users, allOrgs] = await Promise.all([
    prisma.user.findMany({
      orderBy: [{ createdAt: "desc" }],
      include: { org: { select: { id: true, name: true, kind: true } } },
    }),
    prisma.organization.findMany({ orderBy: [{ kind: "asc" }, { createdAt: "asc" }] }),
  ]);

  // 管理者タブには ADMIN ＋ スコープ管理者（自社/協力会社管理者）をまとめる。
  const isManagerUser = (u: (typeof users)[number]) =>
    u.role === "ADMIN" || u.role === "SELF_ADMIN" || u.role === "ORG_ADMIN";
  const isSelfUser = (u: (typeof users)[number]) =>
    u.org.kind === "SELF" && !isManagerUser(u);
  const isPartnerUser = (u: (typeof users)[number]) =>
    u.org.kind === "PARTNER" && !isManagerUser(u);

  const counts = {
    admin: users.filter(isManagerUser).length,
    self: users.filter(isSelfUser).length,
    partner: users.filter(isPartnerUser).length,
  };

  const shown = users.filter(
    tab === "admin" ? isManagerUser : tab === "self" ? isSelfUser : isPartnerUser,
  );

  const TABS: { key: Tab; label: string; n: number }[] = [
    { key: "admin", label: "管理者", n: counts.admin },
    { key: "self", label: "自社", n: counts.self },
    { key: "partner", label: "協力会社", n: counts.partner },
  ];

  const emptyLabel =
    tab === "admin"
      ? "管理者はいません。"
      : tab === "self"
        ? "自社メンバーはいません。"
        : "協力会社メンバーはいません。";

  // 役割バッジの表示ラベル。
  const roleBadge = (u: (typeof users)[number]) => {
    if (u.superAdmin) return "👑管理者";
    if (u.role === "ADMIN") return "管理者";
    if (u.role === "SELF_ADMIN") return "自社管理者";
    if (u.role === "ORG_ADMIN") return "協力会社管理者";
    return u.org.kind === "PARTNER" ? "協力会社" : "自社";
  };

  return (
    <main className="container admin-narrow">
      <div className="page-head">
        <h1 className="page-title">ユーザー管理</h1>
      </div>

      {/* ロール作成（協力会社を量産） */}
      <div style={{ marginBottom: 12 }}>
        <RoleCreateButton />
      </div>

      {/* タブ */}
      <div className="chip-wrap" style={{ marginBottom: 12 }}>
        {TABS.map((t) => (
          <a
            key={t.key}
            href={`/admin/users?tab=${t.key}`}
            className={`chip ${tab === t.key ? "chip--on" : ""}`}
          >
            {t.label} {t.n}
          </a>
        ))}
      </div>

      <div className="list" style={{ background: "transparent", border: "none" }}>
        {shown.length === 0 && <p className="muted">{emptyLabel}</p>}
        {shown.map((u) => {
          const isDisabled = u.status === "DISABLED";
          const isSelf = admin.user.id === u.id;
          const isSuper = u.superAdmin;

          return (
            <details className="card" key={u.id}>
              <summary className="list-title" style={{ cursor: "pointer" }}>
                {u.displayName}
                {isDisabled && (
                  <span className="badge" style={{ marginLeft: 6 }}>無効</span>
                )}
                <span
                  className={`badge ${isManagerUser(u) ? "badge--review" : u.org.kind === "PARTNER" ? "badge--partner" : "badge--self"}`}
                  style={{ marginLeft: 6 }}
                >
                  {roleBadge(u)}
                </span>
                <span className="muted" style={{ marginLeft: 8 }}>
                  {u.org.name}
                </span>
              </summary>

              <div className="list-meta" style={{ marginTop: 8 }}>
                登録: {fmtDateTime(u.createdAt)}
              </div>

              {/* 👑最高管理者は変更不可。それ以外はロール変更フォーム（失敗はインライン表示）。 */}
              {isSuper ? (
                <p className="muted" style={{ marginTop: 8 }}>
                  👑最高管理者（変更できません）。
                </p>
              ) : (
                !isDisabled && (
                  <UserRoleForm
                    userId={u.id}
                    defaultRole={
                      u.role === "PARTNER"
                        ? "PARTNER"
                        : u.role === "SELF_ADMIN"
                          ? "SELF_ADMIN"
                          : u.role === "ORG_ADMIN"
                            ? "ORG_ADMIN"
                            : u.role === "ADMIN"
                              ? "ADMIN"
                              : "OWNER"
                    }
                    defaultOrgId={u.orgId}
                    orgs={allOrgs.map((o) => ({
                      id: o.id,
                      name: o.name,
                      kind: o.kind as "SELF" | "PARTNER",
                    }))}
                  />
                )
              )}

              {/* 無効化 / 復活 / 削除（👑・自分自身は不可） */}
              {!isSuper && !isSelf && (
                <div
                  style={{
                    marginTop: 10,
                    display: "flex",
                    gap: 10,
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <form action={setUserStatusAction}>
                    <input type="hidden" name="userId" value={u.id} />
                    <input
                      type="hidden"
                      name="status"
                      value={isDisabled ? "ACTIVE" : "DISABLED"}
                    />
                    <button
                      type="submit"
                      className={isDisabled ? "btn btn--ghost btn--sm" : "btn btn--danger-text btn--sm"}
                    >
                      {isDisabled ? "復活（有効化）" : "無効化"}
                    </button>
                  </form>

                  <ConfirmDeleteButton
                    action={deleteUserAction}
                    id={u.id}
                    label="削除"
                    confirmText="このユーザーを削除します。よろしいですか？（取り消せません）"
                  />
                </div>
              )}
            </details>
          );
        })}
      </div>
    </main>
  );
}

// ============================================================
// /admin/users — ユーザー管理（管理者 / 自社 / 協力会社）
//
//   タブ: 管理者 / 自社 / 協力会社（?tab=admin|self|partner）。
//   - 管理者(ADMIN): 降格不可。無効化・削除のみ。
//   - 自社(OWNER/SELF): 自社 LINE グループに投稿される。→ 協力会社・管理者に変更可。
//   - 協力会社(PARTNER): 出面は保存のみ（グループ投稿なし）。→ 自社・管理者に変更可。
//   ガード: getAdminContext() ＋ middleware。
// ============================================================

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db.js";
import { getAdminContext, adminScopeOrgId } from "@/lib/auth.js";
import { approveUserAction, setUserStatusAction, deleteUserAction } from "../_actions.js";
import { ConfirmDeleteButton } from "../_confirmDelete.js";

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

  // スコープ管理者（自組織のみ閲覧）はユーザー管理ができない（閲覧のみ）。
  const scopeOrgId = adminScopeOrgId(admin);
  const scoped = scopeOrgId !== null;
  const canManage = !scoped; // ロール変更・無効化・削除は全社管理者のみ。

  const sp = await searchParams;
  let tab: Tab =
    sp.tab === "self" ? "self" : sp.tab === "partner" ? "partner" : "admin";

  const [allUsers, allOrgs] = await Promise.all([
    prisma.user.findMany({
      orderBy: [{ createdAt: "desc" }],
      include: { org: { select: { id: true, name: true, kind: true } } },
    }),
    // ロール割当の対象組織チューザー用（全社管理者のみ使う）。
    canManage
      ? prisma.organization.findMany({ orderBy: [{ kind: "asc" }, { createdAt: "asc" }] })
      : Promise.resolve(
          [] as Awaited<ReturnType<typeof prisma.organization.findMany>>,
        ),
  ]);

  const isAdminUser = (u: (typeof allUsers)[number]) => u.role === "ADMIN";
  const isSelfUser = (u: (typeof allUsers)[number]) =>
    u.org.kind === "SELF" && u.role !== "ADMIN";
  const isPartnerUser = (u: (typeof allUsers)[number]) =>
    u.org.kind === "PARTNER";

  // スコープ管理者は自組織のユーザーのみ閲覧。
  const users = scoped
    ? allUsers.filter((u) => u.org.id === scopeOrgId)
    : allUsers;

  const counts = {
    admin: users.filter(isAdminUser).length,
    self: users.filter(isSelfUser).length,
    partner: users.filter(isPartnerUser).length,
  };

  // スコープ時はタブ無しで自組織ユーザーを一覧表示。
  const shown = scoped
    ? users
    : users.filter(
        tab === "admin"
          ? isAdminUser
          : tab === "self"
            ? isSelfUser
            : isPartnerUser,
      );

  const TABS: { key: Tab; label: string; n: number }[] = [
    { key: "admin", label: "管理者", n: counts.admin },
    { key: "self", label: "自社", n: counts.self },
    { key: "partner", label: "協力会社", n: counts.partner },
  ];

  const emptyLabel =
    scoped
      ? "ユーザーはいません。"
      : tab === "admin"
        ? "管理者はいません。"
        : tab === "self"
          ? "自社メンバーはいません。"
          : "協力会社メンバーはいません。";

  return (
    <main className="container admin-narrow">
      <div className="page-head">
        <h1 className="page-title">ユーザー管理</h1>
      </div>

      {/* タブ（スコープ管理者は自組織のみのため非表示） */}
      {!scoped && (
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
      )}

      <div className="list" style={{ background: "transparent", border: "none" }}>
        {shown.length === 0 && <p className="muted">{emptyLabel}</p>}
        {shown.map((u) => {
          const isDisabled = u.status === "DISABLED";
          const isCurrentAdmin = isAdminUser(u);
          const isSelf = admin.user.id === u.id;

          return (
            <details className="card" key={u.id}>
              <summary className="list-title" style={{ cursor: "pointer" }}>
                {u.displayName}
                {isDisabled && (
                  <span className="badge" style={{ marginLeft: 6 }}>無効</span>
                )}
                <span
                  className={`badge ${isCurrentAdmin ? "badge--review" : u.org.kind === "PARTNER" ? "badge--partner" : "badge--self"}`}
                  style={{ marginLeft: 6 }}
                >
                  {isCurrentAdmin ? "管理者" : u.org.kind === "PARTNER" ? "協力会社" : "自社"}
                </span>
                <span className="muted" style={{ marginLeft: 8 }}>
                  {u.org.name}
                </span>
              </summary>

              <div className="list-meta" style={{ marginTop: 8 }}>
                登録: {fmtDateTime(u.createdAt)}
              </div>

              {/* ロール管理は全社管理者のみ（スコープ管理者は閲覧のみ）。 */}
              {canManage &&
                (isCurrentAdmin ? (
                  <p className="muted" style={{ marginTop: 8 }}>
                    管理者は降格できません。
                  </p>
                ) : (
                  !isDisabled && (
                    <form action={approveUserAction} style={{ marginTop: 12 }}>
                      <input type="hidden" name="userId" value={u.id} />
                      <input type="hidden" name="approved" value="true" />
                      <div className="field">
                        <label className="label">役割</label>
                        <select
                          className="select"
                          name="role"
                          defaultValue={
                            u.role === "PARTNER"
                              ? "PARTNER"
                              : u.role === "SELF_ADMIN"
                                ? "SELF_ADMIN"
                                : u.role === "ORG_ADMIN"
                                  ? "ORG_ADMIN"
                                  : "OWNER"
                          }
                        >
                          <option value="OWNER">自社（LINEグループに投稿）</option>
                          <option value="PARTNER">協力会社（保存のみ）</option>
                          <option value="SELF_ADMIN">
                            自社管理者（自社のみ閲覧）
                          </option>
                          <option value="ORG_ADMIN">
                            組織管理者（選んだ組織のみ閲覧）
                          </option>
                          <option value="ADMIN">管理者に昇格（元に戻せません）</option>
                        </select>
                      </div>
                      {allOrgs.length > 0 && (
                        <div className="field">
                          <label className="label">
                            対象組織（協力会社／組織管理者を選んだ場合）
                          </label>
                          <select
                            className="select"
                            name="orgId"
                            defaultValue={u.orgId}
                          >
                            {allOrgs.map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.name}（{o.kind === "SELF" ? "自社" : "協力会社"}）
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      <div style={{ marginTop: 10 }}>
                        <button className="btn btn--primary" type="submit">
                          保存
                        </button>
                      </div>
                    </form>
                  )
                ))}

              {/* 無効化 / 復活 / 削除（全社管理者のみ） */}
              {canManage && (
                <div
                  style={{
                    marginTop: 10,
                    display: "flex",
                    gap: 10,
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  {!isSelf && (
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
                  )}

                  {!isSelf && (
                    <ConfirmDeleteButton
                      action={deleteUserAction}
                      id={u.id}
                      label="削除"
                      confirmText="このユーザーを削除します。よろしいですか？（取り消せません）"
                    />
                  )}
                </div>
              )}
            </details>
          );
        })}
      </div>

    </main>
  );
}

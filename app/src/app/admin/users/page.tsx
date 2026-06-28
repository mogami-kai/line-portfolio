// ============================================================
// /admin/users — ユーザー承認（Server Component ＋ Server Action）
//
//   タブ: 承認待ち / 承認済み / 無効（?tab=pending|approved|disabled）。
//   - LINE から入ってきた人を、所属組織と権限を決めて「承認」する場所。
//   - role×org.kind の整合は approveUserAction が強制（自社グループに漏らさない）。
//   - 拒否/無効化は setUserStatusAction（status=DISABLED）。復活は ACTIVE。
//   ガード: getAdminContext() ＋ middleware。
// ============================================================

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db.js";
import { getAdminContext } from "@/lib/auth.js";
import { approveUserAction, setUserStatusAction } from "../_actions.js";
import { HelpToggle } from "../_help.js";
import {
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  ROLE_OPTIONS,
  describeAccess,
} from "@/lib/roles.js";

export const dynamic = "force-dynamic";

type Tab = "pending" | "approved" | "disabled";

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

  const sp = await searchParams;
  const tab: Tab =
    sp.tab === "approved" ? "approved" : sp.tab === "disabled" ? "disabled" : "pending";

  const [users, orgs] = await Promise.all([
    prisma.user.findMany({
      orderBy: [{ approved: "asc" }, { createdAt: "desc" }],
      include: { org: { select: { name: true, kind: true } } },
    }),
    prisma.organization.findMany({ orderBy: { createdAt: "asc" } }),
  ]);

  const selfOrgs = orgs.filter((o) => o.kind === "SELF");
  const partnerOrgs = orgs.filter((o) => o.kind === "PARTNER");

  const isPending = (u: (typeof users)[number]) =>
    u.status === "ACTIVE" && !u.approved;
  const isApproved = (u: (typeof users)[number]) =>
    u.status === "ACTIVE" && u.approved;
  const isDisabled = (u: (typeof users)[number]) => u.status === "DISABLED";

  const counts = {
    pending: users.filter(isPending).length,
    approved: users.filter(isApproved).length,
    disabled: users.filter(isDisabled).length,
  };
  const shown = users.filter(
    tab === "pending" ? isPending : tab === "approved" ? isApproved : isDisabled,
  );

  const TABS: { key: Tab; label: string; n: number }[] = [
    { key: "pending", label: "承認待ち", n: counts.pending },
    { key: "approved", label: "承認済み", n: counts.approved },
    { key: "disabled", label: "無効", n: counts.disabled },
  ];

  const emptyLabel =
    tab === "pending"
      ? "承認待ちのユーザーはいません。"
      : tab === "approved"
        ? "承認済みのユーザーはいません。"
        : "無効化したユーザーはいません。";

  return (
    <main className="container">
      <div className="page-head">
        <h1 className="page-title">ユーザー承認</h1>
        <HelpToggle />
      </div>

      <div className="help-bubble">
        <b>これは何？</b>{" "}
        LINEから入ってきた人を、このシステムの利用者として登録し、{" "}
        <b>所属組織</b>と<b>権限</b>を決める場所です。承認するまで本人は入力・閲覧できません。
        <br />
        <b>権限の意味</b>
        <br />
        {ROLE_OPTIONS.map((r) => (
          <span key={r} style={{ display: "block", marginTop: 2 }}>
            ・<b>{ROLE_LABELS[r]}</b>：{ROLE_DESCRIPTIONS[r]}
          </span>
        ))}
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

      {tab === "pending" && counts.pending > 0 && (
        <p className="muted" style={{ marginBottom: 10 }}>
          ※ 協力会社のメンバーは <strong>協力会社</strong> に、ADMIN/自社メンバーは{" "}
          <strong>自社</strong> に割り当ててください（ロールと組織の整合が必要です）。
        </p>
      )}

      <div className="list" style={{ background: "transparent", border: "none" }}>
        {shown.length === 0 && <p className="muted">{emptyLabel}</p>}
        {shown.map((u) => {
          const isPartnerOrg = u.org.kind === "PARTNER";
          const access = describeAccess(u.role, u.org.kind);
          return (
            <details className="card" key={u.id} open={tab === "pending"}>
              <summary className="list-title" style={{ cursor: "pointer" }}>
                {u.displayName}
                <span
                  className={`badge ${
                    isDisabled(u)
                      ? "badge"
                      : u.approved
                        ? "badge--self"
                        : "badge--review"
                  }`}
                  style={{ marginLeft: 6 }}
                >
                  {isDisabled(u) ? "無効" : u.approved ? "承認済み" : "未承認"}
                </span>
                <span
                  className={`badge ${isPartnerOrg ? "badge--partner" : "badge--self"}`}
                  style={{ marginLeft: 4 }}
                >
                  {isPartnerOrg ? "協力会社" : "自社"}
                </span>
                <span className="muted" style={{ marginLeft: 8 }}>
                  {ROLE_LABELS[u.role] ?? u.role} / {u.org.name}
                </span>
              </summary>

              <div className="list-meta" style={{ marginTop: 8 }}>
                初回登録: {fmtDateTime(u.createdAt)}　/　入口:{" "}
                {u.role === "ADMIN" ? "管理者登録" : "LIFF（出面フォーム）"}
                <br />
                lineUserId: <code>{u.lineUserId}</code>
              </div>

              {/* 現在の割り当てでできること */}
              <div className="help-bubble" style={{ marginTop: 10 }}>
                <b>現在の割り当てでできること</b>
                {access.map((a, i) => (
                  <span key={i} style={{ display: "block", marginTop: 2 }}>
                    ・{a}
                  </span>
                ))}
              </div>

              {!isDisabled(u) && (
                <form action={approveUserAction} style={{ marginTop: 12 }}>
                  <input type="hidden" name="userId" value={u.id} />
                  <div className="field">
                    <label className="label">権限（ロール）</label>
                    <select className="select" name="role" defaultValue={u.role}>
                      {ROLE_OPTIONS.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="label">所属組織</label>
                    <select className="select" name="orgId" defaultValue={u.orgId}>
                      <optgroup label="協力会社">
                        {partnerOrgs.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="自社">
                        {selfOrgs.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                    <p className="hint">
                      ※ 協力会社のメンバーは協力会社に、管理者/自社メンバーは自社に割り当てます。
                    </p>
                  </div>
                  <label className="inline-row" style={{ gap: 8 }}>
                    <input type="checkbox" name="approved" defaultChecked={u.approved} />
                    <span>承認する（使えるようにする）</span>
                  </label>
                  <div
                    style={{
                      marginTop: 10,
                      display: "flex",
                      gap: 10,
                      alignItems: "center",
                    }}
                  >
                    <button className="btn btn--primary" type="submit">
                      保存
                    </button>
                  </div>
                </form>
              )}

              {/* 無効化 / 復活 */}
              <form action={setUserStatusAction} style={{ marginTop: 10 }}>
                <input type="hidden" name="userId" value={u.id} />
                <input
                  type="hidden"
                  name="status"
                  value={isDisabled(u) ? "ACTIVE" : "DISABLED"}
                />
                <button
                  type="submit"
                  className={isDisabled(u) ? "btn btn--ghost btn--sm" : "btn btn--danger-text btn--sm"}
                >
                  {isDisabled(u) ? "復活（有効化）" : "拒否 / 無効化"}
                </button>
              </form>
            </details>
          );
        })}
      </div>

      <p className="muted" style={{ marginTop: 20 }}>
        ※ 初回ユーザーは「未割当（承認待ち）」に入り、自社には出ません。ここで正式な組織・権限へ割り当ててください。無効化した人は承認状態に関わらず入室できません。
      </p>
    </main>
  );
}

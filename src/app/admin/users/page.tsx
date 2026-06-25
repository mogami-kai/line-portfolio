// ============================================================
// /admin/users — ユーザー承認（Server Component ＋ Server Action）
//
//   ガード: getAdminContext()（無ければログイン画面へ）＋ middleware。
//   - 未承認（approved=false）ユーザーを先頭に、全ユーザーを一覧。
//   - 各ユーザーに role / 所属org を割り当てて「承認」。
//     ★ パートナーは必ず PARTNER 組織へ（自社グループに漏らさない）。
//        approveUserAction 側で role×org.kind の整合性を強制する。
//   モバイルファースト（globals.css のクラスを流用）。
// ============================================================

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db.js";
import { getAdminContext } from "@/lib/auth.js";
import { approveUserAction } from "../_actions.js";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "管理者",
  OWNER: "自社代表",
  VIEWER: "自社メンバー",
  PARTNER: "パートナー",
};

export default async function UsersPage() {
  const admin = await getAdminContext();
  if (!admin) redirect("/admin?error=login");

  const [users, orgs] = await Promise.all([
    prisma.user.findMany({
      orderBy: [{ approved: "asc" }, { createdAt: "desc" }],
      include: { org: { select: { name: true, kind: true } } },
    }),
    prisma.organization.findMany({ orderBy: { createdAt: "asc" } }),
  ]);

  const selfOrgs = orgs.filter((o) => o.kind === "SELF");
  const partnerOrgs = orgs.filter((o) => o.kind === "PARTNER");
  const pending = users.filter((u) => !u.approved);

  return (
    <main className="container">
      <div className="page-head">
        <h1 className="page-title">ユーザー承認</h1>
        <a href="/admin" className="badge">← 管理</a>
      </div>

      <div className="stat-grid">
        <div className="stat stat--accent stat--wide">
          <div className="stat-k">承認待ち</div>
          <div className="stat-v">{pending.length}<small> 人</small></div>
        </div>
      </div>

      <p className="muted" style={{ marginBottom: 10 }}>
        ※ パートナーは <strong>PARTNER 組織</strong> に割り当ててください（自社グループには出ません）。
        ADMIN/OWNER/VIEWER は <strong>自社（SELF）</strong> 組織に割り当てます。
      </p>

      <div className="list">
        {users.length === 0 && <p className="muted">ユーザーがいません。</p>}
        {users.map((u) => {
          const defaultRole = u.role;
          return (
            <details className="card" key={u.id} open={!u.approved}>
              <summary className="list-title" style={{ cursor: "pointer" }}>
                {u.displayName}
                <span
                  className={`badge ${u.approved ? "badge--self" : "badge--review"}`}
                  style={{ marginLeft: 6 }}
                >
                  {u.approved ? "承認済み" : "未承認"}
                </span>
                <span className="muted" style={{ marginLeft: 8 }}>
                  {ROLE_LABEL[u.role] ?? u.role} / {u.org.name}
                </span>
              </summary>

              <div className="list-meta" style={{ marginTop: 8 }}>
                lineUserId: <code>{u.lineUserId}</code>
              </div>

              <form action={approveUserAction} style={{ marginTop: 12 }}>
                <input type="hidden" name="userId" value={u.id} />
                <div className="field">
                  <label className="label">ロール</label>
                  <select className="select" name="role" defaultValue={defaultRole}>
                    <option value="PARTNER">パートナー</option>
                    <option value="VIEWER">自社メンバー</option>
                    <option value="OWNER">自社代表</option>
                    <option value="ADMIN">管理者</option>
                  </select>
                </div>
                <div className="field">
                  <label className="label">所属組織</label>
                  <select className="select" name="orgId" defaultValue={u.orgId}>
                    <optgroup label="パートナー（PARTNER）">
                      {partnerOrgs.map((o) => (
                        <option key={o.id} value={o.id}>{o.name}</option>
                      ))}
                    </optgroup>
                    <optgroup label="自社（SELF）">
                      {selfOrgs.map((o) => (
                        <option key={o.id} value={o.id}>{o.name}</option>
                      ))}
                    </optgroup>
                  </select>
                  <p className="hint">
                    ※ ロールとの整合（PARTNER↔PARTNER組織 / その他↔SELF組織）が必要です。
                  </p>
                </div>
                <label className="inline-row" style={{ gap: 8 }}>
                  <input type="checkbox" name="approved" defaultChecked={u.approved} />
                  <span>承認する（approved）</span>
                </label>
                <div style={{ marginTop: 10 }}>
                  <button className="btn btn--primary" type="submit">保存</button>
                </div>
              </form>
            </details>
          );
        })}
      </div>

      <p className="muted" style={{ marginTop: 20 }}>
        ※ 初回ユーザーは「未割当（承認待ち）」PARTNER に入り、自社には出ません。ここで正式な組織・ロールへ割り当ててください。
      </p>
    </main>
  );
}

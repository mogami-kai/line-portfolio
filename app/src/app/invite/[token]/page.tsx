// ============================================================
// /invite/<token> — 招待リンクの受け口（ログイン不要・誰でも開ける）
//
//   管理者が /admin/users で発行した URL を LINE で送る先。踏んだ人には
//   「何のロールで招待されているか」を見せ、LINE ログインへ送る。
//   ロール付与は /api/auth/line/callback（本人確定後）で行うため、
//   このページ自体は何も書き換えない（＝URL を開くだけでは権限は付かない）。
// ============================================================

import {
  findInviteByToken,
  inviteState,
  INVITE_STATE_MESSAGE,
  INVITE_ROLE_LABEL,
  type InvitableRole,
} from "@/lib/invite.js";

export const dynamic = "force-dynamic";

const fmtDate = (d: Date) =>
  d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invite = await findInviteByToken(token);
  const state = inviteState(invite);

  if (!invite || state !== "OK") {
    return (
      <main className="container">
        <div className="hero">
          <h1>招待リンク</h1>
        </div>
        <div className="notice notice--error" style={{ marginTop: 12 }}>
          {INVITE_STATE_MESSAGE[state === "OK" ? "NOT_FOUND" : state]}
        </div>
      </main>
    );
  }

  const roleLabel =
    INVITE_ROLE_LABEL[invite.role as InvitableRole] ?? invite.role;

  return (
    <main className="container">
      <div className="hero">
        <h1>出面管理への招待</h1>
        <p>LINE でログインすると、そのまま参加できます。</p>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="list-meta">付与される権限</div>
        <p style={{ fontWeight: 700, margin: "4px 0 10px" }}>{roleLabel}</p>
        <div className="list-meta">所属</div>
        <p style={{ margin: "4px 0 10px" }}>{invite.org?.name ?? "自社"}</p>
        <div className="list-meta">有効期限</div>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          {fmtDate(invite.expiresAt)} まで（残り{" "}
          {Math.max(0, invite.maxUses - invite.usedCount)} 回）
        </p>
      </div>

      <a
        href={`/api/auth/line/login?invite=${encodeURIComponent(invite.token)}`}
        className="big-link big-link--primary"
        style={{ marginTop: 16 }}
      >
        <span>
          <span className="bl-title">LINE で参加する</span>
          <span className="bl-sub">ログインした本人に権限が付きます</span>
        </span>
      </a>

      <p className="muted center" style={{ marginTop: 24 }}>
        このリンクは他の人に転送しないでください。
      </p>
    </main>
  );
}

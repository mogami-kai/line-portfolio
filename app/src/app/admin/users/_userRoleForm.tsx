"use client";

// ============================================================
// ユーザーの役割変更フォーム（クライアント）
//   Server Action(approveUserAction) を try/catch で呼び、失敗は
//   インラインのエラー表示にする（本番で全画面クラッシュさせない）。
//   「協力会社管理者＋自社」など不可の組み合わせはここにメッセージが出る。
// ============================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { approveUserAction } from "../_actions.js";

type OrgOpt = { id: string; name: string; kind: "SELF" | "PARTNER" };

export function UserRoleForm({
  userId,
  defaultRole,
  defaultOrgId,
  orgs,
}: {
  userId: string;
  defaultRole: string;
  defaultOrgId: string;
  orgs: OrgOpt[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  function submit(fd: FormData) {
    setErr(null);
    setOk(false);
    fd.set("userId", userId);
    fd.set("approved", "true");
    start(async () => {
      try {
        await approveUserAction(fd);
        setOk(true);
        router.refresh();
      } catch (e) {
        setErr(String((e as Error).message || e));
      }
    });
  }

  return (
    <form action={submit} style={{ marginTop: 12 }}>
      <div className="field">
        <label className="label">役割</label>
        <select className="select" name="role" defaultValue={defaultRole}>
          <option value="OWNER">自社メンバー（LINEグループに投稿）</option>
          <option value="PARTNER">協力会社メンバー（保存のみ）</option>
          <option value="SELF_ADMIN">自社管理者（自社の集計のみ）</option>
          <option value="ORG_ADMIN">協力会社管理者（選んだ協力会社のみ）</option>
          <option value="ADMIN">管理者（全社）</option>
        </select>
      </div>
      <div className="field">
        <label className="label">
          対象組織（協力会社メンバー／協力会社管理者のとき）
        </label>
        <select className="select" name="orgId" defaultValue={defaultOrgId}>
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}（{o.kind === "SELF" ? "自社" : "協力会社"}）
            </option>
          ))}
        </select>
      </div>
      {err && (
        <div className="notice notice--error" role="alert" style={{ marginTop: 8 }}>
          {err}
        </div>
      )}
      {ok && (
        <p className="hint" style={{ color: "var(--accent-dark)", marginTop: 6 }}>
          保存しました。
        </p>
      )}
      <div style={{ marginTop: 10 }}>
        <button className="btn btn--primary" type="submit" disabled={pending}>
          {pending ? "保存中…" : "保存"}
        </button>
      </div>
    </form>
  );
}

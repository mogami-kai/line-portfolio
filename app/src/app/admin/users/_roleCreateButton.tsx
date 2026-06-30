"use client";

// ============================================================
// ロール作成ボタン（ユーザー管理ページ）
//   協力会社（PARTNER 組織）を新規作成＝「協力会社レベルのロール」を量産する入口。
//   作成後、その協力会社をユーザーの役割（協力会社管理者/協力会社メンバー）に割り当てる。
//   作成は createOrganizationAction（kind=PARTNER 固定・全社管理者のみ）。
// ============================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createOrganizationAction } from "../_actions.js";

export function RoleCreateButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    const n = name.trim();
    if (!n) {
      setErr("協力会社（ロール）名を入力してください。");
      return;
    }
    setErr(null);
    const fd = new FormData();
    fd.set("name", n);
    fd.set("kind", "PARTNER");
    start(async () => {
      try {
        await createOrganizationAction(fd);
        setName("");
        setOpen(false);
        router.refresh();
      } catch (e) {
        setErr(String((e as Error).message || e));
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => setOpen(true)}
      >
        ＋ ロール作成
      </button>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="field">
        <label className="label" htmlFor="role-name">
          協力会社（ロール）名
        </label>
        <input
          id="role-name"
          className="input"
          type="text"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例: ○○工業"
        />
        <p className="hint">
          協力会社を作成します。作成後、その会社の人に「協力会社管理者（その会社のみ閲覧）」や「協力会社メンバー」を割り当ててください。
        </p>
      </div>
      {err && (
        <div className="notice notice--error" role="alert">
          {err}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          className="btn btn--primary"
          onClick={submit}
          disabled={pending}
        >
          {pending ? "作成中…" : "作成する"}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            setOpen(false);
            setErr(null);
          }}
          disabled={pending}
        >
          キャンセル
        </button>
      </div>
    </div>
  );
}

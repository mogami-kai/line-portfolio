"use client";

// ============================================================
// 招待リンク発行（ユーザー管理ページ）
//   ロール・所属組織・期限・使用回数を選んで URL を発行し、その場でコピー／
//   LINE で送るところまでを 1 画面で完結させる。
//   発行は createInviteAction（全社管理者のみ・サーバ側で再ガード）。
// ============================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createInviteAction } from "../_actions.js";

type OrgOpt = { id: string; name: string; kind: "SELF" | "PARTNER" };

const ROLES = [
  { value: "ADMIN", label: "管理者（全社）", org: "self" },
  { value: "SELF_ADMIN", label: "自社管理者（自社のみ閲覧）", org: "self" },
  { value: "ORG_ADMIN", label: "協力会社管理者（その会社のみ）", org: "partner" },
  { value: "OWNER", label: "自社メンバー（入力のみ）", org: "self" },
  { value: "PARTNER", label: "協力会社メンバー（入力のみ）", org: "partner" },
] as const;

export function InviteCreate({ orgs }: { orgs: OrgOpt[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<string>("ADMIN");
  const [orgId, setOrgId] = useState<string>("");
  const [label, setLabel] = useState("");
  const [days, setDays] = useState("7");
  const [maxUses, setMaxUses] = useState("1");
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const needsPartnerOrg = role === "ORG_ADMIN" || role === "PARTNER";
  const partnerOrgs = orgs.filter((o) => o.kind === "PARTNER");
  const selfOrg = orgs.find((o) => o.kind === "SELF");

  function submit() {
    setErr(null);
    const fd = new FormData();
    fd.set("role", role);
    fd.set("orgId", needsPartnerOrg ? orgId : (selfOrg?.id ?? ""));
    fd.set("label", label.trim());
    fd.set("days", days);
    fd.set("maxUses", maxUses);
    if (needsPartnerOrg && !orgId) {
      setErr("協力会社（組織）を選んでください。");
      return;
    }
    start(async () => {
      try {
        const res = await createInviteAction(fd);
        setUrl(res.url);
        setCopied(false);
        router.refresh();
      } catch (e) {
        setErr(String((e as Error).message || e));
      }
    });
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => setOpen(true)}
      >
        ＋ 招待リンクを作る
      </button>
    );
  }

  return (
    <div className="card">
      <div className="field">
        <label className="label" htmlFor="inv-role">
          付与する権限
        </label>
        <select
          id="inv-role"
          className="input"
          value={role}
          onChange={(e) => {
            setRole(e.target.value);
            setOrgId("");
            setUrl(null);
          }}
        >
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      {needsPartnerOrg && (
        <div className="field">
          <label className="label" htmlFor="inv-org">
            協力会社（組織）
          </label>
          <select
            id="inv-org"
            className="input"
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
          >
            <option value="">選択してください</option>
            {partnerOrgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          {partnerOrgs.length === 0 && (
            <p className="hint">
              協力会社がまだありません。「＋ ロール作成」から追加してください。
            </p>
          )}
        </div>
      )}

      <div className="field">
        <label className="label" htmlFor="inv-label">
          メモ（任意）
        </label>
        <input
          id="inv-label"
          className="input"
          type="text"
          autoComplete="off"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="例: ○○工業 田中さん"
        />
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label className="label" htmlFor="inv-days">
            有効期限
          </label>
          <select
            id="inv-days"
            className="input"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          >
            <option value="1">1日</option>
            <option value="3">3日</option>
            <option value="7">7日</option>
            <option value="30">30日</option>
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label className="label" htmlFor="inv-uses">
            使える回数
          </label>
          <select
            id="inv-uses"
            className="input"
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
          >
            <option value="1">1人だけ</option>
            <option value="5">5人まで</option>
            <option value="20">20人まで</option>
          </select>
        </div>
      </div>

      {err && (
        <div className="notice notice--error" role="alert">
          {err}
        </div>
      )}

      {url && (
        <div className="notice" style={{ marginBottom: 10 }}>
          <p style={{ margin: "0 0 6px" }}>
            招待リンクを発行しました。LINE で送ってください。
          </p>
          <code style={{ display: "block", wordBreak: "break-all" }}>{url}</code>
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn btn--sm" onClick={copy}>
              {copied ? "コピーしました" : "リンクをコピー"}
            </button>
            <a
              className="btn btn--sm btn--primary"
              href={`https://line.me/R/share?text=${encodeURIComponent(
                `出面管理への招待です。こちらから参加してください。\n${url}`,
              )}`}
              target="_blank"
              rel="noreferrer"
            >
              LINE で送る
            </a>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          className="btn btn--primary"
          onClick={submit}
          disabled={pending}
        >
          {pending ? "発行中…" : url ? "もう1本発行する" : "発行する"}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            setOpen(false);
            setErr(null);
            setUrl(null);
          }}
          disabled={pending}
        >
          閉じる
        </button>
      </div>
    </div>
  );
}

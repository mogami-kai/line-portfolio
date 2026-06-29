"use client";

// ============================================================
// 「請求書作成」ボタン（クライアント）
//   押す → ローディング → /api/invoices/generate に POST（作成/再作成）
//   → 返ってきた請求書 id で GET /api/invoices/[id]/export?format=xlsx へ遷移し、
//     Excel を確実にダウンロード（iOS Safari でも落ちる "添付レスポンスへの遷移"）。
//   → カードの状態（請求書番号など）を最新化（router.refresh）。
//   ※ 以前の fetch→blob→a.download 方式は iOS でファイルが保存されないことがあった。
// ============================================================

import { useState } from "react";
import { useRouter } from "next/navigation";

export function GenerateInvoiceButton({
  clientId,
  ym,
}: {
  clientId: string;
  ym: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/invoices/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, ym }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; id?: string; message?: string }
        | null;
      if (!res.ok || !data?.ok || !data.id) {
        setError(data?.message || "作成に失敗しました。もう一度お試しください。");
        return;
      }
      // 請求書番号・状態の表示を更新。
      router.refresh();
      // 確実なダウンロード: 添付レスポンスを返す GET へ遷移（iOS Safari でも保存できる）。
      window.location.href = `/api/invoices/${data.id}/export?format=xlsx`;
    } catch {
      setError("通信エラーが発生しました。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <button
        type="button"
        className="btn btn--primary"
        onClick={onClick}
        disabled={loading}
        aria-busy={loading}
      >
        {loading ? "作成中…" : "請求書作成"}
      </button>
      <p className="hint" style={{ marginTop: 6 }}>
        押すと請求書を作成し、Excel をダウンロードします。
      </p>
      {error && (
        <p className="hint" style={{ color: "var(--danger)", marginTop: 6 }}>
          {error}
        </p>
      )}
    </div>
  );
}

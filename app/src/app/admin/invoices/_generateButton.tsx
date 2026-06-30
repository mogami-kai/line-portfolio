"use client";

// ============================================================
// 「請求書作成」ボタン（クライアント）
//   押す → /api/invoices/generate に POST（作成/再作成）→ ダウンロードリンクを表示。
//   ダウンロードリンクを明示的に表示することで、iOS Safari でも確実に保存できる
//   （async onClick 内で await 後に window.location.href を変えると iOS では
//     ユーザージェスチャーコンテキストが失われ、ダウンロードが無視されるため）。
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
  const [downloadId, setDownloadId] = useState<string | null>(null);

  async function onClick() {
    if (loading) return;
    setLoading(true);
    setError(null);
    setDownloadId(null);
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
      setDownloadId(data.id);
      router.refresh();
    } catch {
      setError("通信エラーが発生しました。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <button
        type="button"
        className="btn btn--primary"
        onClick={onClick}
        disabled={loading}
        aria-busy={loading}
      >
        {loading ? "作成中…" : "請求書作成"}
      </button>
      {downloadId && (
        <a
          href={`/api/invoices/${downloadId}/export?format=xlsx`}
          className="btn btn--ghost"
        >
          xlsx ダウンロード
        </a>
      )}
      {error && (
        <p className="hint" style={{ color: "var(--danger)", marginTop: 4 }}>
          {error}
        </p>
      )}
    </div>
  );
}

"use client";

// ============================================================
// 「請求書作成」ボタン（クライアント）
//   押す → ローディング表示 → /api/invoices/generate に POST
//   → 請求書を作成/再作成し、返ってきた xlsx をその場でダウンロード
//   → カードの状態（請求書番号など）を最新化（router.refresh）。
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
      if (!res.ok) {
        setError("作成に失敗しました。もう一度お試しください。");
        return;
      }
      // xlsx をダウンロード。
      const blob = await res.blob();
      const no = res.headers.get("X-Invoice-No") || ym;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `invoice_${no}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      // 請求書番号・状態の表示を更新。
      router.refresh();
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
      {error && (
        <p className="hint" style={{ color: "var(--danger)", marginTop: 6 }}>
          {error}
        </p>
      )}
    </div>
  );
}

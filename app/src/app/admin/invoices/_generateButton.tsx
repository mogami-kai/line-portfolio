"use client";

// ============================================================
// 「請求書作成」ボタン（クライアント）— 2パターン
//   集約: 委託料（日勤/夜勤）＋残業代をまとめた明細。
//   現場ごと: 現場名ごとに 項目・数量・単価 を羅列（元請の細かい確認用）。
//   押す → /api/invoices/generate に mode 付き POST（作成/再作成・上書き）
//        → 返った id で xlsx ダウンロードリンクを表示（iOS でも確実に保存）。
// ============================================================

import { useState } from "react";
import { useRouter } from "next/navigation";

type Mode = "AGGREGATE" | "PER_SITE";

export function GenerateInvoiceButton({
  clientId,
  ym,
}: {
  clientId: string;
  ym: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadId, setDownloadId] = useState<string | null>(null);
  const [doneMode, setDoneMode] = useState<Mode | null>(null);

  async function generate(mode: Mode) {
    if (loading) return;
    setLoading(mode);
    setError(null);
    setDownloadId(null);
    setDoneMode(null);
    try {
      const res = await fetch("/api/invoices/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, ym, mode }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; id?: string; message?: string }
        | null;
      if (!res.ok || !data?.ok || !data.id) {
        setError(data?.message || "作成に失敗しました。もう一度お試しください。");
        return;
      }
      setDownloadId(data.id);
      setDoneMode(mode);
      router.refresh();
    } catch {
      setError("通信エラーが発生しました。");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => generate("AGGREGATE")}
          disabled={loading !== null}
          aria-busy={loading === "AGGREGATE"}
        >
          {loading === "AGGREGATE" ? "作成中…" : "集約で作成"}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => generate("PER_SITE")}
          disabled={loading !== null}
          aria-busy={loading === "PER_SITE"}
        >
          {loading === "PER_SITE" ? "作成中…" : "現場ごとで作成"}
        </button>
        {downloadId && (
          <a
            href={`/api/invoices/${downloadId}/export?format=xlsx`}
            className="btn btn--ghost"
          >
            xlsx ダウンロード（{doneMode === "PER_SITE" ? "現場ごと" : "集約"}）
          </a>
        )}
      </div>
      <p className="hint" style={{ marginTop: 6 }}>
        集約＝委託料をまとめて1行ずつ／現場ごと＝現場名ごとに項目・数量・単価を羅列。どちらでも作り直せます。
      </p>
      {error && (
        <p className="hint" style={{ color: "var(--danger)", marginTop: 4 }}>
          {error}
        </p>
      )}
    </div>
  );
}

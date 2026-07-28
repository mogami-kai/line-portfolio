"use client";

// 発行済み招待リンクのコピー / LINE 共有ボタン（一覧行で使う）。

import { useState } from "react";

export function InviteCopy({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
      <button
        type="button"
        className="btn btn--sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
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
  );
}

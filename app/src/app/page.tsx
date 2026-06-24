// ============================================================
// / — ランディング（/liff・/admin への入口）
// ============================================================

import type { CSSProperties } from "react";

export default function HomePage() {
  const wrap: CSSProperties = {
    maxWidth: 560,
    margin: "0 auto",
    padding: 40,
    fontFamily:
      "system-ui, -apple-system, 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif",
    color: "#1a1a1a",
  };
  const card: CSSProperties = {
    display: "block",
    padding: 20,
    marginTop: 16,
    border: "1px solid #e0e0e0",
    borderRadius: 12,
    background: "#fff",
    textDecoration: "none",
    color: "inherit",
  };
  return (
    <main style={wrap}>
      <h1 style={{ fontSize: 24 }}>出面管理</h1>
      <p style={{ color: "#666" }}>
        出面入力 → 集計 → 請求書（取引先ごと）まで一貫管理。
      </p>

      <a href="/liff" style={card}>
        <strong style={{ fontSize: 18 }}>日報入力（LIFF）</strong>
        <div style={{ color: "#666", fontSize: 14, marginTop: 4 }}>
          LINE 内で開く出面入力フォーム。日付・取引先・現場・職人・経費。
        </div>
      </a>

      <a href="/admin" style={card}>
        <strong style={{ fontSize: 18 }}>管理ダッシュボード</strong>
        <div style={{ color: "#666", fontSize: 14, marginTop: 4 }}>
          月次集計（自社/パートナー別）・要確認キュー・請求書発行。
        </div>
      </a>

      <p style={{ color: "#999", fontSize: 12, marginTop: 24 }}>
        ※ 例・初期データはすべてダミーです。実データは DB・環境変数で管理します。
      </p>
    </main>
  );
}

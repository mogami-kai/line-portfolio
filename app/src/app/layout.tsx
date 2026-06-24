// ============================================================
// ルートレイアウト（App Router）
// ============================================================

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "出面管理",
  description: "出面入力 → 集計 → 請求書 一貫システム",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body
        style={{
          margin: 0,
          background: "#fafafa",
          fontFamily:
            "system-ui, -apple-system, 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif",
        }}
      >
        {children}
      </body>
    </html>
  );
}

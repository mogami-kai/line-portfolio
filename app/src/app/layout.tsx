// ============================================================
// ルートレイアウト（App Router）
//   ・依存ゼロのデザインシステム（globals.css）を読み込む。
//   ・モバイルファースト: viewport / themeColor を設定。
// ============================================================

import "./globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "出面管理",
  description: "出面入力 → 集計 → 請求書 一貫システム",
  applicationName: "出面管理",
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#06C755",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}

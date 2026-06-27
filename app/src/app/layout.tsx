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
      <head>
        {/* LIFF SDK の CDN へ早期に接続（DNS+TLS を先行）。/liff の初期描画を短縮。 */}
        <link
          rel="preconnect"
          href="https://static.line-scdn.net"
          crossOrigin="anonymous"
        />
        <link rel="dns-prefetch" href="https://static.line-scdn.net" />
      </head>
      <body>{children}</body>
    </html>
  );
}

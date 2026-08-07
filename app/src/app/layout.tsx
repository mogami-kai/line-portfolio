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
  // maximumScale は指定しない（モバイルでの拡大を許可＝アクセシビリティ・実用性）。
  themeColor: "#2b5fb3",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      {/*
        LIFF SDK の CDN への先行接続は src/app/liff/layout.tsx に移した。
        ・preconnect より強い preload（接続を張ったうえで実体も取りに行く）にした
        ・crossOrigin="anonymous" を外した — 実際に読む <script> は crossorigin 無し
          ＝ no-cors なので、anonymous で温めた接続は流用されず無駄だった
        ・/admin では LINE の CDN を一切使わないので、そちらで張るのもやめた
      */}
      <body>{children}</body>
    </html>
  );
}

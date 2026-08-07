// ============================================================
// /liff レイアウト — 初期表示のウォーターフォール短縮のためだけに存在する。
//
//   page.tsx は LIFF SDK を useEffect の中で <script> 挿入して読み込む。
//   つまり「HTML 到着 → JS ダウンロード → React 実行 → やっと SDK を取りに行く」
//   という直列になっていて、SDK の取得が最後尾に回っていた。
//   ここで preload しておくと、HTML をパースした時点で SDK のダウンロードが
//   始まり、React が loadLiffSdk() を呼ぶ頃には取得済み（ブラウザキャッシュ）
//   になっている＝ liff.init までの待ちが SDK 取得分だけ縮む。
//
//   preconnect は /liff を開いたときだけ意味があるので、ルートではなくここに置く
//   （/admin では LINE の CDN も API も使わない）。
// ============================================================

import type { ReactNode } from "react";
import { preconnect, preload } from "react-dom";
import { LIFF_SDK_URL } from "./_sdkUrl.js";

export default function LiffLayout({ children }: { children: ReactNode }) {
  // ★ crossOrigin は付けない。page.tsx が挿入する <script> は crossorigin 無し
  //   ＝ no-cors リクエストなので、preload 側に anonymous を付けると別リクエスト
  //   扱いになり二重ダウンロードになる。
  preload(LIFF_SDK_URL, { as: "script" });
  // liff.init / getAccessToken が叩く LINE 側エンドポイントへ先に接続を張る。
  preconnect("https://api.line.me");
  return <>{children}</>;
}

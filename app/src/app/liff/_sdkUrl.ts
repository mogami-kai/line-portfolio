// LIFF v2 SDK の CDN URL。
// layout.tsx（preload）と page.tsx（実際の <script> 挿入）の両方が参照する。
// ★ 両者で 1 文字でも違うと preload が使われず二重ダウンロードになるため、
//   URL はここだけに書く。
// 公式CDN: static.line-scdn.net（static.line.me は読めず SDK load error になる）
export const LIFF_SDK_URL = "https://static.line-scdn.net/liff/edge/2/sdk.js";

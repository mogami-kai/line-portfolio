"use client";

// ============================================================
// 現場ピッカー（旧・現場マスタ選択UI）— v3 で廃止。
//
//   v3 改修で「現場」は現場マスタ依存の選択をやめ、出面フォーム
//   (page.tsx) のシンプルな自由入力テキスト（siteName）へ置換した。
//   このコンポーネントはどこからも参照されていないが、過去の import を
//   壊さないため export だけ残し、中身は最小スタブにしている。
//   新規利用はせず、現場入力は page.tsx の siteName を使うこと。
// ============================================================

export interface PickerSite {
  id: string;
  name: string;
  isPinned?: boolean;
  usageCount?: number;
  lastUsedAt?: string | null;
}

// 廃止済みスタブ。レンダリングは行わない（互換のための no-op）。
export function SitePicker(): null {
  return null;
}

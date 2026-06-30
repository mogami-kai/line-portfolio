// ============================================================
// /admin/masters — 設定の共有型（タブ間で共有する「契約」）
//
//   ★ このファイルは "use client" / "use server" を付けない素のモジュール。
//     Server Component（page.tsx）が prisma の結果をこの Row 型に map し、
//     各タブ（"use client"）が props として受け取る単一の出所。
//   ※ 型のみ。副作用・DB アクセス・定数は持たない。
//
//   画面には英語ラベル（Client / Worker / Organization …）を出さない。
//   この型名は内部の構造名であり、UI 文言ではない。
// ============================================================

/** 設定の4タブ。選択中タブのみ描画する。 */
export type MasterTab = "clients" | "workers" | "orgs" | "settings";

/** 取引先1行（一覧表示＋ドロワー編集の初期値）。 */
export interface ClientRow {
  id: string;
  name: string;
  honorific: string; // "御中" | "様"
  address: string | null;
  unitPrice: number | null; // 日勤の人工単価（円・任意）
  nightUnitPrice: number | null; // 夜勤の人工単価（円・任意。未設定なら日勤単価を流用）
  otUnitPrice: number | null; // 残業の時間単価（円/時・任意。未設定なら自動）
  billingMode: "AGGREGATE" | "PER_SITE"; // 請求方式（集約 / 現場ごと）
  active: boolean;
}

/** 職人1行（所属組織名・種別を同梱して一覧でグルーピング/表示する）。 */
export interface WorkerRow {
  id: string;
  name: string;
  aliases: string[]; // 表記揺れ吸収。編集ドロワーの別名欄の初期値に使う。
  active: boolean;
  orgId: string;
  orgName: string;
  orgKind: "SELF" | "PARTNER";
}

/** 組織（自社 SELF / 協力会社 PARTNER）1行。 */
export interface OrgRow {
  id: string;
  name: string;
  kind: "SELF" | "PARTNER";
  active: boolean;
}

/** 請求書設定（差出人・振込先・税率・担当者）。単一レコード運用。 */
export interface SettingRow {
  issuerName: string;
  address: string | null;
  tel: string | null;
  email: string | null;
  regNumber: string | null;
  bankInfo: string | null;
  taxRate: number; // 0.10 のような比率（% ではない）
  contactName: string | null;
}

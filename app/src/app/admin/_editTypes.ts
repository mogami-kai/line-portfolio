// ============================================================
// 出面編集（管理ホームの「直近の出面」「要確認」から開くインライン編集）共有型
//
//   ★ このファイルは "use server" を付けない素のモジュール。
//     クライアント（_editReport.tsx / _feed.tsx）とサーバー（_actions.ts）の
//     双方から import され、編集フォームの「契約（型）」の単一の出所になる。
//   ※ 型と純粋な定数のみ。副作用・DB アクセスは持たない。
// ============================================================

export type ContractType = "JOYO" | "UKEOI";
export type Shift = "DAY" | "HALF" | "NIGHT";
export type OrgKind = "SELF" | "PARTNER";
export type ReportStatus = "CONFIRMED" | "NEEDS_REVIEW";

/** 編集フォームのドロップダウン用の最小の取引先。 */
export interface ClientLite {
  id: string;
  name: string;
}

/** 編集フォームの職人ドロップダウン用の最小の職人（org でフィルタする）。 */
export interface WorkerLite {
  id: string;
  name: string;
  orgId: string;
}

/** 出面1行（職人ごとの人工・残業）。 */
export interface EditableEntry {
  workerId: string;
  shift: Shift;
  manDays: number;
  otHours: number;
}

/** 立替経費1行。 */
export interface EditableExpense {
  kind: string;
  amount: number;
  billable: boolean;
  paidBy: string;
  /** 領収書写真の Storage パス（無ければ null）。編集では閲覧・維持のみ（v1）。 */
  receiptPath: string | null;
}

/** getReportForEditAction の戻り値＝編集フォームの初期値。 */
export interface EditableReport {
  id: string;
  workDate: string; // "YYYY-MM-DD"（UTC 日付）
  clientId: string;
  orgId: string;
  orgKind: OrgKind;
  siteName: string; // 自由入力（空文字可）
  contractType: ContractType;
  contractAmount: number | null;
  status: ReportStatus;
  entries: EditableEntry[];
  expenses: EditableExpense[];
}

/**
 * 編集モーダルを開いた時に1往復で取得するデータ一式。
 *   出面本体（report）に加え、ドロップダウン用の取引先/職人もここで返す。
 *   → 一覧側（フィード/要確認の各ボタン）へ巨大配列を撒かず、開いた時だけ取りに行く。
 */
export interface ReportEditorData {
  report: EditableReport;
  clients: ClientLite[];
  workers: WorkerLite[];
}

/** updateReportAction への入力（フォーム送信値）。 */
export interface ReportEditInput {
  id: string;
  workDate: string; // "YYYY-MM-DD"
  clientId: string;
  siteName: string; // 空文字可 → null 保存
  contractType: ContractType;
  contractAmount: number | null; // UKEOI のとき必須・正の整数 / JOYO は null
  entries: EditableEntry[]; // 最低1件
  expenses: EditableExpense[];
}

// ── 勤務体系（ドメイン定数。LIFF と同じ並び/換算） ──
export const SHIFTS: Shift[] = ["DAY", "HALF", "NIGHT"];
export const SHIFT_LABEL: Record<Shift, string> = {
  DAY: "日勤",
  HALF: "半日",
  NIGHT: "夜勤",
};
/** 勤務体系→既定人工。半日のみ 0.5、ほかは 1.0（人工は手入力で上書き可）。 */
export const SHIFT_TO_MANDAYS: Record<Shift, number> = {
  DAY: 1,
  HALF: 0.5,
  NIGHT: 1,
};

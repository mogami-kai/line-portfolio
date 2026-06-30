"use client";

// ============================================================
// 請求書 一覧テーブル（PC・≥1024px 専用）
//   freee / マネーフォワード 風の業務SaaSテーブル。
//   ・1 取引先 = 1 行。列＝取引先 / 状態 / 人工 / 残業 / 概算(税込) / 操作。
//   ・「詳細」トグルで、その下に全幅の展開行（プレビュー明細・内訳）を差し込む。
//   ・操作セルの中身（GenerateInvoiceButton・Excel リンク）と展開行の中身
//     （プレビュー / 内訳テーブル）はサーバ側で組み立て、ReactNode として受け取る。
//
//   スマホ（<1024px）は page.tsx 側のカード表示を使う（このコンポーネントの
//   ルート .inv-table-wrap は <1024px で display:none になる）。
// ============================================================

import { useState, type ReactNode } from "react";

const yen = (n: number) => "¥" + Math.round(n).toLocaleString("ja-JP");

export type InvoiceTableRow = {
  clientId: string;
  name: string;
  /** 既存 Invoice の状態（DRAFT 等）。未作成なら null。 */
  status: string | null;
  manDays: number;
  otHours: number;
  needsReview: number;
  total: number;
  exempt: number;
  rateMissing: boolean;
  /** 展開行の中身（プレビュー明細＋内訳）。サーバ側で組み立て済み。 */
  detail: ReactNode;
  /** 操作セルの中身（請求書番号・Excel リンク・作成ボタン）。サーバ側で組み立て済み。 */
  actions: ReactNode;
};

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="badge">未作成</span>;
  return <span className="badge badge--self">{status}</span>;
}

function Row({ row }: { row: InvoiceTableRow }) {
  const [open, setOpen] = useState(false);
  return (
    <tbody className="inv-tbody">
      <tr className={open ? "inv-row is-open" : "inv-row"}>
        <td className="inv-c-name">
          <button
            type="button"
            className="inv-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <span className={open ? "inv-caret is-open" : "inv-caret"} aria-hidden>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path
                  d="M3 4.5 6 7.5 9 4.5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="inv-name-text">{row.name}</span>
          </button>
          {row.rateMissing && (
            <span className="badge badge--review inv-rate-warn">単価未登録</span>
          )}
        </td>
        <td className="inv-c-status">
          <StatusBadge status={row.status} />
        </td>
        <td className="inv-c-num">{row.manDays}</td>
        <td className="inv-c-num">
          {row.otHours ? `${row.otHours}h` : "—"}
          {row.needsReview > 0 && (
            <span className="badge badge--review inv-review-badge">
              要確認 {row.needsReview}
            </span>
          )}
        </td>
        <td className="inv-c-num inv-c-total">
          {yen(row.total)}
        </td>
        <td className="inv-c-ops">{row.actions}</td>
      </tr>
      {open && (
        <tr className="inv-detail-row">
          <td colSpan={6}>
            <div className="inv-detail">{row.detail}</div>
          </td>
        </tr>
      )}
    </tbody>
  );
}

export function InvoiceTable({ rows }: { rows: InvoiceTableRow[] }) {
  return (
    <div className="inv-table-wrap">
      <table className="inv-table">
        <thead>
          <tr>
            <th className="inv-c-name">取引先</th>
            <th className="inv-c-status">状態</th>
            <th className="inv-c-num">人工</th>
            <th className="inv-c-num">残業</th>
            <th className="inv-c-num">概算（税込）</th>
            <th className="inv-c-ops">操作</th>
          </tr>
        </thead>
        {rows.map((row) => (
          <Row key={row.clientId} row={row} />
        ))}
      </table>
    </div>
  );
}

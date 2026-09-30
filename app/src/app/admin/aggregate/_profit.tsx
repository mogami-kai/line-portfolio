"use client";

// ============================================================
// 粗利（会社に残るお金）— /admin/aggregate
//   自社 と 協力会社 を別々に「売上 − 立替経費 − 人工」で出し、
//   その他経費を引いた「会社に残る額」を 取り分（例: 大和 20%）と会社に分ける。
//   計算は @/lib/profit（サーバ）で完了済み。ここは並べるだけ＋その他経費の追加/削除。
//   追加/削除は Server Action → revalidatePath で数字ごと最新化する。
// ============================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ProfitSummary } from "@/lib/profit.js";
import { addOtherExpenseAction, deleteOtherExpenseAction } from "../_actions.js";

const yen = (n: number) =>
  (n < 0 ? "−¥" : "¥") + Math.abs(Math.round(n)).toLocaleString("ja-JP");

/** 0.2 → "20"、0.125 → "12.5"（% 表示）。 */
const pct = (rate: number) => String(Math.round(rate * 1000) / 10);

function Row({
  label,
  value,
  minus = false,
  strong = false,
}: {
  label: string;
  value: number;
  minus?: boolean;
  strong?: boolean;
}) {
  return (
    <div className={strong ? "kv pf-total" : "kv"}>
      <span className="k">
        {minus && <span aria-hidden>− </span>}
        {label}
      </span>
      <span className="v">{yen(value)}</span>
    </div>
  );
}

export function ProfitPanel({
  ym,
  profit,
}: {
  ym: string;
  profit: ProfitSummary;
}) {
  const { self, partner, warnings } = profit;
  const sharePct = pct(profit.shareRate);
  const companyPct = pct(1 - profit.shareRate);
  const warnLines = [
    warnings.unpricedClients.length > 0 &&
      `単価未設定の取引先（売上0円で計算）: ${warnings.unpricedClients.join("、")}`,
    warnings.unpricedPartnerClients.length > 0 &&
      `単価未設定の取引先・協力会社分（売上0円で計算）: ${warnings.unpricedPartnerClients.join("、")}`,
    warnings.unpricedWorkers.length > 0 &&
      `単価未設定の職人（給料0円で計算）: ${warnings.unpricedWorkers.join("、")}`,
    warnings.unpricedPartnerWorkers.length > 0 &&
      `単価未設定の協力会社の職人（支払い0円で計算）: ${warnings.unpricedPartnerWorkers.join("、")}`,
  ].filter((x): x is string => Boolean(x));

  return (
    <div className="card pf-card">
      {warnLines.length > 0 && (
        <div className="notice notice--warn pf-warn" role="status">
          {warnLines.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      )}

      <div className="pf-group-title">自社</div>
      <Row label="売上（税抜）" value={self.sales} />
      <Row label="立替経費" value={self.expenses} minus />
      <Row label="人工（職人の給料）" value={self.labor} minus />
      <Row label="自社の残り" value={self.remaining} strong />

      {partner && (
        <>
          <div className="pf-group-title">協力会社</div>
          <Row label="売上（税抜）" value={partner.sales} />
          <Row label="立替経費" value={partner.expenses} minus />
          <Row label="人工（協力会社への支払い）" value={partner.labor} minus />
          <Row label="協力会社分の残り" value={partner.remaining} strong />
        </>
      )}

      <div className="pf-group-title">その他経費</div>
      <OtherExpenseEditor ym={ym} rows={profit.otherExpenses} />
      <Row label="その他経費 合計" value={profit.otherTotal} minus />

      <div className="pf-result">
        <Row label="会社に残る額" value={profit.remaining} strong />
        <Row label={`${profit.shareName}（${sharePct}%）`} value={profit.share} />
        <div className="kv pf-company">
          <span className="k">会社（{companyPct}%）</span>
          <span className="v">{yen(profit.company)}</span>
        </div>
      </div>
      <p className="hint pf-note">
        売上は請求書と同じ計算（税抜・夜勤単価・請負を含む）。人工は職人別の給料（概算）の合計です。
      </p>
    </div>
  );
}

/** その他経費の一覧＋追加フォーム（月ごと）。 */
function OtherExpenseEditor({
  ym,
  rows,
}: {
  ym: string;
  rows: ProfitSummary["otherExpenses"];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<void>, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        after?.();
        router.refresh();
      } catch (e) {
        setError(String((e as Error)?.message ?? e).replace(/^FORBIDDEN: /, ""));
      }
    });
  };

  const onAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const n = Math.round(Number(amount));
    run(
      () => addOtherExpenseAction({ yearMonth: ym, name, amount: n }),
      () => {
        setName("");
        setAmount("");
      },
    );
  };

  return (
    <div className="pf-other">
      {rows.length === 0 ? (
        <p className="muted pf-other-empty">この月のその他経費はありません。</p>
      ) : (
        rows.map((r) => (
          <div key={r.id} className="pf-other-row">
            <span className="pf-other-name">{r.name}</span>
            <span className="pf-other-amt">{yen(r.amount)}</span>
            <button
              type="button"
              className="btn btn--danger-text btn--sm"
              disabled={pending}
              onClick={() => run(() => deleteOtherExpenseAction(r.id))}
              aria-label={`${r.name} を削除`}
            >
              削除
            </button>
          </div>
        ))
      )}
      <form className="pf-other-form" onSubmit={onAdd}>
        <input
          className="input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="項目名"
          maxLength={40}
          aria-label="その他経費の項目"
          required
        />
        <input
          className="input input--num"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="金額"
          aria-label="その他経費の金額（円）"
          required
        />
        <button type="submit" className="btn btn--sm" disabled={pending}>
          {pending ? "…" : "追加"}
        </button>
      </form>
      {error && (
        <p className="pf-other-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

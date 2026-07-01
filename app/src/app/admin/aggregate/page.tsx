// ============================================================
// /admin/aggregate — 集計（Server Component）
//
//   ホーム（/admin）は「次の行動」（要確認・直近の出面・請求導線）に集約し、
//   詳細な月次集計（自社/協力会社の合計・職人別・取引先別）は本ページに分離する。
//     1) 自社 合計（概算金額・人工・残業）
//     2) 職人別（給料の見方）… 後藤◯◯ 齋◯◯… のいつもの締めの形
//     3) 取引先別（請求の見方・自社）… 請求書を出す単位
//     4) 取引先別（協力会社）… 管理画面のみで集約
//
//   ガード: getAdminContext()（middleware で保護済みだが念のためホームへ集約）。
//   ?ym= 対応・月スイッチャー可。集計は @/lib/aggregate（calc・invoice を再利用）で
//   ロジックは変えず、ホームから当該ブロックを移設したもの。
// ============================================================

import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAdminContext, adminScopeOrgId } from "@/lib/auth.js";
import {
  currentYearMonth,
  getMonthSummary,
  loadMonthRows,
  monthRange,
  summarizeByClient,
  summarizeByWorker,
  summarizeExpenses,
  type ClientMonthSummary,
  type ExpensePayerSummary,
  type WorkerMonthSummary,
} from "@/lib/aggregate.js";
import { RateEditor } from "./_rateEditor.js";

export const dynamic = "force-dynamic";

const yen = (n: number) => "¥" + Math.round(n).toLocaleString("ja-JP");
const ymStr = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

function ClientAccordion({
  rows,
  emptyLabel,
}: {
  rows: ClientMonthSummary[];
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return <p className="muted">{emptyLabel}</p>;
  }
  return (
    <>
      {rows.map((r) => (
        <details className="acc" key={r.clientName}>
          <summary>
            <span className="acc-name">{r.clientName}</span>
            <span>
              <span className="acc-amt">{yen(r.estimatedAmount)}</span>
              <span className="acc-caret" aria-hidden>
                {" "}
                ▾
              </span>
            </span>
          </summary>
          <div className="acc-body">
            <div className="kv">
              <span className="k">人工合計</span>
              <span className="v">
                {r.manDays}
                <span className="muted" style={{ marginLeft: 8 }}>
                  （日勤 {r.dayManDays} / 半日 {r.halfManDays} / 夜勤{" "}
                  {r.nightManDays}）
                </span>
              </span>
            </div>
            <div className="kv">
              <span className="k">残業合計</span>
              <span className="v">{r.otHours} h</span>
            </div>
            <div className="kv">
              <span className="k">概算金額（税抜）</span>
              <span className="v">{yen(r.estimatedAmount)}</span>
            </div>
            <RateEditor
              kind="client"
              targetId={r.clientId}
              unitPrice={r.unitPrice}
              nightUnitPrice={r.nightUnitPrice}
              otUnitPrice={r.otUnitPrice}
            />
          </div>
        </details>
      ))}
    </>
  );
}

/** 職人別アコーディオン（人工・残業・給料＋単価編集）。 */
function WorkerAccordion({
  rows,
  totals,
}: {
  rows: WorkerMonthSummary[];
  totals: {
    manDays: number;
    dayManDays: number;
    halfManDays: number;
    nightManDays: number;
    otHours: number;
  };
}) {
  if (rows.length === 0) {
    return <p className="muted">この月のデータはありません。</p>;
  }
  return (
    <>
      {rows.map((w) => (
        <details className="acc" key={w.workerId ?? w.workerName}>
          <summary>
            <span className="acc-name">{w.workerName}</span>
            <span>
              <span className="acc-amt">
                {w.pay > 0 ? yen(w.pay) : `${w.manDays} 人工`}
              </span>
              <span className="acc-caret" aria-hidden>
                {" "}
                ▾
              </span>
            </span>
          </summary>
          <div className="acc-body">
            <div className="kv">
              <span className="k">人工合計</span>
              <span className="v">
                {w.manDays}
                <span className="muted" style={{ marginLeft: 8 }}>
                  （日勤 {w.dayManDays} / 半日 {w.halfManDays} / 夜勤{" "}
                  {w.nightManDays}）
                </span>
              </span>
            </div>
            <div className="kv">
              <span className="k">残業合計</span>
              <span className="v">{w.otHours} h</span>
            </div>
            <div className="kv">
              <span className="k">給料（概算）</span>
              <span className="v">{w.pay > 0 ? yen(w.pay) : "単価未設定"}</span>
            </div>
            {w.workerId ? (
              <RateEditor
                kind="worker"
                targetId={w.workerId}
                unitPrice={w.unitPrice}
                otUnitPrice={w.otUnitPrice}
              />
            ) : (
              <p className="muted">職人未登録のため単価設定できません。</p>
            )}
          </div>
        </details>
      ))}
      <div className="acc-total">
        <span>合計</span>
        <span>
          {totals.manDays} 人工（日勤 {totals.dayManDays} / 半日{" "}
          {totals.halfManDays} / 夜勤 {totals.nightManDays}） / 残業{" "}
          {totals.otHours}h
        </span>
      </div>
    </>
  );
}

/** 立替集計（立替えた人ごとに用途・金額を一覧）。 */
function ExpenseAggregation({
  payers,
  total,
}: {
  payers: ExpensePayerSummary[];
  total: number;
}) {
  if (payers.length === 0) {
    return <p className="muted">この月の立替はありません。</p>;
  }
  return (
    <table className="worker-table">
      <thead>
        <tr>
          <th>立替えた人</th>
          <th>用途</th>
          <th>金額</th>
        </tr>
      </thead>
      <tbody>
        {payers.map((p) =>
          p.items.map((it, i) => (
            <tr key={`${p.paidBy}-${it.kind}`}>
              {i === 0 && (
                <td className="wt-name" rowSpan={p.items.length}>
                  {p.paidBy}
                </td>
              )}
              <td>{it.kind}</td>
              <td className="num">{yen(it.amount)}</td>
            </tr>
          )),
        )}
        <tr className="wt-total">
          <td colSpan={2}>合計</td>
          <td className="num">{yen(total)}</td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * 今月の集計（自社/パートナー＋自社合計）。
 * 重い集計を getMonthSummary（unstable_cache）で取得し、<Suspense> 配下で
 * ストリーミングする（月スイッチャー等の描画をブロックしない）。
 */
async function MonthSummary({
  ym,
  scopeOrgId,
}: {
  ym: string;
  scopeOrgId: string | null;
}) {
  // スコープ管理者（自組織のみ）: 自組織1つ分の集計を計算して表示する。
  if (scopeOrgId) {
    const rows = await loadMonthRows(ym, { orgId: scopeOrgId });
    const [clients, byWorker, expenses] = await Promise.all([
      summarizeByClient(ym, rows),
      summarizeByWorker(ym, { orgId: scopeOrgId }),
      summarizeExpenses(ym, { orgId: scopeOrgId }),
    ]);
    const totals = clients.reduce(
      (a, r) => ({
        manDays: a.manDays + r.manDays,
        dayManDays: a.dayManDays + r.dayManDays,
        halfManDays: a.halfManDays + r.halfManDays,
        nightManDays: a.nightManDays + r.nightManDays,
        otHours: a.otHours + r.otHours,
      }),
      { manDays: 0, dayManDays: 0, halfManDays: 0, nightManDays: 0, otHours: 0 },
    );
    return (
      <>
        <div className="section-head">
          <h3 className="section-subtitle">職人別（給料の見方）</h3>
        </div>
        <WorkerAccordion rows={byWorker} totals={totals} />

        <div className="section-head">
          <h3 className="section-subtitle">立替集計</h3>
          {expenses.grandTotal > 0 && (
            <span className="muted">{yen(expenses.grandTotal)}</span>
          )}
        </div>
        <ExpenseAggregation
          payers={expenses.payers}
          total={expenses.grandTotal}
        />

        <div className="section-head">
          <h3 className="section-subtitle">取引先別（請求の見方）</h3>
        </div>
        <ClientAccordion rows={clients} emptyLabel="この月のデータはありません。" />
      </>
    );
  }

  // フル管理者: 自社 ＋ 協力会社（全社）。
  const { self, partner, byWorker, selfTotals, expensePayers, expenseTotal } =
    await getMonthSummary(ym);
  return (
    <>
      {/* 職人別（給料の見方：後藤◯◯ 齋◯◯…のいつもの形） */}
      <div className="section-head">
        <h3 className="section-subtitle">職人別（給料の見方）</h3>
      </div>
      <WorkerAccordion
        rows={byWorker}
        totals={{
          manDays: selfTotals.manDays,
          dayManDays: selfTotals.dayManDays,
          halfManDays: selfTotals.halfManDays,
          nightManDays: selfTotals.nightManDays,
          otHours: selfTotals.otHours,
        }}
      />

      {/* 立替集計（立替えた人 × 用途 × 金額） */}
      <div className="section-head">
        <h3 className="section-subtitle">立替集計</h3>
        {expenseTotal > 0 && <span className="muted">{yen(expenseTotal)}</span>}
      </div>
      <ExpenseAggregation payers={expensePayers} total={expenseTotal} />

      {/* 自社 取引先別（請求の見方） */}
      <div className="section-head">
        <h3 className="section-subtitle">
          取引先別（請求の見方）<span className="badge badge--self">自社</span>
        </h3>
      </div>
      <ClientAccordion rows={self} emptyLabel="この月のデータはありません。" />

      {/* パートナー 取引先別 */}
      <div className="section-head">
        <h3 className="section-subtitle">取引先別（協力会社）</h3>
      </div>
      <ClientAccordion
        rows={partner}
        emptyLabel="この月の協力会社のデータはありません。"
      />
    </>
  );
}

/** 集計ストリーミング中のスケルトン。 */
function SummarySkeleton() {
  return (
    <div aria-hidden>
      <div className="skeleton-line" />
      <div className="skeleton-line" />
      <div className="skeleton-line" />
    </div>
  );
}

export default async function AggregatePage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string }>;
}) {
  const admin = await getAdminContext();
  if (!admin) {
    // middleware で保護済みだが、念のためログイン画面へ集約。
    redirect("/admin?error=login");
  }

  // スコープ管理者は自分の所属組織のみ閲覧。
  const scopeOrgId = adminScopeOrgId(admin);

  const sp = await searchParams;
  const ym = sp.ym && /^\d{4}-\d{2}$/.test(sp.ym) ? sp.ym : currentYearMonth();
  const { from } = monthRange(ym);

  // 月ナビ。
  const prev = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  const isCurrentMonth = ym === currentYearMonth();

  return (
    <main className="container container--admin">
      <div className="page-head">
        <h1 className="page-title">集計</h1>
      </div>

      {/* 月スイッチャー */}
      <div className="month-switch">
        <a
          className="month-nav"
          href={`/admin/aggregate?ym=${ymStr(prev)}`}
          aria-label="前月"
        >
          ◀
        </a>
        <span className="ym">
          {ym}
          {isCurrentMonth && <span className="ym-now">今月</span>}
        </span>
        <a
          className="month-nav"
          href={`/admin/aggregate?ym=${ymStr(next)}`}
          aria-label="翌月"
        >
          ▶
        </a>
      </div>

      <section className="block">
        <div className="section-head">
          <h2 className="section-title">今月の集計</h2>
          <span className="muted">{ym}</span>
        </div>

        {/* 月末の請求へ（集計を待たず即表示） */}
        <a href={`/admin/invoices?ym=${ym}`} className="invoice-cta">
          <span>
            <span className="invoice-cta-title">請求書を作る</span>
            <span className="invoice-cta-sub">集計どおりに月末発行</span>
          </span>
          <span className="invoice-cta-arrow" aria-hidden>
            ›
          </span>
        </a>

        <Suspense fallback={<SummarySkeleton />}>
          <MonthSummary ym={ym} scopeOrgId={scopeOrgId} />
        </Suspense>
      </section>
    </main>
  );
}

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
import { getAdminContext } from "@/lib/auth.js";
import { HelpToggle } from "../_help.js";
import {
  currentYearMonth,
  getMonthSummary,
  monthRange,
  type ClientMonthSummary,
} from "@/lib/aggregate.js";

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
              <span className="v">{r.manDays}</span>
            </div>
            <div className="kv">
              <span className="k">残業合計</span>
              <span className="v">{r.otHours} h</span>
            </div>
            <div className="kv">
              <span className="k">概算金額（税抜）</span>
              <span className="v">{yen(r.estimatedAmount)}</span>
            </div>
          </div>
        </details>
      ))}
    </>
  );
}

/**
 * 今月の集計（自社/パートナー＋自社合計）。
 * 重い集計を getMonthSummary（unstable_cache）で取得し、<Suspense> 配下で
 * ストリーミングする（月スイッチャー等の描画をブロックしない）。
 */
async function MonthSummary({ ym }: { ym: string }) {
  const { self, partner, byWorker, selfTotals } = await getMonthSummary(ym);
  return (
    <>
      {/* 自社 合計カード */}
      <div className="stat-grid">
        <div className="stat stat--accent stat--wide">
          <div className="stat-k">自社 概算金額（税抜）</div>
          <div className="stat-v">{yen(selfTotals.amount)}</div>
        </div>
        <div className="stat">
          <div className="stat-k">人工合計</div>
          <div className="stat-v">{selfTotals.manDays}</div>
        </div>
        <div className="stat">
          <div className="stat-k">残業合計</div>
          <div className="stat-v">
            {selfTotals.otHours}
            <small>h</small>
          </div>
        </div>
      </div>

      {/* 職人別（給料の見方：後藤◯◯ 齋◯◯…のいつもの形） */}
      <div className="section-head">
        <h3 className="section-subtitle">職人別（給料の見方）</h3>
      </div>
      <div className="help-bubble">
        <b>いつもの締めと同じ形。</b>{" "}
        誰が今月何人工・残業何時間か。給料計算はこの「人工 × 単価」が基本です。
      </div>
      {byWorker.length === 0 ? (
        <p className="muted">この月のデータはありません。</p>
      ) : (
        <table className="worker-table">
          <thead>
            <tr>
              <th>職人</th>
              <th>人工</th>
              <th>残業</th>
            </tr>
          </thead>
          <tbody>
            {byWorker.map((w) => (
              <tr key={w.workerName}>
                <td className="wt-name">{w.workerName}</td>
                <td>{w.manDays}</td>
                <td className="wt-ot">{w.otHours ? `${w.otHours}h` : "—"}</td>
              </tr>
            ))}
            <tr className="wt-total">
              <td>合計</td>
              <td>{selfTotals.manDays}</td>
              <td>{selfTotals.otHours}h</td>
            </tr>
          </tbody>
        </table>
      )}

      {/* 自社 取引先別（請求の見方） */}
      <div className="section-head">
        <h3 className="section-subtitle">
          取引先別（請求の見方）<span className="badge badge--self">自社</span>
        </h3>
      </div>
      <div className="help-bubble">
        <b>請求書を出す単位。</b>{" "}
        取引先ごとの人工・残業・概算金額。月末はこの取引先ごとに請求書を作ります。
        <br />
        ※ ここの概算は<b>人工・残業（税抜）</b>のみ。立替経費・請負は{" "}
        <a href={`/admin/invoices?ym=${ym}`}>請求書</a>で加算されます。
      </div>
      <ClientAccordion rows={self} emptyLabel="この月のデータはありません。" />

      {/* パートナー 取引先別 */}
      <div className="section-head">
        <h3 className="section-subtitle">取引先別（協力会社）</h3>
      </div>
      <p className="muted" style={{ marginTop: -4, marginBottom: 10 }}>
        ※ 管理画面のみで集約（出面グループには投稿されません）。
      </p>
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
      <div className="stat-grid">
        <div className="stat stat--wide skeleton-box" />
        <div className="stat skeleton-box" />
        <div className="stat skeleton-box" />
      </div>
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
        <HelpToggle />
      </div>

      <div className="help-bubble">
        <b>この画面の使い方</b>　今月の集計を「合計 → 職人別 → 取引先別」の順で確認できます。
        職人別は給料計算（人工 × 単価）、取引先別は請求書を出す単位です。月末は{" "}
        <a href={`/admin/invoices?ym=${ym}`}>請求書</a>を作るだけです。
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
          <MonthSummary ym={ym} />
        </Suspense>
      </section>

      <p className="muted" style={{ marginTop: 20 }}>
        ※ 例・初期データはすべてダミーです。
      </p>
    </main>
  );
}

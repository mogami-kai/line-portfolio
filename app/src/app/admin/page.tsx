// ============================================================
// /admin — 管理ダッシュボード（Server Component / モバイルファースト）
//
//   ガード: getAdminContext()（ADMIN 設定済みか）。未設定/未承認なら案内表示。
//   表示:
//     - 月スイッチャー（◀ yyyy-MM ▶, ?ym=）
//     - 当月の合計カード（自社の人工/残業/概算金額）
//     - 取引先別の折りたたみ行（人工/残業/金額）— 自社 / パートナーを分離
//        ※ パートナーは管理画面のみ（グループ非投稿）。冒頭に注記。
//     - NEEDS_REVIEW（要確認）一覧
//   集計は @/lib/aggregate（内部で @/lib/calc・@/lib/invoice を再利用）。
//   ※ サーバ側のデータ取得ロジック・ガードは従来どおり。表示のみ刷新。
// ============================================================

import { prisma } from "@/lib/db.js";
import { getAdminContext } from "@/lib/auth.js";
import {
  currentYearMonth,
  loadMonthRows,
  monthRange,
  summarizeByClient,
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

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string }>;
}) {
  const admin = await getAdminContext();
  if (!admin) {
    return (
      <main className="container">
        <h1 className="page-title" style={{ marginTop: 12 }}>
          管理ダッシュボード
        </h1>
        <div className="notice notice--error" style={{ marginTop: 12 }}>
          管理者が未設定、または未承認です。環境変数{" "}
          <code>ADMIN_LINE_USER_IDS</code> に管理者の LINE userId
          を設定し、その管理者が一度 LIFF
          を開いてユーザー登録（自動で role=ADMIN・承認済み）されると表示されます。
        </div>
      </main>
    );
  }

  const sp = await searchParams;
  const ym = sp.ym && /^\d{4}-\d{2}$/.test(sp.ym) ? sp.ym : currentYearMonth();

  // 自社 / パートナー を分けて集計。
  const [selfRows, partnerRows, needsReview] = await Promise.all([
    loadMonthRows(ym, { source: "SELF" }),
    loadMonthRows(ym, { source: "PARTNER" }),
    prisma.report.findMany({
      where: { status: "NEEDS_REVIEW" },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        client: { select: { name: true } },
        site: { select: { name: true } },
        org: { select: { name: true, kind: true } },
        entries: { select: { manDays: true, otHours: true } },
      },
    }),
  ]);

  const [selfSummary, partnerSummary] = await Promise.all([
    summarizeByClient(ym, selfRows),
    summarizeByClient(ym, partnerRows),
  ]);

  // 自社の合計（大カード用）。
  const selfTotalMd = selfSummary.reduce((a, r) => a + r.manDays, 0);
  const selfTotalOt = selfSummary.reduce((a, r) => a + r.otHours, 0);
  const selfTotalAmt = selfSummary.reduce((a, r) => a + r.estimatedAmount, 0);

  // 月ナビ。
  const { from } = monthRange(ym);
  const prev = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));

  return (
    <main className="container">
      <div className="page-head">
        <h1 className="page-title">管理ダッシュボード</h1>
        <a href={`/admin/invoices?ym=${ym}`} className="badge badge--self">
          請求書 →
        </a>
      </div>
      <p className="page-sub">ようこそ {admin.user.displayName} さん</p>

      {/* 月スイッチャー */}
      <div className="month-switch">
        <a
          className="month-nav"
          href={`/admin?ym=${ymStr(prev)}`}
          aria-label="前月"
        >
          ◀
        </a>
        <span className="ym">{ym}</span>
        <a
          className="month-nav"
          href={`/admin?ym=${ymStr(next)}`}
          aria-label="翌月"
        >
          ▶
        </a>
      </div>

      {/* 自社 合計カード */}
      <div className="stat-grid">
        <div className="stat stat--accent stat--wide">
          <div className="stat-k">自社 概算金額（税抜）</div>
          <div className="stat-v">{yen(selfTotalAmt)}</div>
        </div>
        <div className="stat">
          <div className="stat-k">人工合計</div>
          <div className="stat-v">{selfTotalMd}</div>
        </div>
        <div className="stat">
          <div className="stat-k">残業合計</div>
          <div className="stat-v">
            {selfTotalOt}
            <small>h</small>
          </div>
        </div>
      </div>

      {/* 自社 取引先別 */}
      <div className="section-head">
        <h2 className="section-title">
          自社 <span className="badge badge--self">SELF</span>
        </h2>
      </div>
      <ClientAccordion rows={selfSummary} emptyLabel="この月のデータはありません。" />

      {/* パートナー 取引先別 */}
      <div className="section-head">
        <h2 className="section-title">
          パートナー <span className="badge badge--partner">PARTNER</span>
        </h2>
      </div>
      <p className="muted" style={{ marginTop: -4, marginBottom: 10 }}>
        ※ パートナーのデータは管理画面のみで集約します（出面グループには投稿されません）。
      </p>
      <ClientAccordion
        rows={partnerSummary}
        emptyLabel="この月のパートナーデータはありません。"
      />

      {/* 要確認キュー */}
      <div className="section-head">
        <h2 className="section-title">
          要確認{" "}
          {needsReview.length > 0 && (
            <span className="badge badge--review">{needsReview.length}件</span>
          )}
        </h2>
      </div>
      {needsReview.length === 0 ? (
        <p className="muted">要確認のレポートはありません。</p>
      ) : (
        <div className="list">
          {needsReview.map((r) => {
            const md = r.entries.reduce(
              (a, e) => a + Number(e.manDays || 0),
              0,
            );
            const ot = r.entries.reduce(
              (a, e) => a + Number(e.otHours || 0),
              0,
            );
            const d = r.workDate;
            const ds = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
            const isPartner = r.org.kind === "PARTNER";
            return (
              <div className="list-row" key={r.id}>
                <div className="list-main">
                  <div className="list-title">
                    {r.client.name}
                    <span
                      className={`badge ${
                        isPartner ? "badge--partner" : "badge--self"
                      }`}
                      style={{ marginLeft: 6 }}
                    >
                      {r.org.kind}
                    </span>
                  </div>
                  <div className="list-meta">
                    {ds} ・ {r.site?.name ?? "(現場未設定)"} ・ {r.org.name}
                  </div>
                </div>
                <div className="list-figs">
                  <span className="fig">
                    <span className="n">{md}</span>
                    <span className="u">人工</span>
                  </span>
                  <span className="fig">
                    <span className="n">{ot}</span>
                    <span className="u">残業h</span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="muted" style={{ marginTop: 20 }}>
        ※ 例・初期データはすべてダミーです。
      </p>
    </main>
  );
}

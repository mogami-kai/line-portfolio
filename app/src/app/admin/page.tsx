// ============================================================
// /admin — 管理ダッシュボード（Server Component）
//
//   設計思想（学習コスト≒0／「次の行動」最優先）:
//     ホームは「次にやること（判断）」に集約する。
//       0) 次にやること … 状態から導いた最優先導線（adminInsights）
//       0') 今月の状態 … 入力/要確認/承認待ち/請求候補 等の指標カード（metric-grid）
//       1) 要確認（NEEDS_REVIEW）… その場で「承認」「削除」できる行動カード
//       2) 直近の出面 … 当月の入力フィード（LINE グループと同じ並びで一目確認）
//       3) 集計・請求 … くわしい数字は「集計」へ、月末は「請求書」へ（導線のみ）
//     詳細な月次集計（合計・職人別・取引先別）は /admin/aggregate（集計）へ分離した。
//
//   レイアウト:
//     - PC（≥1024px）: 左に「日々のチェック」(①②)、右に「集計・請求」への導線 の 2 カラム。
//     - モバイル: 縦 1 列（.admin-grid / globals.css）。
//
//   ガード: getAdminContext()。指標は @/lib/adminInsights。
//   行動（承認/削除）は _actions.ts の Server Action（多層 ADMIN ガード）。
// ============================================================

import { prisma } from "@/lib/db.js";
import { getAdminContext } from "@/lib/auth.js";
import { HelpToggle } from "./_help.js";
import { RecentFeed, type FeedItem } from "./_feed.js";
import {
  confirmReportAction,
  deleteReportAction,
} from "./_actions.js";
import { currentYearMonth, monthRange } from "@/lib/aggregate.js";

export const dynamic = "force-dynamic";

const ymStr = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const WEEKDAY_JP = ["日", "月", "火", "水", "木", "金", "土"] as const;
/** 出面日（UTC 0時保存）を "M/D(曜)" で。前日/翌日にズレないよう UTC で読む。 */
const mdW = (d: Date) =>
  `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAY_JP[d.getUTCDay()]})`;

const LOGIN_ERROR_MESSAGES: Record<string, string> = {
  login: "ログインが必要です。LINE でログインしてください。",
  forbidden:
    "このアカウントには管理権限がありません（承認済み ADMIN のみ）。管理者にご確認ください。",
  denied: "ログインがキャンセルされました。",
  state: "セッションが無効です。お手数ですが、もう一度ログインしてください。",
  token: "LINE 認証に失敗しました。もう一度お試しください。",
  profile: "プロフィール取得に失敗しました。もう一度お試しください。",
  session: "セッションの発行に失敗しました（SESSION_SECRET 未設定の可能性）。",
};

/** 未ログイン時のログイン画面（LINE Login へ誘導）。 */
function LoginScreen({ error }: { error?: string }) {
  const msg = error ? LOGIN_ERROR_MESSAGES[error] : undefined;
  return (
    <main className="container">
      <div className="hero">
        <h1>管理ログイン</h1>
        <p>LINE でログインして管理ダッシュボードを開きます。</p>
      </div>
      {msg && (
        <div
          className={`notice ${
            error === "denied" || error === "login"
              ? "notice--warn"
              : "notice--error"
          }`}
          style={{ marginTop: 12 }}
        >
          {msg}
        </div>
      )}
      <a
        href="/api/auth/line/login"
        className="big-link big-link--primary"
        style={{ marginTop: 16 }}
      >
        <span>
          <span className="bl-title">LINE でログイン</span>
          <span className="bl-sub">承認済みの管理者のみ入室できます</span>
        </span>
      </a>
      <p className="muted center" style={{ marginTop: 24 }}>
        ログインできない場合は、管理者にご連絡ください。
      </p>
    </main>
  );
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const admin = await getAdminContext();
  if (!admin) {
    return <LoginScreen error={sp.error} />;
  }

  const ym = sp.ym && /^\d{4}-\d{2}$/.test(sp.ym) ? sp.ym : currentYearMonth();
  const { from, to } = monthRange(ym);

  // 「日々のチェック」の主役データだけを取得（要確認＋当月フィード）。
  // 重い月次集計は本ページから分離し、/admin/aggregate（集計）へ移設した。
  const [needsReview, recent] = await Promise.all([
    prisma.report.findMany({
      where: { status: "NEEDS_REVIEW" },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        client: { select: { name: true } },
        site: { select: { name: true } },
        org: { select: { name: true, kind: true } },
        entries: { include: { worker: { select: { name: true } } } },
      },
    }),
    prisma.report.findMany({
      where: { workDate: { gte: from, lt: to } },
      orderBy: [{ workDate: "desc" }, { createdAt: "desc" }],
      take: 200, // 当月全件（「表示」で展開）。当月件数の現実的上限＝クライアント転送量の上限。
      // フィードに必要な列だけを select（include で全列を引かず RSC ペイロードを最小化）。
      select: {
        id: true,
        workDate: true,
        status: true,
        client: { select: { name: true } },
        site: { select: { name: true } },
        org: { select: { kind: true } },
        entries: {
          select: { manDays: true, otHours: true, worker: { select: { name: true } } },
        },
      },
    }),
  ]);

  // 月ナビ。
  const prev = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  const isCurrentMonth = ym === currentYearMonth();

  // 直近の出面フィード（コンパクト3列＋「表示」で当月全件）用のプレーン配列。
  // Server Component で集計まで済ませ、Client Component には素の値だけ渡す。
  const feedItems: FeedItem[] = recent.map((r) => ({
    id: r.id,
    date: mdW(r.workDate),
    client: r.client.name,
    site: r.site?.name ?? "(現場未設定)",
    names: r.entries
      .map((e) => e.worker?.name)
      .filter(Boolean)
      .join("　"),
    md: r.entries.reduce((a, e) => a + Number(e.manDays || 0), 0),
    ot: r.entries.reduce((a, e) => a + Number(e.otHours || 0), 0),
    partner: r.org.kind === "PARTNER",
    review: r.status === "NEEDS_REVIEW",
  }));

  return (
    <main className="container container--admin">
      <div className="page-head">
        <h1 className="page-title">ホーム</h1>
        <HelpToggle />
      </div>

      <div className="help-bubble">
        <b>この画面の使い方</b>　毎日はこの2ステップだけ：
        ① <b>要確認</b>を片付ける（承認 か 削除）→ ② <b>直近の出面</b>で今日の入力を確認。
        くわしい数字は <a href={`/admin/aggregate?ym=${ym}`}>集計</a>、月末は <b>請求書</b>を作るだけです。
      </div>

      {/* 月スイッチャー */}
      <div className="month-switch">
        <a className="month-nav" href={`/admin?ym=${ymStr(prev)}`} aria-label="前月">
          ◀
        </a>
        <span className="ym">
          {ym}
          {isCurrentMonth && <span className="ym-now">今月</span>}
        </span>
        <a className="month-nav" href={`/admin?ym=${ymStr(next)}`} aria-label="翌月">
          ▶
        </a>
      </div>

      {/* PC は 2 カラム（左=日々のチェック / 右=集計・請求）。モバイルは縦 1 列。 */}
      <div className="admin-grid">
        {/* ───────── 左：日々のチェック（主役）───────── */}
        <div className="admin-main">
          {/* ① 要確認（行動カード） */}
          <section className="block">
            <div className="section-head">
              <h2 className="section-title">
                要確認{" "}
                {needsReview.length > 0 && (
                  <span className="badge badge--review">{needsReview.length}件</span>
                )}
              </h2>
            </div>
            <div className="help-bubble">
              <b>いちばん大事な場所。</b>{" "}
              入力された出面のうち「念のため確認したいもの」が並びます。内容を見て、合っていれば{" "}
              <b>承認</b>、間違いなら <b>削除</b>。ここが空なら確認待ちゼロ＝OKです。
            </div>
            {needsReview.length === 0 ? (
              <div className="empty-ok">確認待ちはありません。</div>
            ) : (
              <div className="review-list">
                {needsReview.map((r) => {
                  const md = r.entries.reduce((a, e) => a + Number(e.manDays || 0), 0);
                  const ot = r.entries.reduce((a, e) => a + Number(e.otHours || 0), 0);
                  const isPartner = r.org.kind === "PARTNER";
                  const names = r.entries
                    .map((e) => e.worker?.name)
                    .filter(Boolean)
                    .join("　");
                  return (
                    <div className="review-card" key={r.id}>
                      <div className="review-body">
                        <div className="review-title">
                          <span className="review-date">{mdW(r.workDate)}</span>
                          {r.client.name}
                          <span
                            className={`badge ${
                              isPartner ? "badge--partner" : "badge--self"
                            }`}
                          >
                            {r.org.kind === "SELF" ? "自社" : "協力会社"}
                          </span>
                        </div>
                        <div className="review-meta">
                          {r.site?.name ?? "(現場未設定)"} ・ {r.org.name}
                        </div>
                        {names && <div className="review-names">{names}</div>}
                        <div className="review-figs">
                          <span>
                            人工 <b>{md}</b>
                          </span>
                          {ot > 0 && (
                            <span>
                              残業 <b>{ot}</b>h
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="review-actions">
                        <form action={confirmReportAction}>
                          <input type="hidden" name="id" value={r.id} />
                          <button type="submit" className="btn btn--primary btn--sm">
                            承認
                          </button>
                        </form>
                        <form action={deleteReportAction}>
                          <input type="hidden" name="id" value={r.id} />
                          <button type="submit" className="btn btn--danger-text btn--sm">
                            削除
                          </button>
                        </form>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ② 直近の出面（当月フィード） */}
          <section className="block">
            <div className="section-head">
              <h2 className="section-title">直近の出面</h2>
              <span className="muted">{ym} の入力</span>
            </div>
            <div className="help-bubble">
              <b>今月の入力一覧。</b>{" "}
              最近の出面を小さなカードで並べています（日付／取引先／現場／職人）。下の「<b>全件を表示</b>」を押すと、その月の全件が開きます。ここを眺めれば「今日の分が入っているか」が一目で分かります。
            </div>
            {recent.length === 0 ? (
              <div className="empty-state">
                <div className="es-title">まだ {ym} の出面がありません</div>
                <p className="es-sub">
                  出面入力（LINE）から送られた出面が、ここに表示されます。
                </p>
                <div className="es-actions">
                  <a href="/admin/masters" className="btn btn--ghost btn--sm">
                    マスタを確認
                  </a>
                </div>
              </div>
            ) : (
              <RecentFeed items={feedItems} />
            )}
          </section>
        </div>

        {/* ───────── 右：集計・請求への導線（常時表示の脇）───────── */}
        <aside className="admin-aside">
          {/* 集計・請求（くわしい数字は集計ページ、月末は請求書） */}
          <section className="block">
            <div className="section-head">
              <h2 className="section-title">集計・請求</h2>
            </div>

            {/* くわしい集計へ（合計・職人別・取引先別） */}
            <a href={`/admin/aggregate?ym=${ym}`} className="invoice-cta">
              <span>
                <span className="invoice-cta-title">集計を見る</span>
                <span className="invoice-cta-sub">合計・職人別・取引先別</span>
              </span>
              <span className="invoice-cta-arrow" aria-hidden>
                ›
              </span>
            </a>

            {/* 月末の請求へ */}
            <a
              href={`/admin/invoices?ym=${ym}`}
              className="invoice-cta"
              style={{ marginTop: 10 }}
            >
              <span>
                <span className="invoice-cta-title">請求書を作る</span>
                <span className="invoice-cta-sub">集計どおりに月末発行</span>
              </span>
              <span className="invoice-cta-arrow" aria-hidden>
                ›
              </span>
            </a>
          </section>
        </aside>
      </div>

      <p className="muted" style={{ marginTop: 20 }}>
        ※ 例・初期データはすべてダミーです。
      </p>
    </main>
  );
}

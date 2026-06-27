// ============================================================
// /admin のナビゲーション時スケルトン（App Router loading.tsx）
//   月切替や遷移時に「真っ白で固まった」体験を避け、即座に骨組みを出す。
//   実データが揃い次第、page.tsx の内容に差し替わる。
// ============================================================

export default function AdminLoading() {
  return (
    <main className="container container--admin">
      <div className="page-head">
        <h1 className="page-title">管理ダッシュボード</h1>
        <span className="muted">読み込み中…</span>
      </div>

      <div className="admin-grid" style={{ marginTop: 12 }}>
        <div className="admin-main">
          <div className="block">
            <div className="skeleton-line skeleton-line--head" />
            <div className="review-card skeleton-box" style={{ minHeight: 96 }} />
            <div className="review-card skeleton-box" style={{ minHeight: 96 }} />
          </div>
          <div className="block">
            <div className="skeleton-line skeleton-line--head" />
            <div className="list">
              <div className="list-row skeleton-box" style={{ minHeight: 60 }} />
              <div className="list-row skeleton-box" style={{ minHeight: 60 }} />
              <div className="list-row skeleton-box" style={{ minHeight: 60 }} />
            </div>
          </div>
        </div>

        <aside className="admin-aside">
          <div className="block">
            <div className="skeleton-line skeleton-line--head" />
            <div className="stat-grid">
              <div className="stat stat--wide skeleton-box" />
              <div className="stat skeleton-box" />
              <div className="stat skeleton-box" />
            </div>
            <div className="skeleton-line" />
            <div className="skeleton-line" />
          </div>
        </aside>
      </div>
    </main>
  );
}

// ============================================================
// / — ランディング（/liff・/admin への入口）
//   モバイルファースト: 大きな2ボタンだけのシンプル画面。
// ============================================================

export default function HomePage() {
  return (
    <main className="container">
      <div className="hero">
        <h1>出面管理</h1>
        <p>出面の入力から月次集計、請求書発行まで。</p>
      </div>

      <a href="/liff" className="big-link big-link--primary">
        <span className="bl-ico" aria-hidden>
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
            <path d="M14 3v6h6" />
            <path d="M9 13h6M9 17h4" />
          </svg>
        </span>
        <span>
          <span className="bl-title">出面入力</span>
          <span className="bl-sub">LINE から出面を入力</span>
        </span>
      </a>

      <a href="/admin" className="big-link">
        <span className="bl-ico" aria-hidden>
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3v18h18" />
            <rect x="7" y="11" width="3" height="7" rx="0.5" />
            <rect x="13" y="7" width="3" height="11" rx="0.5" />
          </svg>
        </span>
        <span>
          <span className="bl-title">管理</span>
          <span className="bl-sub">月次集計・要確認・請求書発行</span>
        </span>
      </a>
    </main>
  );
}

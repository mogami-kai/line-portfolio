// ============================================================
// / — ランディング（/liff・/admin への入口）
//   モバイルファースト: 大きな2ボタンだけのシンプル画面。
// ============================================================

export default function HomePage() {
  return (
    <main className="container">
      <div className="hero">
        <h1>出面管理</h1>
        <p>入力 → 集計 → 請求書まで、毎日かんたん。</p>
      </div>

      <a href="/liff" className="big-link big-link--primary">
        <span className="bl-ico" aria-hidden>
          📝
        </span>
        <span>
          <span className="bl-title">日報入力（LIFF）</span>
          <span className="bl-sub">LINE で開く出面入力フォーム</span>
        </span>
      </a>

      <a href="/admin" className="big-link">
        <span className="bl-ico" aria-hidden>
          📊
        </span>
        <span>
          <span className="bl-title">管理（ADMIN）</span>
          <span className="bl-sub">月次集計・要確認・請求書発行</span>
        </span>
      </a>

      <p className="muted center" style={{ marginTop: 24 }}>
        ※ 例・初期データはすべてダミーです。
      </p>
    </main>
  );
}

// ============================================================
// /invite/done — 招待の受諾完了（管理画面に入らないロール向け）
//
//   自社メンバー(OWNER) / 協力会社(PARTNER) は管理画面に入らないため、
//   /admin へ飛ばさずここで完了を伝える（入力は LINE のリッチメニューから）。
// ============================================================

export const dynamic = "force-static";

export default function InviteDonePage() {
  return (
    <main className="container">
      <div className="hero">
        <h1>参加が完了しました</h1>
        <p>権限が付与されました。</p>
      </div>
      <div className="notice" style={{ marginTop: 12 }}>
        出面の入力は <strong>LINE のメニュー（出面入力）</strong> から行えます。
        この画面は閉じてかまいません。
      </div>
    </main>
  );
}

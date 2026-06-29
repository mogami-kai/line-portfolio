// ============================================================
// /admin 共通レイアウト（AppShell）
//   ログイン済み管理者のときだけシェル（サイドバー/ヘッダー）を着せる。
//   未ログイン時は children をそのまま返す（各ページのログイン画面が全画面表示）。
//   認証の実体ガードは各ページ/Server Action/middleware が担う（ここは表示の器）。
// ============================================================

import type { ReactNode } from "react";
import { getAdminContext, isOpenAdmin } from "@/lib/auth.js";
import { AdminShell } from "./_shell/AdminShell.js";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const admin = await getAdminContext();
  if (!admin) return <>{children}</>;
  // 一時開放中は、誰でも入れる状態であることを管理画面の最上部に常時警告する。
  const open = isOpenAdmin();
  return (
    <AdminShell userName={admin.user.displayName}>
      {open && (
        <div className="notice notice--warn" style={{ marginBottom: 12 }}>
          <b>一時開放モード</b>：いま LINE でログインした人は<b>誰でも</b>この管理画面に入れます（実データの閲覧・編集・削除が可能）。公開を終えたら、Vercel の環境変数 <code>OPEN_ADMIN</code> を外してください。
        </div>
      )}
      {children}
    </AdminShell>
  );
}

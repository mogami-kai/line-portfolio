// ============================================================
// /admin 共通レイアウト（AppShell）
//   ログイン済み管理者のときだけシェル（サイドバー/ヘッダー）を着せる。
//   未ログイン時は children をそのまま返す（各ページのログイン画面が全画面表示）。
//   認証の実体ガードは各ページ/Server Action/middleware が担う（ここは表示の器）。
// ============================================================

import type { ReactNode } from "react";
import { getAdminContext, adminScope } from "@/lib/auth.js";
import { AdminShell } from "./_shell/AdminShell.js";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const admin = await getAdminContext();
  if (!admin) return <>{children}</>;
  // スコープ管理者（自社管理者/協力会社管理者）は ホーム・集計・請求 のみ表示。
  const scoped = adminScope(admin) === "ORG";
  return (
    <AdminShell userName={admin.user.displayName} scoped={scoped}>
      {children}
    </AdminShell>
  );
}

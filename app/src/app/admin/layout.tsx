// ============================================================
// /admin 共通レイアウト（AppShell）
//   ログイン済み管理者のときだけシェル（サイドバー/ヘッダー）を着せる。
//   未ログイン時は children をそのまま返す（各ページのログイン画面が全画面表示）。
//   認証の実体ガードは各ページ/Server Action/middleware が担う（ここは表示の器）。
// ============================================================

import type { ReactNode } from "react";
import { getAdminContext } from "@/lib/auth.js";
import { AdminShell } from "./_shell/AdminShell.js";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const admin = await getAdminContext();
  if (!admin) return <>{children}</>;
  return <AdminShell userName={admin.user.displayName}>{children}</AdminShell>;
}

// ============================================================
// GET /api/receipts/view?path=… — 領収書写真の閲覧（管理者のみ）
//
//   ガード: getAdminContext()。スコープ管理者（SELF_ADMIN/ORG_ADMIN）は
//   パス先頭の orgId が自組織のものだけ閲覧可（パス設計 {orgId}/… を利用）。
//   期限付き署名URL（10分）を発行して 302 リダイレクト（公開URLは作らない）。
// ============================================================

import { NextResponse } from "next/server";
import { adminScopeOrgId, getAdminContext } from "@/lib/auth.js";
import { signReceiptUrl } from "@/lib/storage.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// {orgId}/{yyyy-MM}/{uuid}.{jpg|png} のみ許可（トラバーサル/別パス参照の遮断）。
const PATH_RE = /^[a-z0-9]+\/\d{4}-\d{2}\/[0-9a-f-]{36}\.(jpg|png)$/;

export async function GET(req: Request) {
  const admin = await getAdminContext();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const path = url.searchParams.get("path") ?? "";
  if (!PATH_RE.test(path)) {
    return NextResponse.json({ ok: false, error: "bad_path" }, { status: 400 });
  }

  // スコープ管理者は自組織のフォルダのみ。
  const scopeOrgId = adminScopeOrgId(admin);
  if (scopeOrgId && !path.startsWith(`${scopeOrgId}/`)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  try {
    const signed = await signReceiptUrl(path);
    return NextResponse.redirect(signed, 302);
  } catch (e) {
    console.error("[receipts] sign failed", e);
    return NextResponse.json(
      { ok: false, error: "sign_failed" },
      { status: 502 },
    );
  }
}

// ============================================================
// GET /api/receipts/view?path=… — 領収書写真の表示（管理者のみ）
//
//   path = ReceiptImage.id。DB から画像を読み、そのまま画像として返す
//   （<img src="/api/receipts/view?path=…"> で編集モーダル内にレンダリングできる。
//     認証は管理セッションクッキー＝同一オリジンの <img> でそのまま通る）。
//   スコープ管理者（SELF_ADMIN/ORG_ADMIN）は自組織（ReceiptImage.orgId 一致）のみ。
// ============================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db.js";
import { adminScopeOrgId, getAdminContext } from "@/lib/auth.js";
import { isValidReceiptId } from "@/lib/storage.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const admin = await getAdminContext();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("path") ?? "";
  if (!isValidReceiptId(id)) {
    return NextResponse.json({ ok: false, error: "bad_path" }, { status: 400 });
  }

  const img = await prisma.receiptImage.findUnique({
    where: { id },
    select: { orgId: true, mime: true, data: true },
  });
  if (!img) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // スコープ管理者は自組織の画像のみ。
  const scopeOrgId = adminScopeOrgId(admin);
  if (scopeOrgId && img.orgId !== scopeOrgId) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  return new NextResponse(new Uint8Array(img.data), {
    status: 200,
    headers: {
      "Content-Type": img.mime,
      // 認証付きの私的画像。ブラウザ内キャッシュのみ許可（共有キャッシュ禁止）。
      "Cache-Control": "private, max-age=600",
      "Content-Disposition": "inline",
    },
  });
}

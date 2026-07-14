// ============================================================
// POST /api/receipts — 領収書写真アップロード（LIFF から）
//
//   1) Authorization: Bearer <LIFF access token> → User+Org（未承認は403）
//   2) ボディ＝画像そのもの（クライアントで圧縮済み JPEG/PNG）
//   3) マジックバイト検証＋サイズ上限 → DB（ReceiptImage）へ直接保存
//   4) { ok, path } を返す（path = ReceiptImage.id。/api/reports の
//      expenses[].receiptPath に載せる）
//
//   外部ストレージ・環境変数は不要（設定ゼロで動く）。出面に紐づかず残った
//   孤児レコードは害がない（非公開・数百KB）ため v1 では放置。
// ============================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db.js";
import {
  bearerToken,
  requireApproved,
  resolveUserFromAccessToken,
} from "@/lib/auth.js";
import { sniffImageType } from "@/lib/storage.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// クライアントは長辺1600px/JPEG80%へ圧縮してから送る想定（通常は数百KB）。
// 5MB は「圧縮を通らなかった端末」向けの安全網。
const MAX_BYTES = 5 * 1024 * 1024;

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status });
}

export async function POST(req: Request) {
  const token = bearerToken(req.headers.get("authorization"));
  if (!token) return json(401, { ok: false, error: "missing access token" });
  const resolved = await resolveUserFromAccessToken(token);
  if (!resolved) return json(401, { ok: false, error: "invalid access token" });
  try {
    requireApproved(resolved);
  } catch {
    return json(403, {
      ok: false,
      error: "not_approved",
      message: "アカウントが未承認です。管理者の承認をお待ちください。",
    });
  }
  const { org } = resolved;
  if (!org.active) {
    return json(403, { ok: false, error: "org_disabled" });
  }

  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length === 0) {
    return json(400, { ok: false, error: "empty_body" });
  }
  if (buf.length > MAX_BYTES) {
    return json(413, {
      ok: false,
      error: "too_large",
      message: "画像が大きすぎます（5MBまで）。",
    });
  }
  const type = sniffImageType(buf);
  if (!type) {
    return json(415, {
      ok: false,
      error: "unsupported_type",
      message: "JPEG/PNG の画像のみアップロードできます。",
    });
  }

  try {
    const created = await prisma.receiptImage.create({
      data: {
        orgId: org.id,
        mime: type === "png" ? "image/png" : "image/jpeg",
        data: Buffer.from(buf),
      },
      select: { id: true },
    });
    return json(200, { ok: true, path: created.id });
  } catch (e) {
    console.error("[receipts] save failed", e);
    return json(502, {
      ok: false,
      error: "upload_failed",
      message:
        "領収書の保存に失敗しました。時間をおいてお試しください（管理者向け: ReceiptImage テーブル未作成の可能性）。",
    });
  }
}

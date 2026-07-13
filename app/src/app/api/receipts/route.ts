// ============================================================
// POST /api/receipts — 領収書写真アップロード（LIFF から）
//
//   1) Authorization: Bearer <LIFF access token> → User+Org（未承認は403）
//   2) ボディ＝画像そのもの（クライアントで圧縮済み JPEG/PNG）
//   3) マジックバイト検証＋サイズ上限 → Supabase Storage（非公開 receipts）へ保存
//   4) { ok, path } を返す（path は /api/reports の expenses[].receiptPath に載せる）
//
//   保存先パス: {orgId}/{yyyy-MM}/{uuid}.jpg → 組織スコープの閲覧制御に使う。
//   出面に紐づかず残った孤児ファイルは害がない（非公開・少容量）ため v1 では放置。
// ============================================================

import { NextResponse } from "next/server";
import {
  bearerToken,
  requireApproved,
  resolveUserFromAccessToken,
} from "@/lib/auth.js";
import {
  receiptsConfigured,
  sniffImageType,
  uploadReceipt,
} from "@/lib/storage.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// クライアントは長辺1600px/JPEG80%へ圧縮してから送る想定（通常は数百KB）。
// 5MB は「圧縮を通らなかった端末」向けの安全網。
const MAX_BYTES = 5 * 1024 * 1024;

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status });
}

export async function POST(req: Request) {
  if (!receiptsConfigured()) {
    return json(503, {
      ok: false,
      error: "not_configured",
      message:
        "領収書の保存先が未設定です（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）。",
    });
  }

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
    const path = await uploadReceipt(buf, type, org.id);
    return json(200, { ok: true, path });
  } catch (e) {
    console.error("[receipts] upload failed", e);
    return json(502, {
      ok: false,
      error: "upload_failed",
      message: "領収書の保存に失敗しました。時間をおいてお試しください。",
    });
  }
}

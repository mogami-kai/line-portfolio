// ============================================================
// Supabase Storage ヘルパー（SDK 非依存・fetch のみ／line.ts と同じ流儀）
//   - uploadReceipt : 領収書画像を非公開バケット receipts へ保存 → パスを返す
//   - signReceiptUrl: パス → 期限付き署名URL（既定10分）
//   - sniffImageType: マジックバイトで JPEG/PNG を判定（Content-Type 偽装対策）
//
// 必要な環境変数（Vercel）:
//   SUPABASE_URL              … https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY … Settings → API の service_role（サーバー専用・秘匿）
// バケット: receipts（非公開）を Supabase ダッシュボードで作成しておく。
// ============================================================

import crypto from "node:crypto";

const BUCKET = "receipts";

function supabaseUrl(): string {
  const u = process.env.SUPABASE_URL;
  if (!u) throw new Error("SUPABASE_URL is not set");
  return u.replace(/\/+$/, "");
}

function serviceRoleKey(): string {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!k) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return k;
}

/** 領収書機能が設定済みか（未設定なら LIFF 側でボタンを出さない判断に使える）。 */
export function receiptsConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * マジックバイトで画像種別を判定する。JPEG/PNG のみ許可（HEIC はクライアントで
 * canvas 再エンコードにより JPEG 化される前提）。該当しなければ null。
 */
export function sniffImageType(bytes: Uint8Array): "jpeg" | "png" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  return null;
}

/**
 * 領収書パスの妥当性（"{orgId}/{yyyy-MM}/{uuid}.{jpg|png}" 形式か）。
 * /api/reports で受け取ったパスの注入対策（../ や別バケット参照を遮断）。
 */
export function isValidReceiptPath(path: string, orgId: string): boolean {
  return new RegExp(
    `^${orgId}/\\d{4}-\\d{2}/[0-9a-f-]{36}\\.(jpg|png)$`,
  ).test(path);
}

/**
 * 画像を receipts バケットへ保存し、バケット内パスを返す。
 * パス: {orgId}/{yyyy-MM}/{uuid}.{ext}
 */
export async function uploadReceipt(
  bytes: Uint8Array,
  type: "jpeg" | "png",
  orgId: string,
): Promise<string> {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const ext = type === "png" ? "png" : "jpg";
  const path = `${orgId}/${ym}/${crypto.randomUUID()}.${ext}`;

  const res = await fetch(
    `${supabaseUrl()}/storage/v1/object/${BUCKET}/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey()}`,
        "Content-Type": type === "png" ? "image/png" : "image/jpeg",
        "x-upsert": "false",
      },
      body: bytes as unknown as BodyInit,
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`receipt upload failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return path;
}

/** パス → 期限付き署名URL（既定10分）。 */
export async function signReceiptUrl(
  path: string,
  expiresInSec = 600,
): Promise<string> {
  const res = await fetch(
    `${supabaseUrl()}/storage/v1/object/sign/${BUCKET}/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: expiresInSec }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`receipt sign failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { signedURL?: string };
  if (!data.signedURL) throw new Error("receipt sign failed: no signedURL");
  // signedURL は "/object/sign/receipts/...?token=..."（先頭スラッシュ有無どちらも来る）。
  const rel = data.signedURL.startsWith("/") ? data.signedURL : `/${data.signedURL}`;
  return `${supabaseUrl()}/storage/v1${rel}`;
}

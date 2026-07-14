-- 領収書写真: Expense に参照列を追加＋画像本体テーブル ReceiptImage を作成。
-- （画像はDBに直接保存＝外部ストレージ/環境変数の設定は不要）
-- Supabase SQL Editor で実行してください（再実行しても安全）。
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "receiptPath" TEXT;

CREATE TABLE IF NOT EXISTS "ReceiptImage" (
  "id" TEXT PRIMARY KEY,
  "orgId" TEXT NOT NULL,
  "mime" TEXT NOT NULL,
  "data" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "ReceiptImage_orgId_idx" ON "ReceiptImage"("orgId");

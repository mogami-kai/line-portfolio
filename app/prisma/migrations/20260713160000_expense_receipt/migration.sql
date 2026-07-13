-- 領収書写真: Expense に Storage パス列を追加（追加のみ・NULL許容＝既存行/旧コードに影響なし）。
-- Supabase SQL Editor で実行してください。
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "receiptPath" TEXT;

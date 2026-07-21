-- 取引先ごとの支払期限（翌月の何日か）と、請求書の支払期限スナップショット列を追加。
--   Client.paymentDay : 翌月の支払日（1-31）。NULL = 末日（既定）。
--   Invoice.dueDate   : 生成時に確定した支払期限。NULL = 旧データ（出力時 issueDate へフォールバック）。
-- どちらも NULL 許容の追加列のみ（既存データ・既存挙動に影響なし）。
-- IF NOT EXISTS 付き（冪等）= Supabase SQL Editor 等で手動適用済みでも、後日の
--   `prisma migrate deploy` が再実行しても安全（no-op で履歴だけ記録される）。
ALTER TABLE "Client"  ADD COLUMN IF NOT EXISTS "paymentDay" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "dueDate"    DATE;

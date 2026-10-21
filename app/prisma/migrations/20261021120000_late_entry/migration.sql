-- 後日入力（「忘れてた」と後から入れる出面）を承認制にする。
--   InvoiceSetting.lateEntryDays : 出面の日付からこの日数以上たって LIFF から入力されたら要確認。
--                                  既定 2（当日・翌日の入力はそのまま）。NULL = 使わない。
-- 追加列は IF NOT EXISTS 付き（冪等）。
ALTER TABLE "InvoiceSetting" ADD COLUMN IF NOT EXISTS "lateEntryDays" INTEGER DEFAULT 2;

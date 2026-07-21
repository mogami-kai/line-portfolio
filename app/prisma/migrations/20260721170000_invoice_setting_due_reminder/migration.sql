-- 入金確認リマインド（LINE DM）の設定を InvoiceSetting に追加。
--   dueReminderEnabled    : ON/OFF（既定 false）
--   dueReminderHour       : 送信時刻（0-23・JST／既定 9）
--   dueReminderUserId     : 通知先の管理者(User.id)。NULL=最高管理者へ
--   dueReminderLastSentOn : 二重送信防止（最後に送った日・JST）
-- すべて追加列のみ。IF NOT EXISTS 付き（冪等）＝手動適用済みでも後日の migrate deploy が安全。
ALTER TABLE "InvoiceSetting" ADD COLUMN IF NOT EXISTS "dueReminderEnabled"    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "InvoiceSetting" ADD COLUMN IF NOT EXISTS "dueReminderHour"       INTEGER NOT NULL DEFAULT 9;
ALTER TABLE "InvoiceSetting" ADD COLUMN IF NOT EXISTS "dueReminderUserId"     TEXT;
ALTER TABLE "InvoiceSetting" ADD COLUMN IF NOT EXISTS "dueReminderLastSentOn" DATE;

-- 出面の LINE 通知を「グループ投稿」から「管理者への個別送信」に切り替える。
--   User.notifyReports                 : 出面の通知を受け取るか（管理者ごと・既定 ON）
--   User.lineFriend                    : 公式アカウントの友だち状態（NULL=不明）
--   InvoiceSetting.notifySelfRoles     : 自社の出面の通知先ロール
--   InvoiceSetting.notifyPartnerRoles  : 協力会社の出面の通知先ロール
--   Report."postedToGroup" は列名そのまま「通知済み」の意味で使う（Prisma 上は notified）。
-- 追加列は IF NOT EXISTS 付き（冪等）。
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "notifyReports" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lineFriend" BOOLEAN;
ALTER TABLE "InvoiceSetting" ADD COLUMN IF NOT EXISTS "notifySelfRoles" "Role"[] DEFAULT ARRAY['ADMIN', 'SELF_ADMIN', 'ORG_ADMIN']::"Role"[];
ALTER TABLE "InvoiceSetting" ADD COLUMN IF NOT EXISTS "notifyPartnerRoles" "Role"[] DEFAULT ARRAY['ADMIN']::"Role"[];

-- 協力会社の出面はこれまで通知の対象外（グループ非投稿）だったため、既存分は通知済み扱いにして
-- 管理ホームの「未通知」警告に大量に出ないようにする。
UPDATE "Report" SET "postedToGroup" = true WHERE "source" = 'PARTNER' AND "postedToGroup" = false;

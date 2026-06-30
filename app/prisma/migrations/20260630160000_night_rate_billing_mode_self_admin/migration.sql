-- 夜勤単価 / 請求方式(集約・現場ごと) / 自社管理者ロール を追加（追加のみ・非破壊）。

-- ① 夜勤単価（取引先・円/人工）。NULL=未設定なら日勤単価を流用。
ALTER TABLE "Client" ADD COLUMN "nightUnitPrice" INTEGER;

-- ③ 請求方式（取引先ごと）。既定は集約（AGGREGATE）。
DO $$ BEGIN
  CREATE TYPE "BillingMode" AS ENUM ('AGGREGATE', 'PER_SITE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
ALTER TABLE "Client" ADD COLUMN "billingMode" "BillingMode" NOT NULL DEFAULT 'AGGREGATE';

-- ② 自社管理者ロール（自社=SELF のデータのみ閲覧）。
--    enum 値の追加は ADD VALUE IF NOT EXISTS（トランザクション外で実行）。
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SELF_ADMIN';

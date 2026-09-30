-- 粗利（会社に残るお金）の設定と、その他経費（月ごとの手入力）を追加。
--   InvoiceSetting.profitShareName : 取り分を渡す相手の表示名（既定「大和」）
--   InvoiceSetting.profitShareRate : 取り分の率（既定 0.2 = 20%）
--   InvoiceSetting.profitViewRoles : ADMIN 以外で粗利を見られるロール（既定なし）
--   OtherExpense                   : 出面にひも付かない会社の経費（yearMonth ごと）
-- すべて追加のみ。IF NOT EXISTS 付き（冪等）＝手動適用済みでも後日の migrate deploy が安全。
ALTER TABLE "InvoiceSetting" ADD COLUMN IF NOT EXISTS "profitShareName" TEXT NOT NULL DEFAULT '大和';
ALTER TABLE "InvoiceSetting" ADD COLUMN IF NOT EXISTS "profitShareRate" DOUBLE PRECISION NOT NULL DEFAULT 0.2;
ALTER TABLE "InvoiceSetting" ADD COLUMN IF NOT EXISTS "profitViewRoles" "Role"[] DEFAULT ARRAY[]::"Role"[];

CREATE TABLE IF NOT EXISTS "OtherExpense" (
    "id" TEXT NOT NULL,
    "yearMonth" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtherExpense_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OtherExpense_yearMonth_idx" ON "OtherExpense"("yearMonth");

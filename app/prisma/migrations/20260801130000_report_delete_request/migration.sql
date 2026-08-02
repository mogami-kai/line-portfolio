-- 出面の削除申請（LIFF マイページ → 管理者が承認/却下）
ALTER TABLE "Report" ADD COLUMN "deleteRequestedAt" TIMESTAMP(3);
ALTER TABLE "Report" ADD COLUMN "deleteRequestedBy" TEXT;

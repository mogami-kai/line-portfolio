-- UX再設計: 現場(Site)の内部管理属性 と 利用者(User)の在籍状態 を追加
-- すべて ADD COLUMN ... DEFAULT / NULL許容 のため既存行は安全に埋まる（本番無停止）。

-- User の在籍状態（拒否/無効化用）。承認(approved)とは独立。
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');
ALTER TABLE "User" ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE';
CREATE INDEX "User_approved_idx" ON "User"("approved");

-- Site の内部管理属性（請求書には出さない）。
ALTER TABLE "Site" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Site" ADD COLUMN "isPinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Site" ADD COLUMN "isTemporary" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Site" ADD COLUMN "usageCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Site" ADD COLUMN "lastUsedAt" TIMESTAMP(3);
CREATE INDEX "Site_clientId_isActive_idx" ON "Site"("clientId", "isActive");

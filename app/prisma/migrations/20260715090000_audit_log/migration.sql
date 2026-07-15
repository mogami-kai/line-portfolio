-- 操作履歴（監査ログ）: フォーム入力と管理者のデータ加工を記録。
-- Supabase SQL Editor で実行してください（再実行しても安全）。
CREATE TABLE IF NOT EXISTS "AuditLog" (
  "id" TEXT PRIMARY KEY,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actorId" TEXT,
  "actorName" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "reportId" TEXT,
  "summary" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "AuditLog_at_idx" ON "AuditLog"("at");
CREATE INDEX IF NOT EXISTS "AuditLog_reportId_idx" ON "AuditLog"("reportId");

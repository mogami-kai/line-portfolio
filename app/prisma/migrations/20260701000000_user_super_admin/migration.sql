-- 👑最高管理者フラグ。降格/無効化/削除されず、他の管理者を降格できる（最上1名想定）。
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "superAdmin" BOOLEAN NOT NULL DEFAULT false;

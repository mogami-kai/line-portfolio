-- 自社管理者ロール(SELF_ADMIN)を Role enum に追加。
--   PostgreSQL は ALTER TYPE ... ADD VALUE を他DDLと同一トランザクションで
--   実行できないため、この値追加だけを単独マイグレーションに分離している。
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SELF_ADMIN';

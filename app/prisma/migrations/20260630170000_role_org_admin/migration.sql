-- 組織管理者ロール(ORG_ADMIN)を Role enum に追加。
--   付与時に対象組織（自社 or 特定の協力会社）を選び、その組織のデータのみ閲覧できる。
--   PostgreSQL の制約により ADD VALUE は単独マイグレーションで実行する。
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ORG_ADMIN';

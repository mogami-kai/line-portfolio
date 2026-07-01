-- 立替集計: 立替えた人の名前を保持（追加のみ・NULL 許容＝既存行/旧コードに影響なし）。
ALTER TABLE "Expense" ADD COLUMN "paidBy" TEXT;

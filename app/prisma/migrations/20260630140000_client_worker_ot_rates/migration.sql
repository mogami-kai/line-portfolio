-- 集計画面から単価設定: 取引先の残業単価・職人の人工/残業単価を追加（追加のみ・NULL許容＝非破壊）。
ALTER TABLE "Client" ADD COLUMN "otUnitPrice" INTEGER;
ALTER TABLE "Worker" ADD COLUMN "unitPrice" INTEGER;
ALTER TABLE "Worker" ADD COLUMN "otUnitPrice" INTEGER;

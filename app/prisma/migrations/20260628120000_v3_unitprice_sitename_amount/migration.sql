-- v3: 追加のみ（過去分維持・破壊的変更なし）
--   Client.unitPrice    : 常用の人工単価（取引先で設定）
--   Report.siteName     : 現場の自由入力名（siteId に依存しない）
--   Report.contractAmount: 請負(UKEOI)の契約金額（請求は「○月委託料 数量1」）
-- いずれも NULL 許容のため、既存行・旧コードに影響しない。

ALTER TABLE "Client" ADD COLUMN "unitPrice" INTEGER;
ALTER TABLE "Report" ADD COLUMN "siteName" TEXT;
ALTER TABLE "Report" ADD COLUMN "contractAmount" INTEGER;

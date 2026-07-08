-- ============================================================
-- 「未投稿（再投稿）」急増の診断SQL（Supabase SQL Editor で実行・読み取りのみ）
--   未投稿 = postedToGroup=false の自社(SELF)出面（管理ホームのアラート対象）。
--   どこ由来で増えているかを切り分ける。
-- ============================================================

-- 1) 未投稿の件数を「月 × 由来」で分類
--    origin:
--      seed   = 過去データの手動取り込み（clientRequestId が 'seed-' 始まり）
--      liff   = LIFF からの通常送信（それ以外）
SELECT
  to_char(r."workDate", 'YYYY-MM')                            AS month,
  CASE WHEN r."clientRequestId" LIKE 'seed-%' THEN 'seed(取り込み)'
       ELSE 'liff(通常送信)' END                               AS origin,
  count(*)                                                    AS unposted
FROM "Report" r
JOIN "Organization" o ON o.id = r."orgId"
WHERE o.kind = 'SELF' AND r."postedToGroup" = false
GROUP BY 1, 2
ORDER BY 1, 2;

-- 2) 直近の未投稿20件（いつ作られたか＝実際の送信失敗かを見る）
--    createdAt が最近＝いま LINE 投稿が失敗している（環境変数/トークン/上限の問題）。
--    createdAt が古い/seed＝過去データが表示されているだけ（実害なし）。
SELECT r."workDate", r."siteName", r."createdAt", r."clientRequestId",
       r.status
FROM "Report" r
JOIN "Organization" o ON o.id = r."orgId"
WHERE o.kind = 'SELF' AND r."postedToGroup" = false
ORDER BY r."createdAt" DESC
LIMIT 20;

-- ============================================================
-- （結果を見てから実行する修正）
--
-- A) 未投稿の大半が「seed(取り込み)」や6月分だった場合:
--    過去データは投稿済み扱いにしてアラートから外す（LINEには何も送りません）。
--
-- UPDATE "Report" r SET "postedToGroup" = true
-- FROM "Organization" o
-- WHERE o.id = r."orgId" AND o.kind = 'SELF'
--   AND r."postedToGroup" = false
--   AND r."workDate" < DATE '2026-07-01';   -- 7月より前（過去分）だけ
--
-- B) 「liff(通常送信)」で最近の createdAt が並んでいる場合:
--    いま実際に LINE 投稿が失敗しています。Vercel の環境変数
--    LINE_CHANNEL_ACCESS_TOKEN / LINE_GROUP_ID と、LINE公式アカウントの
--    無料メッセージ通数（月200通・超過で429エラー）を確認してください。
-- ============================================================

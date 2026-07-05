-- ============================================================
-- 2026年6月 出面データ取り込み（辻濱興業・自社SELF・置き換え）
--   Supabase SQL Editor に貼り付けて実行してください。
--   ・取引先 = 辻濱興業（全件）
--   ・区分 昼=DAY / 夜勤=NIGHT、常用(JOYO)、CONFIRMED、postedToGroup=true(履歴)
--   ・立替(備考)は各出面に紐づけて登録（駐車場/ガソリン）
--   ・既存の6月 自社出面＋6月の立替は全削除してから入れ直します
-- ============================================================

-- 0) 事前チェック（先にこれだけ実行して、6人の職人と取引先が解決するか確認推奨）
--    ↓ 6行（齋/石渡/久保/山口/後藤/金子）と client 1行が返ればOK。
-- SELECT name, id FROM "Worker"
--   WHERE "orgId" = (SELECT id FROM "Organization" WHERE kind='SELF' ORDER BY "createdAt" LIMIT 1)
--     AND (name IN ('齋', '石渡', '久保', '山口', '後藤', '金子') OR '齋' = ANY(aliases) OR '石渡' = ANY(aliases) OR '久保' = ANY(aliases) OR '山口' = ANY(aliases) OR '後藤' = ANY(aliases) OR '金子' = ANY(aliases));
-- SELECT id, name FROM "Client" WHERE name = '辻濱興業';

BEGIN;

-- gen_random_uuid() 用（Supabase は既定で有効。無ければ有効化）。
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) 既存の6月データを削除（置き換え）
--    立替（自社ぶん：単体 or 自社出面に紐づくもの）を先に削除。
DELETE FROM "Expense" e
 WHERE e."workDate" >= DATE '2026-06-01' AND e."workDate" < DATE '2026-07-01'
   AND (
     e."reportId" IS NULL
     OR e."reportId" IN (
       SELECT r.id FROM "Report" r
        JOIN "Organization" o ON o.id = r."orgId"
       WHERE o.kind = 'SELF'
         AND r."workDate" >= DATE '2026-06-01' AND r."workDate" < DATE '2026-07-01'
     )
   );

--    自社の6月出面を削除（ReportEntry は onDelete: Cascade で自動削除）。
DELETE FROM "Report" r
 USING "Organization" o
 WHERE o.id = r."orgId" AND o.kind = 'SELF'
   AND r."workDate" >= DATE '2026-06-01' AND r."workDate" < DATE '2026-07-01';

-- 2) 取り込み（Report → ReportEntry → Expense を1文で連鎖）
WITH ctx AS (
  SELECT
    (SELECT id FROM "Organization" WHERE kind = 'SELF' ORDER BY "createdAt" ASC LIMIT 1) AS org_id,
    (SELECT id FROM "Client" WHERE name = '辻濱興業' LIMIT 1) AS client_id,
    (SELECT id FROM "User" WHERE role = 'ADMIN' ORDER BY "createdAt" ASC LIMIT 1) AS user_id
),
rep(rk, wd, site) AS (
  VALUES
  ('seed-202606-001', DATE '2026-06-01', '北仲通北地区'),
  ('seed-202606-002', DATE '2026-06-02', 'さがみ野→茅ヶ崎→横浜'),
  ('seed-202606-003', DATE '2026-06-02', 'マノー新江古田'),
  ('seed-202606-004', DATE '2026-06-02', '北仲通北地区'),
  ('seed-202606-005', DATE '2026-06-02', '平塚レオパレス'),
  ('seed-202606-006', DATE '2026-06-03', 'さがみ野'),
  ('seed-202606-007', DATE '2026-06-04', '池袋'),
  ('seed-202606-008', DATE '2026-06-04', '鵠沼→蒔田'),
  ('seed-202606-009', DATE '2026-06-05', 'さがみ野'),
  ('seed-202606-010', DATE '2026-06-05', 'みなとみらい'),
  ('seed-202606-011', DATE '2026-06-06', 'みなとみらい'),
  ('seed-202606-012', DATE '2026-06-08', 'さがみ野'),
  ('seed-202606-013', DATE '2026-06-08', 'みなとみらい'),
  ('seed-202606-014', DATE '2026-06-09', 'さがみ野'),
  ('seed-202606-015', DATE '2026-06-09', 'みなとみらい'),
  ('seed-202606-016', DATE '2026-06-10', 'みなとみらい'),
  ('seed-202606-017', DATE '2026-06-10', '橋本'),
  ('seed-202606-018', DATE '2026-06-10', '浦安'),
  ('seed-202606-019', DATE '2026-06-11', 'みなとみらい'),
  ('seed-202606-020', DATE '2026-06-11', '橋本'),
  ('seed-202606-021', DATE '2026-06-12', 'みなとみらい'),
  ('seed-202606-022', DATE '2026-06-12', '新大久保'),
  ('seed-202606-023', DATE '2026-06-12', '橋本'),
  ('seed-202606-024', DATE '2026-06-13', 'みなとみらい'),
  ('seed-202606-025', DATE '2026-06-13', '東芝'),
  ('seed-202606-026', DATE '2026-06-13', '横浜キング'),
  ('seed-202606-027', DATE '2026-06-13', '橋本'),
  ('seed-202606-028', DATE '2026-06-15', '横浜'),
  ('seed-202606-029', DATE '2026-06-15', '蒲田'),
  ('seed-202606-030', DATE '2026-06-16', 'みなとみらい'),
  ('seed-202606-031', DATE '2026-06-16', '芹が谷'),
  ('seed-202606-032', DATE '2026-06-17', 'みなとみらい'),
  ('seed-202606-033', DATE '2026-06-17', '町田'),
  ('seed-202606-034', DATE '2026-06-18', 'みなとみらい'),
  ('seed-202606-035', DATE '2026-06-18', 'ディズニーランド'),
  ('seed-202606-036', DATE '2026-06-18', '町田'),
  ('seed-202606-037', DATE '2026-06-19', 'みなとみらい'),
  ('seed-202606-038', DATE '2026-06-19', '町田'),
  ('seed-202606-039', DATE '2026-06-20', '金沢文庫'),
  ('seed-202606-040', DATE '2026-06-22', 'みなとみらい'),
  ('seed-202606-041', DATE '2026-06-22', '武蔵小杉'),
  ('seed-202606-042', DATE '2026-06-23', '武蔵小杉'),
  ('seed-202606-043', DATE '2026-06-24', 'みなとみらい'),
  ('seed-202606-044', DATE '2026-06-24', '武蔵小杉'),
  ('seed-202606-045', DATE '2026-06-25', 'みなとみらい'),
  ('seed-202606-046', DATE '2026-06-25', '横浜'),
  ('seed-202606-047', DATE '2026-06-25', '青葉台小学校'),
  ('seed-202606-048', DATE '2026-06-26', 'みなとみらい'),
  ('seed-202606-049', DATE '2026-06-26', '武蔵小杉'),
  ('seed-202606-050', DATE '2026-06-27', '東芝'),
  ('seed-202606-051', DATE '2026-06-27', '青葉台小学校'),
  ('seed-202606-052', DATE '2026-06-29', 'みなとみらい'),
  ('seed-202606-053', DATE '2026-06-29', '綱島'),
  ('seed-202606-054', DATE '2026-06-30', '武蔵小杉'),
  ('seed-202606-055', DATE '2026-06-30', '蒲田')
),
ins_rep AS (
  INSERT INTO "Report"
    (id, "workDate", "clientId", "siteId", "siteName", "contractType", "contractAmount",
     source, "orgId", "createdById", status, "postedToGroup", "clientRequestId", "createdAt")
  SELECT gen_random_uuid()::text, rep.wd, ctx.client_id, NULL, rep.site,
         'JOYO'::"ContractType", NULL, 'SELF'::"OrgKind", ctx.org_id, ctx.user_id,
         'CONFIRMED'::"ReportStatus", true, rep.rk, now()
  FROM rep CROSS JOIN ctx
  RETURNING id, "clientRequestId" AS rk, "workDate" AS wd, "clientId" AS client_id
),
ent(rk, wname, shift, md, ot) AS (
  VALUES
  ('seed-202606-001', '齋', 'DAY', 1, 0),
  ('seed-202606-001', '石渡', 'DAY', 1, 0),
  ('seed-202606-001', '久保', 'DAY', 1, 0),
  ('seed-202606-002', '久保', 'DAY', 1, 0),
  ('seed-202606-003', '山口', 'DAY', 1, 0),
  ('seed-202606-004', '齋', 'DAY', 1, 0),
  ('seed-202606-005', '後藤', 'DAY', 1, 0),
  ('seed-202606-005', '金子', 'DAY', 1, 0),
  ('seed-202606-006', '後藤', 'DAY', 1, 0),
  ('seed-202606-006', '久保', 'DAY', 1, 0),
  ('seed-202606-007', '山口', 'NIGHT', 1, 0),
  ('seed-202606-008', '金子', 'DAY', 1, 0),
  ('seed-202606-009', '久保', 'DAY', 1, 0),
  ('seed-202606-009', '石渡', 'DAY', 1, 0),
  ('seed-202606-009', '山口', 'DAY', 1, 0),
  ('seed-202606-010', '後藤', 'DAY', 1, 0),
  ('seed-202606-010', '金子', 'DAY', 1, 0),
  ('seed-202606-011', '石渡', 'DAY', 1, 0),
  ('seed-202606-011', '金子', 'DAY', 1, 0),
  ('seed-202606-012', '齋', 'DAY', 1, 0),
  ('seed-202606-012', '後藤', 'DAY', 1, 0),
  ('seed-202606-012', '山口', 'DAY', 1, 0),
  ('seed-202606-013', '金子', 'DAY', 1, 0),
  ('seed-202606-013', '石渡', 'DAY', 1, 0),
  ('seed-202606-014', '後藤', 'DAY', 1, 0),
  ('seed-202606-014', '山口', 'DAY', 1, 0),
  ('seed-202606-015', '久保', 'DAY', 1, 0),
  ('seed-202606-015', '金子', 'DAY', 1, 0),
  ('seed-202606-016', '久保', 'DAY', 1, 0),
  ('seed-202606-016', '金子', 'DAY', 1, 0),
  ('seed-202606-017', '後藤', 'DAY', 1, 0),
  ('seed-202606-017', '齋', 'DAY', 1, 0),
  ('seed-202606-017', '石渡', 'DAY', 1, 0),
  ('seed-202606-018', '山口', 'DAY', 1, 0),
  ('seed-202606-019', '久保', 'DAY', 1, 0),
  ('seed-202606-019', '金子', 'DAY', 1, 0),
  ('seed-202606-020', '齋', 'DAY', 1, 0),
  ('seed-202606-020', '後藤', 'DAY', 1, 0),
  ('seed-202606-020', '山口', 'DAY', 1, 0),
  ('seed-202606-020', '石渡', 'DAY', 1, 0),
  ('seed-202606-021', '久保', 'DAY', 1, 0),
  ('seed-202606-021', '金子', 'DAY', 1, 0),
  ('seed-202606-022', '後藤', 'DAY', 1, 0),
  ('seed-202606-022', '山口', 'DAY', 1, 0),
  ('seed-202606-023', '齋', 'DAY', 1, 0.5),
  ('seed-202606-023', '石渡', 'DAY', 1, 0.5),
  ('seed-202606-024', '金子', 'DAY', 1, 0),
  ('seed-202606-025', '後藤', 'DAY', 1, 0),
  ('seed-202606-025', '山口', 'DAY', 1, 0),
  ('seed-202606-026', '後藤', 'NIGHT', 1, 0),
  ('seed-202606-026', '石渡', 'NIGHT', 1, 0),
  ('seed-202606-027', '齋', 'DAY', 1, 0),
  ('seed-202606-027', '石渡', 'DAY', 1, 0),
  ('seed-202606-028', '後藤', 'NIGHT', 1, 0),
  ('seed-202606-028', '石渡', 'NIGHT', 1, 0),
  ('seed-202606-028', '山口', 'NIGHT', 1, 0),
  ('seed-202606-029', '齋', 'DAY', 1, 0),
  ('seed-202606-029', '石渡', 'DAY', 1, 0),
  ('seed-202606-030', '石渡', 'DAY', 1, 0),
  ('seed-202606-031', '齋', 'DAY', 1, 0),
  ('seed-202606-031', '山口', 'DAY', 1, 0),
  ('seed-202606-032', '金子', 'DAY', 1, 0),
  ('seed-202606-032', '久保', 'DAY', 1, 0),
  ('seed-202606-033', '齋', 'DAY', 1, 0),
  ('seed-202606-033', '山口', 'DAY', 1, 0),
  ('seed-202606-033', '石渡', 'DAY', 1, 0),
  ('seed-202606-034', '金子', 'DAY', 1, 0),
  ('seed-202606-034', '久保', 'DAY', 1, 0),
  ('seed-202606-035', '石渡', 'NIGHT', 1, 0),
  ('seed-202606-035', '山口', 'NIGHT', 1, 0),
  ('seed-202606-036', '齋', 'DAY', 1, 0),
  ('seed-202606-036', '山口', 'DAY', 1, 0),
  ('seed-202606-036', '石渡', 'DAY', 1, 0),
  ('seed-202606-037', '金子', 'DAY', 1, 0),
  ('seed-202606-037', '後藤', 'DAY', 1, 0),
  ('seed-202606-038', '齋', 'DAY', 1, 0),
  ('seed-202606-038', '久保', 'DAY', 1, 0),
  ('seed-202606-038', '石渡', 'DAY', 1, 0),
  ('seed-202606-039', '齋', 'DAY', 1, 0),
  ('seed-202606-039', '金子', 'DAY', 1, 0),
  ('seed-202606-040', '久保', 'DAY', 1, 0),
  ('seed-202606-040', '金子', 'DAY', 1, 0),
  ('seed-202606-041', '齋', 'DAY', 1, 0),
  ('seed-202606-041', '石渡', 'DAY', 1, 0),
  ('seed-202606-041', '山口', 'DAY', 1, 0),
  ('seed-202606-042', '齋', 'DAY', 1, 0),
  ('seed-202606-042', '石渡', 'DAY', 1, 0),
  ('seed-202606-042', '山口', 'DAY', 1, 0),
  ('seed-202606-043', '金子', 'DAY', 1, 0),
  ('seed-202606-043', '齋', 'DAY', 1, 0),
  ('seed-202606-044', '石渡', 'DAY', 1, 0),
  ('seed-202606-044', '山口', 'DAY', 1, 0),
  ('seed-202606-045', '金子', 'DAY', 1, 0),
  ('seed-202606-045', '齋', 'DAY', 1, 0),
  ('seed-202606-046', '後藤', 'NIGHT', 1, 0),
  ('seed-202606-046', '金子', 'NIGHT', 1, 0),
  ('seed-202606-047', '石渡', 'DAY', 1, 0),
  ('seed-202606-047', '山口', 'DAY', 1, 0),
  ('seed-202606-048', '金子', 'DAY', 1, 0),
  ('seed-202606-048', '齋', 'DAY', 1, 0),
  ('seed-202606-049', '石渡', 'DAY', 1, 0),
  ('seed-202606-049', '山口', 'DAY', 1, 0),
  ('seed-202606-050', '齋', 'DAY', 1, 0),
  ('seed-202606-050', '金子', 'DAY', 1, 0),
  ('seed-202606-051', '石渡', 'DAY', 1, 0),
  ('seed-202606-051', '山口', 'DAY', 1, 0),
  ('seed-202606-052', '石渡', 'DAY', 1, 0),
  ('seed-202606-053', '齋', 'DAY', 1, 0),
  ('seed-202606-053', '山口', 'DAY', 1, 0),
  ('seed-202606-054', '金子', 'DAY', 1, 0),
  ('seed-202606-054', '山口', 'DAY', 1, 0),
  ('seed-202606-055', '久保', 'DAY', 1, 0),
  ('seed-202606-055', '石渡', 'DAY', 1, 0)
),
ins_ent AS (
  INSERT INTO "ReportEntry" (id, "reportId", "workerId", shift, "manDays", "otHours")
  SELECT gen_random_uuid()::text, ir.id, w.id, ent.shift::"Shift", ent.md, ent.ot
  FROM ent
  JOIN ins_rep ir ON ir.rk = ent.rk
  JOIN ctx ON true
  JOIN "Worker" w
    ON w."orgId" = ctx.org_id
   AND (w.name = ent.wname OR ent.wname = ANY(w.aliases))
  RETURNING 1
),
exp(rk, kind, amount, paidby) AS (
  VALUES
  ('seed-202606-003', '駐車場', 1200, '山口'),
  ('seed-202606-003', 'ガソリン', 3000, '山口'),
  ('seed-202606-004', '駐車場', 2000, '齋'),
  ('seed-202606-006', 'ガソリン', 4837, NULL),
  ('seed-202606-017', '駐車場', 800, NULL),
  ('seed-202606-020', '駐車場', 800, NULL),
  ('seed-202606-022', '駐車場', 2000, NULL),
  ('seed-202606-023', '駐車場', 800, NULL),
  ('seed-202606-026', '駐車場', 500, NULL),
  ('seed-202606-027', '駐車場', 800, NULL),
  ('seed-202606-030', '駐車場', 2000, '石渡'),
  ('seed-202606-030', 'ガソリン', 1000, '石渡'),
  ('seed-202606-033', '駐車場', 500, NULL),
  ('seed-202606-036', '駐車場', 500, NULL),
  ('seed-202606-038', '駐車場', 500, NULL),
  ('seed-202606-041', '駐車場', 1540, NULL),
  ('seed-202606-042', '駐車場', 1500, NULL),
  ('seed-202606-044', '駐車場', 1400, NULL),
  ('seed-202606-049', '駐車場', 1400, NULL)
)
INSERT INTO "Expense" (id, "workDate", "clientId", "siteId", kind, amount, billable, "paidBy", "reportId")
SELECT gen_random_uuid()::text, ir.wd, ir.client_id, NULL, exp.kind, exp.amount, true, exp.paidby, ir.id
FROM exp
JOIN ins_rep ir ON ir.rk = exp.rk;

-- 3) 検算（コミット前に件数を確認）
--   出面 55 件 / 明細 113 件 / 立替 19 件 になるはず。
SELECT
  (SELECT count(*) FROM "Report" r JOIN "Organization" o ON o.id=r."orgId"
     WHERE o.kind='SELF' AND r."workDate">=DATE '2026-06-01' AND r."workDate"<DATE '2026-07-01') AS reports,
  (SELECT count(*) FROM "ReportEntry" e JOIN "Report" r ON r.id=e."reportId"
     WHERE r."workDate">=DATE '2026-06-01' AND r."workDate"<DATE '2026-07-01') AS entries,
  (SELECT count(*) FROM "Expense"
     WHERE "workDate">=DATE '2026-06-01' AND "workDate"<DATE '2026-07-01') AS expenses;

-- 件数が想定どおりなら COMMIT、違っていれば ROLLBACK。
COMMIT;
-- ROLLBACK;


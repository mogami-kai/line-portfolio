-- ============================================================
-- 自社（SELF 組織）の重複を統合し、今後1件しか作れないよう制約を張る。
--
--   背景: ensureSelfOrg() が findFirst→create だったため、初回ログインが
--         ほぼ同時に走ると競合で SELF 組織が2件作られることがあった。
--   方針: ① 最古の SELF を「残す自社」とし、他の SELF に紐づく参照
--            （User / Worker / Report）を残す自社へ付け替えてから重複を削除。
--         ② 「SELF は1件まで」を部分ユニークインデックスで構造的に保証。
--   いずれも冪等（SELF が1件以下なら①は0件処理、②は IF NOT EXISTS）。
--   Report.source は orgId と独立（SELF/PARTNER の種別）なので変更不要。
-- ============================================================

-- ① 参照の付け替え（残す自社 = 最古、createdAt 昇順・id 昇順で一意化）。
UPDATE "User"
SET "orgId" = (
  SELECT id FROM "Organization"
  WHERE "kind" = 'SELF'
  ORDER BY "createdAt" ASC, "id" ASC
  LIMIT 1
)
WHERE "orgId" IN (
  SELECT id FROM "Organization"
  WHERE "kind" = 'SELF'
    AND id <> (
      SELECT id FROM "Organization"
      WHERE "kind" = 'SELF'
      ORDER BY "createdAt" ASC, "id" ASC
      LIMIT 1
    )
);

UPDATE "Worker"
SET "orgId" = (
  SELECT id FROM "Organization"
  WHERE "kind" = 'SELF'
  ORDER BY "createdAt" ASC, "id" ASC
  LIMIT 1
)
WHERE "orgId" IN (
  SELECT id FROM "Organization"
  WHERE "kind" = 'SELF'
    AND id <> (
      SELECT id FROM "Organization"
      WHERE "kind" = 'SELF'
      ORDER BY "createdAt" ASC, "id" ASC
      LIMIT 1
    )
);

UPDATE "Report"
SET "orgId" = (
  SELECT id FROM "Organization"
  WHERE "kind" = 'SELF'
  ORDER BY "createdAt" ASC, "id" ASC
  LIMIT 1
)
WHERE "orgId" IN (
  SELECT id FROM "Organization"
  WHERE "kind" = 'SELF'
    AND id <> (
      SELECT id FROM "Organization"
      WHERE "kind" = 'SELF'
      ORDER BY "createdAt" ASC, "id" ASC
      LIMIT 1
    )
);

-- ② 参照を失った重複自社（最古以外の SELF）を削除。
DELETE FROM "Organization"
WHERE "kind" = 'SELF'
  AND id <> (
    SELECT id FROM "Organization"
    WHERE "kind" = 'SELF'
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT 1
  );

-- ③ 再発防止: SELF は常に1件まで（部分ユニークインデックス）。
--    これ以降、2件目の SELF を作ろうとすると DB が拒否する。
CREATE UNIQUE INDEX IF NOT EXISTS "Organization_one_self_idx"
  ON "Organization" ("kind")
  WHERE "kind" = 'SELF';

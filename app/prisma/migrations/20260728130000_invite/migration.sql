-- 招待リンク（Invite）。管理者が発行した URL を踏んだ本人に role/org を自動付与する。
CREATE TABLE IF NOT EXISTS "Invite" (
    "id"            TEXT NOT NULL,
    "token"         TEXT NOT NULL,
    "role"          "Role" NOT NULL,
    "orgId"         TEXT,
    "label"         TEXT,
    "expiresAt"     TIMESTAMP(3) NOT NULL,
    "maxUses"       INTEGER NOT NULL DEFAULT 1,
    "usedCount"     INTEGER NOT NULL DEFAULT 0,
    "revokedAt"     TIMESTAMP(3),
    "createdById"   TEXT,
    "createdByName" TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt"    TIMESTAMP(3),
    "lastUsedName"  TEXT,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Invite_token_key" ON "Invite"("token");
CREATE INDEX IF NOT EXISTS "Invite_expiresAt_idx" ON "Invite"("expiresAt");
CREATE INDEX IF NOT EXISTS "Invite_orgId_idx" ON "Invite"("orgId");

ALTER TABLE "Invite"
    ADD CONSTRAINT "Invite_orgId_fkey" FOREIGN KEY ("orgId")
    REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

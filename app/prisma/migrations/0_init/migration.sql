-- 出面管理 → 集計 → 請求書 / 初期スキーマ
CREATE TYPE "OrgKind" AS ENUM ('SELF', 'PARTNER');
CREATE TYPE "Role" AS ENUM ('ADMIN', 'OWNER', 'VIEWER', 'PARTNER');
CREATE TYPE "ContractType" AS ENUM ('JOYO', 'UKEOI');
CREATE TYPE "LumpStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "Shift" AS ENUM ('DAY', 'HALF', 'NIGHT');
CREATE TYPE "ReportStatus" AS ENUM ('CONFIRMED', 'NEEDS_REVIEW');
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PAID');

CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "OrgKind" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "lineUserId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'PARTNER',
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "orgId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Worker" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "orgId" TEXT NOT NULL,
    CONSTRAINT "Worker_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "honorific" TEXT NOT NULL DEFAULT '御中',
    "address" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "RateCard" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "siteId" TEXT,
    "contractType" "ContractType" NOT NULL DEFAULT 'JOYO',
    "unitPrice" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RateCard_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "LumpContract" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "yearMonth" TEXT NOT NULL,
    "status" "LumpStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LumpContract_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "clientId" TEXT NOT NULL,
    "siteId" TEXT,
    "contractType" "ContractType" NOT NULL DEFAULT 'JOYO',
    "source" "OrgKind" NOT NULL,
    "orgId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'CONFIRMED',
    "postedToGroup" BOOLEAN NOT NULL DEFAULT false,
    "clientRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ReportEntry" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "shift" "Shift" NOT NULL DEFAULT 'DAY',
    "manDays" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "otHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    CONSTRAINT "ReportEntry_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "clientId" TEXT,
    "siteId" TEXT,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "reportId" TEXT,
    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "InvoiceSetting" (
    "id" TEXT NOT NULL,
    "issuerName" TEXT NOT NULL,
    "address" TEXT,
    "tel" TEXT,
    "email" TEXT,
    "regNumber" TEXT,
    "bankInfo" TEXT,
    "taxRate" DOUBLE PRECISION NOT NULL DEFAULT 0.10,
    "contactName" TEXT,
    CONSTRAINT "InvoiceSetting_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "yearMonth" TEXT NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "issueDate" DATE NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "InvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "sortNo" INTEGER NOT NULL,
    "itemName" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "unitLabel" TEXT NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "taxRate" DOUBLE PRECISION NOT NULL,
    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Organization_kind_idx" ON "Organization"("kind");
CREATE UNIQUE INDEX "User_lineUserId_key" ON "User"("lineUserId");
CREATE INDEX "User_orgId_idx" ON "User"("orgId");
CREATE INDEX "Worker_orgId_idx" ON "Worker"("orgId");
CREATE INDEX "Site_clientId_idx" ON "Site"("clientId");
CREATE INDEX "RateCard_clientId_siteId_contractType_idx" ON "RateCard"("clientId", "siteId", "contractType");
CREATE INDEX "LumpContract_clientId_yearMonth_idx" ON "LumpContract"("clientId", "yearMonth");
CREATE INDEX "LumpContract_yearMonth_idx" ON "LumpContract"("yearMonth");
CREATE UNIQUE INDEX "Report_clientRequestId_key" ON "Report"("clientRequestId");
CREATE INDEX "Report_orgId_workDate_idx" ON "Report"("orgId", "workDate");
CREATE INDEX "Report_clientId_workDate_idx" ON "Report"("clientId", "workDate");
CREATE INDEX "ReportEntry_reportId_idx" ON "ReportEntry"("reportId");
CREATE INDEX "Expense_clientId_workDate_idx" ON "Expense"("clientId", "workDate");
CREATE UNIQUE INDEX "Invoice_invoiceNo_key" ON "Invoice"("invoiceNo");
CREATE INDEX "Invoice_yearMonth_idx" ON "Invoice"("yearMonth");
CREATE UNIQUE INDEX "Invoice_clientId_yearMonth_key" ON "Invoice"("clientId", "yearMonth");
CREATE INDEX "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");

ALTER TABLE "User" ADD CONSTRAINT "User_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Site" ADD CONSTRAINT "Site_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RateCard" ADD CONSTRAINT "RateCard_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RateCard" ADD CONSTRAINT "RateCard_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LumpContract" ADD CONSTRAINT "LumpContract_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Report" ADD CONSTRAINT "Report_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Report" ADD CONSTRAINT "Report_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Report" ADD CONSTRAINT "Report_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReportEntry" ADD CONSTRAINT "ReportEntry_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReportEntry" ADD CONSTRAINT "ReportEntry_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

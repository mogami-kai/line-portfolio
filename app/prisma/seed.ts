// ============================================================
// Prisma seed — 初期データ（すべてダミー）
//
//   - Organization: 自社（kind=SELF）
//   - User: 管理者（ADMIN_LINE_USER_IDS の先頭 → role=ADMIN / approved）
//   - Worker: ダミー職人 ×2（自社 org）
//   - Client + Site + RateCard: ダミー取引先 ×2（現場・既定単価）
//   - InvoiceSetting: ダミー発行元（実名・住所・口座は入れない）
//
//   実行: `tsx prisma/seed.ts`（package.json に prisma.seed を追記後 `prisma db seed`）。
//   ※ 実名・住所・口座・個人名はここに書かない（DB 投入は管理画面 or 手動で）。
// ============================================================

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // ── 自社組織（SELF）──
  const self =
    (await prisma.organization.findFirst({ where: { kind: "SELF" } })) ??
    (await prisma.organization.create({
      data: { name: "自社（ダミー）", kind: "SELF" },
    }));

  // ── 管理者（ADMIN_LINE_USER_IDS の先頭を採用。未設定なら placeholder）──
  const adminId =
    (process.env.ADMIN_LINE_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)[0] || "U00000000000000000000000000000000";

  await prisma.user.upsert({
    where: { lineUserId: adminId },
    update: { role: "ADMIN", approved: true, orgId: self.id },
    create: {
      lineUserId: adminId,
      displayName: "管理者（ダミー）",
      role: "ADMIN",
      approved: true,
      orgId: self.id,
    },
  });

  // ── ダミー職人（自社 org）──
  const existingWorkers = await prisma.worker.count({ where: { orgId: self.id } });
  if (existingWorkers === 0) {
    await prisma.worker.createMany({
      data: [
        { name: "ダミー太郎", orgId: self.id, aliases: ["だみー太郎"] },
        { name: "ダミー次郎", orgId: self.id, aliases: [] },
      ],
    });
  }

  // ── ダミー取引先 A（現場 ×2・既定単価 + 現場単価）──
  let clientA = await prisma.client.findFirst({
    where: { name: "ダミー商事" },
    include: { sites: true },
  });
  if (!clientA) {
    clientA = await prisma.client.create({
      data: {
        name: "ダミー商事",
        honorific: "御中",
        address: "（住所はダミー・DBで管理）",
        aliases: ["ダミー商事株式会社"],
        sites: {
          create: [{ name: "ダミー第一現場" }, { name: "ダミー第二現場" }],
        },
      },
      include: { sites: true },
    });
    const siteA1 = clientA.sites.find((s) => s.name === "ダミー第一現場");
    await prisma.rateCard.createMany({
      data: [
        // 取引先既定単価（siteId=null）
        { clientId: clientA.id, siteId: null, contractType: "JOYO", unitPrice: 22000 },
        // 第一現場の個別単価（既定より優先）
        ...(siteA1
          ? [
              {
                clientId: clientA.id,
                siteId: siteA1.id,
                contractType: "JOYO" as const,
                unitPrice: 24000,
              },
            ]
          : []),
      ],
    });
  }

  // ── ダミー取引先 B（現場 ×1・既定単価）──
  let clientB = await prisma.client.findFirst({ where: { name: "ダミー工業" } });
  if (!clientB) {
    clientB = await prisma.client.create({
      data: {
        name: "ダミー工業",
        honorific: "御中",
        aliases: ["ダミー興業"],
        sites: { create: [{ name: "ダミー資材センター" }] },
      },
    });
    await prisma.rateCard.create({
      data: {
        clientId: clientB.id,
        siteId: null,
        contractType: "JOYO",
        unitPrice: 20000,
      },
    });
  }

  // ── ダミー請負契約（LumpContract）＝当月の請負一式（請求書に取り込まれる）──
  const nowYm = `${new Date().getFullYear()}-${String(
    new Date().getMonth() + 1,
  ).padStart(2, "0")}`;
  const lumpExists = await prisma.lumpContract.findFirst({
    where: { clientId: clientB.id, yearMonth: nowYm },
  });
  if (!lumpExists) {
    await prisma.lumpContract.create({
      data: {
        clientId: clientB.id,
        name: "ダミー改修工事",
        amount: 500000,
        yearMonth: nowYm,
        status: "ACTIVE",
        note: "（ダミー）当月の請負一式",
      },
    });
  }

  // ── 発行元（InvoiceSetting）＝ダミー（実名・住所・口座は入れない）──
  const settingExists = await prisma.invoiceSetting.findFirst();
  if (!settingExists) {
    await prisma.invoiceSetting.create({
      data: {
        issuerName: "ダミー発行元",
        address: "（〒・住所はダミー）",
        tel: "000-0000-0000",
        email: "dummy@example.com",
        regNumber: "T0000000000000",
        bankInfo: "（振込先はダミー・DBで管理）",
        taxRate: 0.1,
        contactName: "担当（ダミー）",
      },
    });
  }

  console.log("seed done:", {
    org: self.name,
    adminId,
    clientA: clientA?.name,
    clientB: clientB?.name,
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });

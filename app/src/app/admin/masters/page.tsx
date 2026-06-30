// ============================================================
// /admin/masters — 設定（Server Component）
//
//   freee / マネーフォワード 風の業務SaaS。1ページ縦羅列をやめ、
//   タブ分割（取引先 / 職人 / 自社・協力会社 / 請求書設定）＋一覧中心＋
//   ドロワー編集に再設計。データ取得はここで行い、各タブへ Row 型で渡す。
//
//   ・ガード: getAdminContext()（無ければログイン画面へ）＋ middleware。
//   ・prisma で取得 → ClientRow / WorkerRow / OrgRow / SettingRow に map。
//   ・<main class="container admin-narrow"> 直下に <MastersShell/> をマウント。
//   ・UI/IA のみ。ロジック・DB・Server Action は変更しない（既存を再利用）。
// ============================================================

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db.js";
import { getAdminContext } from "@/lib/auth.js";
import { MastersShell } from "./_mastersShell.js";
import type {
  ClientRow,
  WorkerRow,
  OrgRow,
  SettingRow,
} from "./_mastersTypes.js";

export const dynamic = "force-dynamic";

export default async function MastersPage() {
  const admin = await getAdminContext();
  if (!admin) redirect("/admin?error=login");

  const [clientRows, workerRows, orgRows, setting] = await Promise.all([
    prisma.client.findMany({ orderBy: { name: "asc" } }),
    prisma.worker.findMany({
      orderBy: { name: "asc" },
      include: { org: { select: { name: true, kind: true } } },
    }),
    prisma.organization.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.invoiceSetting.findFirst(),
  ]);

  const clients: ClientRow[] = clientRows.map((c) => ({
    id: c.id,
    name: c.name,
    honorific: c.honorific,
    address: c.address,
    unitPrice: c.unitPrice,
    nightUnitPrice: c.nightUnitPrice,
    otUnitPrice: c.otUnitPrice,
    billingMode: c.billingMode as "AGGREGATE" | "PER_SITE",
    active: c.active,
  }));

  const workers: WorkerRow[] = workerRows.map((w) => ({
    id: w.id,
    name: w.name,
    aliases: w.aliases,
    active: w.active,
    orgId: w.orgId,
    orgName: w.org.name,
    orgKind: w.org.kind as "SELF" | "PARTNER",
  }));

  const orgs: OrgRow[] = orgRows.map((o) => ({
    id: o.id,
    name: o.name,
    kind: o.kind as "SELF" | "PARTNER",
    active: o.active,
  }));

  const settingRow: SettingRow | null = setting
    ? {
        issuerName: setting.issuerName,
        address: setting.address,
        tel: setting.tel,
        email: setting.email,
        regNumber: setting.regNumber,
        bankInfo: setting.bankInfo,
        taxRate: setting.taxRate,
        contactName: setting.contactName,
      }
    : null;

  return (
    <main className="container admin-narrow">
      <div className="mst-head">
        <h1 className="mst-title">設定</h1>
      </div>

      <MastersShell
        clients={clients}
        workers={workers}
        orgs={orgs}
        setting={settingRow}
      />
    </main>
  );
}

// ============================================================
// 管理マスタ / ユーザー承認 — Server Actions（すべて ADMIN ガード）
//
//   - 各アクション冒頭で requireAdminAction() を呼び、未ログイン/非ADMINを弾く
//     （middleware と多層防御）。
//   - 入力は zod で検証（不正は throw → Next がエラー表示）。
//   - 変更後は revalidatePath で該当ページを再生成。
//
//   ※ Server Actions は "use server" モジュール。クライアントへは関数参照のみ渡る。
// ============================================================

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db.js";
import { getAdminContext } from "@/lib/auth.js";

/** ADMIN を要求。違反時は throw（Server Action はエラーをそのまま表面化）。 */
async function requireAdminAction(): Promise<void> {
  const admin = await getAdminContext();
  if (!admin) throw new Error("FORBIDDEN: 管理者ログインが必要です。");
}

/** FormData の文字列取得（trim）。 */
function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/** カンマ/読点/改行区切りの別名 → 配列（空要素除去・重複除去）。 */
function parseAliases(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[,、\n\r]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

const MASTERS_PATH = "/admin/masters";
const USERS_PATH = "/admin/users";

// ============================================================
// 取引先（Client）
// ============================================================
const clientSchema = z.object({
  name: z.string().min(1, "取引先名は必須です"),
  honorific: z.enum(["御中", "様"]).default("御中"),
  address: z.string().optional(),
  aliases: z.array(z.string()).default([]),
});

export async function createClientAction(fd: FormData): Promise<void> {
  await requireAdminAction();
  const parsed = clientSchema.safeParse({
    name: str(fd, "name"),
    honorific: str(fd, "honorific") || "御中",
    address: str(fd, "address") || undefined,
    aliases: parseAliases(str(fd, "aliases")),
  });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "入力エラー");
  await prisma.client.create({
    data: {
      name: parsed.data.name,
      honorific: parsed.data.honorific,
      address: parsed.data.address ?? null,
      aliases: parsed.data.aliases,
    },
  });
  revalidatePath(MASTERS_PATH);
}

export async function updateClientAction(fd: FormData): Promise<void> {
  await requireAdminAction();
  const id = str(fd, "id");
  if (!id) throw new Error("id がありません");
  const parsed = clientSchema
    .extend({ active: z.boolean().default(true) })
    .safeParse({
      name: str(fd, "name"),
      honorific: str(fd, "honorific") || "御中",
      address: str(fd, "address") || undefined,
      aliases: parseAliases(str(fd, "aliases")),
      active: fd.get("active") === "on" || fd.get("active") === "true",
    });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "入力エラー");
  await prisma.client.update({
    where: { id },
    data: {
      name: parsed.data.name,
      honorific: parsed.data.honorific,
      address: parsed.data.address ?? null,
      aliases: parsed.data.aliases,
      active: parsed.data.active,
    },
  });
  revalidatePath(MASTERS_PATH);
}

// ============================================================
// 現場（Site）
// ============================================================
export async function createSiteAction(fd: FormData): Promise<void> {
  await requireAdminAction();
  const clientId = str(fd, "clientId");
  const name = str(fd, "name");
  if (!clientId) throw new Error("取引先を選択してください");
  if (!name) throw new Error("現場名は必須です");
  // 参照整合性チェック。
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) throw new Error("取引先が見つかりません");
  await prisma.site.create({ data: { name, clientId } });
  revalidatePath(MASTERS_PATH);
}

export async function deleteSiteAction(fd: FormData): Promise<void> {
  await requireAdminAction();
  const id = str(fd, "id");
  if (!id) throw new Error("id がありません");
  // 出面/単価が紐づく現場は削除不可（参照を壊さない）。
  const [reportCount, rateCount] = await Promise.all([
    prisma.report.count({ where: { siteId: id } }),
    prisma.rateCard.count({ where: { siteId: id } }),
  ]);
  if (reportCount > 0 || rateCount > 0) {
    throw new Error("この現場は出面または単価に使われているため削除できません。");
  }
  await prisma.site.delete({ where: { id } });
  revalidatePath(MASTERS_PATH);
}

// ============================================================
// 単価（RateCard）: 取引先×現場（任意）×種別×単価
// ============================================================
const rateSchema = z.object({
  clientId: z.string().min(1, "取引先を選択してください"),
  siteId: z.string().optional(), // 空＝取引先既定単価
  contractType: z.enum(["JOYO", "UKEOI"]).default("JOYO"),
  unitPrice: z.number().int().nonnegative("単価は0以上の整数"),
  effectiveFrom: z.string().optional(), // yyyy-MM-dd（任意）
});

export async function createRateAction(fd: FormData): Promise<void> {
  await requireAdminAction();
  const unitPriceNum = Number(str(fd, "unitPrice"));
  const siteIdRaw = str(fd, "siteId");
  const effRaw = str(fd, "effectiveFrom");
  const parsed = rateSchema.safeParse({
    clientId: str(fd, "clientId"),
    siteId: siteIdRaw || undefined,
    contractType: (str(fd, "contractType") || "JOYO") as "JOYO" | "UKEOI",
    unitPrice: Number.isFinite(unitPriceNum) ? unitPriceNum : NaN,
    effectiveFrom: effRaw || undefined,
  });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "入力エラー");

  // siteId 指定時は当該取引先に属するか確認。
  if (parsed.data.siteId) {
    const site = await prisma.site.findFirst({
      where: { id: parsed.data.siteId, clientId: parsed.data.clientId },
    });
    if (!site) throw new Error("現場が取引先に属していません");
  }

  await prisma.rateCard.create({
    data: {
      clientId: parsed.data.clientId,
      siteId: parsed.data.siteId ?? null,
      contractType: parsed.data.contractType,
      unitPrice: parsed.data.unitPrice,
      ...(parsed.data.effectiveFrom
        ? { effectiveFrom: new Date(`${parsed.data.effectiveFrom}T00:00:00.000Z`) }
        : {}),
    },
  });
  revalidatePath(MASTERS_PATH);
}

export async function deleteRateAction(fd: FormData): Promise<void> {
  await requireAdminAction();
  const id = str(fd, "id");
  if (!id) throw new Error("id がありません");
  await prisma.rateCard.delete({ where: { id } });
  revalidatePath(MASTERS_PATH);
}

// ============================================================
// 職人（Worker）: org スコープ
// ============================================================
export async function createWorkerAction(fd: FormData): Promise<void> {
  await requireAdminAction();
  const name = str(fd, "name");
  const orgId = str(fd, "orgId");
  if (!name) throw new Error("職人名は必須です");
  if (!orgId) throw new Error("所属組織を選択してください");
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) throw new Error("組織が見つかりません");
  await prisma.worker.create({
    data: { name, orgId, aliases: parseAliases(str(fd, "aliases")) },
  });
  revalidatePath(MASTERS_PATH);
}

export async function updateWorkerAction(fd: FormData): Promise<void> {
  await requireAdminAction();
  const id = str(fd, "id");
  if (!id) throw new Error("id がありません");
  const name = str(fd, "name");
  if (!name) throw new Error("職人名は必須です");
  await prisma.worker.update({
    where: { id },
    data: {
      name,
      aliases: parseAliases(str(fd, "aliases")),
      active: fd.get("active") === "on" || fd.get("active") === "true",
    },
  });
  revalidatePath(MASTERS_PATH);
}

// ============================================================
// 組織（Organization）: 自社（SELF）/ パートナー（PARTNER）
// ============================================================
export async function createOrganizationAction(fd: FormData): Promise<void> {
  await requireAdminAction();
  const name = str(fd, "name");
  const kind = str(fd, "kind");
  if (!name) throw new Error("組織名は必須です");
  if (kind !== "SELF" && kind !== "PARTNER") throw new Error("種別が不正です");
  await prisma.organization.create({ data: { name, kind } });
  revalidatePath(MASTERS_PATH);
}

export async function updateOrganizationAction(fd: FormData): Promise<void> {
  await requireAdminAction();
  const id = str(fd, "id");
  if (!id) throw new Error("id がありません");
  const name = str(fd, "name");
  if (!name) throw new Error("組織名は必須です");
  await prisma.organization.update({
    where: { id },
    data: {
      name,
      active: fd.get("active") === "on" || fd.get("active") === "true",
    },
  });
  revalidatePath(MASTERS_PATH);
}

// ============================================================
// 自社情報（InvoiceSetting）: 発行元 / 振込先 / 税率
//   単一レコード運用（先頭1件）。無ければ作成、あれば更新（upsert 風）。
// ============================================================
const settingSchema = z.object({
  issuerName: z.string().min(1, "発行元名は必須です"),
  address: z.string().optional(),
  tel: z.string().optional(),
  email: z.string().optional(),
  regNumber: z.string().optional(),
  bankInfo: z.string().optional(),
  taxRate: z.number().min(0).max(1),
  contactName: z.string().optional(),
});

export async function saveInvoiceSettingAction(fd: FormData): Promise<void> {
  await requireAdminAction();
  // 税率は % 入力（例: 10）を 0.10 に変換。
  const pct = Number(str(fd, "taxRatePct"));
  const taxRate = Number.isFinite(pct) ? pct / 100 : NaN;
  const parsed = settingSchema.safeParse({
    issuerName: str(fd, "issuerName"),
    address: str(fd, "address") || undefined,
    tel: str(fd, "tel") || undefined,
    email: str(fd, "email") || undefined,
    regNumber: str(fd, "regNumber") || undefined,
    bankInfo: str(fd, "bankInfo") || undefined,
    taxRate,
    contactName: str(fd, "contactName") || undefined,
  });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "入力エラー");

  const data = {
    issuerName: parsed.data.issuerName,
    address: parsed.data.address ?? null,
    tel: parsed.data.tel ?? null,
    email: parsed.data.email ?? null,
    regNumber: parsed.data.regNumber ?? null,
    bankInfo: parsed.data.bankInfo ?? null,
    taxRate: parsed.data.taxRate,
    contactName: parsed.data.contactName ?? null,
  };
  const existing = await prisma.invoiceSetting.findFirst();
  if (existing) {
    await prisma.invoiceSetting.update({ where: { id: existing.id }, data });
  } else {
    await prisma.invoiceSetting.create({ data });
  }
  revalidatePath(MASTERS_PATH);
}

// ============================================================
// 請負契約金額（LumpContract）: 取引先×月の一式金額
// ============================================================
const lumpSchema = z.object({
  clientId: z.string().min(1, "取引先を選択してください"),
  name: z.string().min(1, "案件名は必須です"),
  amount: z.number().int().positive("金額は正の整数"),
  yearMonth: z.string().regex(/^\d{4}-\d{2}$/, "対象月は YYYY-MM"),
  note: z.string().optional(),
});

export async function createLumpContractAction(fd: FormData): Promise<void> {
  await requireAdminAction();
  const amount = Number(str(fd, "amount"));
  const parsed = lumpSchema.safeParse({
    clientId: str(fd, "clientId"),
    name: str(fd, "name"),
    amount: Number.isFinite(amount) ? amount : NaN,
    yearMonth: str(fd, "yearMonth"),
    note: str(fd, "note") || undefined,
  });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "入力エラー");
  const client = await prisma.client.findUnique({
    where: { id: parsed.data.clientId },
  });
  if (!client) throw new Error("取引先が見つかりません");
  await prisma.lumpContract.create({
    data: {
      clientId: parsed.data.clientId,
      name: parsed.data.name,
      amount: parsed.data.amount,
      yearMonth: parsed.data.yearMonth,
      note: parsed.data.note ?? null,
    },
  });
  revalidatePath(MASTERS_PATH);
}

export async function setLumpContractStatusAction(fd: FormData): Promise<void> {
  await requireAdminAction();
  const id = str(fd, "id");
  const status = str(fd, "status");
  if (!id) throw new Error("id がありません");
  if (status !== "ACTIVE" && status !== "ARCHIVED")
    throw new Error("status が不正です");
  await prisma.lumpContract.update({ where: { id }, data: { status } });
  revalidatePath(MASTERS_PATH);
}

// ============================================================
// 出面レポート（要確認キューの承認 / 削除）
//   「日々のチェック」の中核。LIFF から上がった出面のうち、
//   NEEDS_REVIEW（新規・要確認）を承認（CONFIRMED）するか、誤登録を削除する。
//   ※ 承認は状態確定のみ。グループ再投稿はしない（誤爆・二重投稿防止）。
// ============================================================
export async function confirmReportAction(fd: FormData): Promise<void> {
  await requireAdminAction();
  const id = str(fd, "id");
  if (!id) throw new Error("id がありません");
  await prisma.report.update({
    where: { id },
    data: { status: "CONFIRMED" },
  });
  revalidatePath("/admin");
}

export async function deleteReportAction(fd: FormData): Promise<void> {
  await requireAdminAction();
  const id = str(fd, "id");
  if (!id) throw new Error("id がありません");
  // entries は onDelete: Cascade。expenses は任意リレーション（SetNull 既定）の
  // ため、孤児を残さないよう明示削除してから本体を消す（トランザクション）。
  await prisma.$transaction([
    prisma.expense.deleteMany({ where: { reportId: id } }),
    prisma.report.delete({ where: { id } }),
  ]);
  revalidatePath("/admin");
}

// ============================================================
// ユーザー承認（NEEDS_REVIEW / 未承認 → role/org 割当 ＋ approved）
//   ★ パートナーは必ず正しい PARTNER 組織へ割り当てる（自社に漏らさない）。
// ============================================================
const approveSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["ADMIN", "OWNER", "VIEWER", "PARTNER"]),
  orgId: z.string().min(1, "所属組織を選択してください"),
  approved: z.boolean(),
});

export async function approveUserAction(fd: FormData): Promise<void> {
  await requireAdminAction();
  const parsed = approveSchema.safeParse({
    userId: str(fd, "userId"),
    role: (str(fd, "role") || "PARTNER") as
      | "ADMIN"
      | "OWNER"
      | "VIEWER"
      | "PARTNER",
    orgId: str(fd, "orgId"),
    approved: fd.get("approved") === "on" || fd.get("approved") === "true",
  });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "入力エラー");

  const org = await prisma.organization.findUnique({
    where: { id: parsed.data.orgId },
  });
  if (!org) throw new Error("組織が見つかりません");

  // 整合性ガード（不可視性）:
  //  - PARTNER ロールは PARTNER 組織にのみ割当可（自社グループに出さないため）。
  //  - SELF 組織には ADMIN/OWNER/VIEWER のみ。
  if (parsed.data.role === "PARTNER" && org.kind !== "PARTNER") {
    throw new Error("PARTNER ロールは PARTNER 組織にのみ割り当て可能です。");
  }
  if (parsed.data.role !== "PARTNER" && org.kind !== "SELF") {
    throw new Error("ADMIN/OWNER/VIEWER は自社（SELF）組織に割り当ててください。");
  }

  await prisma.user.update({
    where: { id: parsed.data.userId },
    data: {
      role: parsed.data.role,
      orgId: parsed.data.orgId,
      approved: parsed.data.approved,
    },
  });
  revalidatePath(USERS_PATH);
  revalidatePath("/admin");
}

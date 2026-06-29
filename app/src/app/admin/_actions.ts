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

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db.js";
import { getAdminContext } from "@/lib/auth.js";
import type { ReportEditorData, ReportEditInput } from "./_editTypes.js";

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
const INVOICES_PATH = "/admin/invoices";

// ============================================================
// 取引先（Client）
// ============================================================
const clientSchema = z.object({
  name: z.string().min(1, "取引先名は必須です"),
  honorific: z.enum(["御中", "様"]).default("御中"),
  address: z.string().optional(),
  // v3: 常用の人工単価（任意・未入力=null）。別名(aliases)は UI 廃止のため受け取らない。
  unitPrice: z.number().int().nonnegative("単価は0以上の整数").nullable().default(null),
});

export async function createClientAction(fd: FormData): Promise<void> {
  await requireAdminAction();
  const parsed = clientSchema.safeParse({
    name: str(fd, "name"),
    honorific: str(fd, "honorific") || "御中",
    address: str(fd, "address") || undefined,
    unitPrice: str(fd, "unitPrice") ? Number(str(fd, "unitPrice")) : null,
  });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "入力エラー");
  await prisma.client.create({
    data: {
      name: parsed.data.name,
      honorific: parsed.data.honorific,
      address: parsed.data.address ?? null,
      unitPrice: parsed.data.unitPrice,
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
      unitPrice: str(fd, "unitPrice") ? Number(str(fd, "unitPrice")) : null,
      active: fd.get("active") === "on" || fd.get("active") === "true",
    });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "入力エラー");
  // aliases は UI 廃止後も既存値を維持するため update では touch しない。
  await prisma.client.update({
    where: { id },
    data: {
      name: parsed.data.name,
      honorific: parsed.data.honorific,
      address: parsed.data.address ?? null,
      unitPrice: parsed.data.unitPrice,
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

// 職人の「削除（無効化）」＝有効/無効トグル。
//   ReportEntry の FK があるため物理削除はせず active を切り替える。
//   無効化＝LIFF の選択肢（active のみ返す masters）から除外される。
const workerActiveSchema = z.object({
  id: z.string().min(1, "id がありません"),
  active: z.boolean(),
});

export async function setWorkerActiveAction(fd: FormData): Promise<void> {
  await requireAdminAction();
  const parsed = workerActiveSchema.safeParse({
    id: str(fd, "id"),
    active: fd.get("active") === "on" || fd.get("active") === "true",
  });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "入力エラー");
  await prisma.worker.update({
    where: { id: parsed.data.id },
    data: { active: parsed.data.active },
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
  revalidateTag("reports"); // 月次集計キャッシュを無効化
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
  revalidateTag("reports"); // 月次集計キャッシュを無効化
  revalidatePath("/admin");
}

// ============================================================
// 出面のインライン編集（管理ホームのフィード/要確認カードから開く大モーダル）
//   getReportForEditAction: カード押下時に当該出面の全項目をオンデマンド取得。
//   updateReportAction    : フォーム送信で本体＋明細（職人/経費）を総入れ替え。
//   ※ クライアントから「プレーン引数」で呼ぶ（React 19 Server Actions）。
// ============================================================

/**
 * 編集モーダルを開いた時に1往復で取得する初期データ（出面本体＋取引先/職人）。
 *   ※ 一覧（フィード/要確認）側の各ボタンへ取引先/職人の巨大配列を撒かず、
 *     モーダルを開いた時だけここで取りに行く（一覧の RSC ペイロード＆ハイドレーション軽量化）。
 */
export async function getReportForEditAction(id: string): Promise<ReportEditorData> {
  await requireAdminAction();
  if (!id) throw new Error("id がありません");
  const [r, clients, workers] = await Promise.all([
    prisma.report.findUnique({
      where: { id },
      include: {
        org: { select: { kind: true } },
        entries: true,
        expenses: true,
      },
    }),
    // 過去の無効取引先/職人も選択肢に残す（既存出面の整合のため active フィルタ無し）。
    prisma.client.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.worker.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, orgId: true },
    }),
  ]);
  if (!r) throw new Error("出面が見つかりません");
  return {
    report: {
      id: r.id,
      workDate: r.workDate.toISOString().slice(0, 10),
      clientId: r.clientId,
      orgId: r.orgId,
      orgKind: r.org.kind,
      siteName: r.siteName ?? "",
      contractType: r.contractType,
      contractAmount: r.contractAmount ?? null,
      status: r.status,
      entries: r.entries.map((e) => ({
        workerId: e.workerId,
        shift: e.shift,
        manDays: e.manDays,
        otHours: e.otHours,
      })),
      expenses: r.expenses.map((x) => ({
        kind: x.kind,
        amount: x.amount,
        billable: x.billable,
      })),
    },
    clients,
    workers,
  };
}

const reportEditSchema = z.object({
  id: z.string().min(1, "id がありません"),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日付が不正です"),
  clientId: z.string().min(1, "取引先を選択してください"),
  siteName: z.string().trim(),
  contractType: z.enum(["JOYO", "UKEOI"]),
  contractAmount: z.number().int().positive().nullable(),
  entries: z
    .array(
      z.object({
        workerId: z.string().min(1, "職人を選択してください"),
        shift: z.enum(["DAY", "HALF", "NIGHT"]),
        manDays: z.number().nonnegative(),
        otHours: z.number().nonnegative(),
      }),
    )
    .min(1, "職人を1人以上入れてください"),
  expenses: z.array(
    z.object({
      kind: z.string().min(1, "経費の項目名を入力してください"),
      amount: z.number().int().nonnegative(),
      billable: z.boolean(),
    }),
  ),
});

/** 出面1件を総入れ替え更新（本体＋明細＋経費）。明細・経費は delete→create でフル置換。 */
export async function updateReportAction(input: ReportEditInput): Promise<void> {
  await requireAdminAction();
  const parsed = reportEditSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "入力エラー");
  const {
    id,
    workDate,
    clientId,
    siteName,
    contractType,
    contractAmount,
    entries,
    expenses,
  } = parsed.data;

  // 契約整合: 請負は契約金額（正の整数）必須。常用は金額を持たない（null へ矯正）。
  if (contractType === "UKEOI" && (contractAmount === null || contractAmount <= 0)) {
    throw new Error("請負金額を入力してください");
  }

  // 参照整合性: 取引先・職人が実在するか。
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) throw new Error("取引先が見つかりません");
  const ids = [...new Set(entries.map((e) => e.workerId))];
  const cnt = await prisma.worker.count({ where: { id: { in: ids } } });
  if (cnt !== ids.length) throw new Error("職人が見つかりません");

  // 日付は UTC 0時固定（@db.Date 列の境界ぶれ回避。保存も集計も同じ流儀）。
  const dayStart = new Date(`${workDate}T00:00:00.000Z`);

  await prisma.$transaction([
    prisma.report.update({
      where: { id },
      data: {
        workDate: dayStart,
        clientId,
        siteName: siteName.trim() || null,
        contractType,
        contractAmount: contractType === "UKEOI" ? contractAmount : null,
      },
    }),
    prisma.reportEntry.deleteMany({ where: { reportId: id } }),
    prisma.reportEntry.createMany({
      data: entries.map((e) => ({
        reportId: id,
        workerId: e.workerId,
        shift: e.shift,
        manDays: e.manDays,
        otHours: e.otHours,
      })),
    }),
    prisma.expense.deleteMany({ where: { reportId: id } }),
    ...(expenses.length
      ? [
          prisma.expense.createMany({
            data: expenses.map((x) => ({
              reportId: id,
              workDate: dayStart, // Expense.workDate は必須(@db.Date)
              clientId, // 請求の名寄せ用に report の取引先を引き継ぐ（siteId は付けない）
              kind: x.kind,
              amount: x.amount,
              billable: x.billable,
            })),
          }),
        ]
      : []),
  ]);

  revalidateTag("reports"); // 月次集計キャッシュを無効化
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

// 在籍状態（拒否/無効化・復活）。DISABLED は承認状態に関わらず入室不可。
const statusSchema = z.object({
  userId: z.string().min(1),
  status: z.enum(["ACTIVE", "DISABLED"]),
});

export async function setUserStatusAction(fd: FormData): Promise<void> {
  await requireAdminAction();
  const parsed = statusSchema.safeParse({
    userId: str(fd, "userId"),
    status: (str(fd, "status") || "ACTIVE") as "ACTIVE" | "DISABLED",
  });
  if (!parsed.success)
    throw new Error(parsed.error.issues[0]?.message ?? "入力エラー");
  await prisma.user.update({
    where: { id: parsed.data.userId },
    data: { status: parsed.data.status },
  });
  revalidatePath(USERS_PATH);
  revalidatePath("/admin");
}

// ============================================================
// 物理削除（管理者が全データを安全に整理するため）
//   ★ 破壊的操作。UI 側は ConfirmDeleteButton（window.confirm）で必ず確認を挟む。
//   ★ FK で他データが参照している場合は削除せず throw（日本語）→「無効化」へ誘導。
//      （Prisma の onDelete 未指定リレーションは参照ありで物理削除が失敗するため、
//       事前に件数を数えて分かりやすいメッセージで弾く。）
// ============================================================

// 削除アクションの戻り値。
//   ※ Server Action で throw した Error メッセージは本番ビルドではマスクされ、
//     クライアントには汎用文言（"An error occurred in the Server Components render…"）
//     しか届かない。理由（無効化してください 等）を確実に伝えるため、想定内の失敗は
//     throw せず { ok:false, error } を「返す」。呼び出し側（ConfirmDeleteButton）が表示する。
type DeleteResult = { ok: boolean; error?: string };

/**
 * 取引先（Client）を削除。出面/請求書に使われている場合は不可（無効化へ誘導）。
 *   参照なしなら 単価(RateCard)→現場(Site)→請負契約(LumpContract) を消してから本体削除。
 *   （これらは Client への onDelete 未指定リレーション＝先に消さないと本体削除が失敗する）
 */
export async function deleteClientAction(fd: FormData): Promise<DeleteResult> {
  await requireAdminAction();
  const id = str(fd, "id");
  if (!id) return { ok: false, error: "id がありません" };
  const [reports, invoices] = await Promise.all([
    prisma.report.count({ where: { clientId: id } }),
    prisma.invoice.count({ where: { clientId: id } }),
  ]);
  if (reports > 0 || invoices > 0) {
    return {
      ok: false,
      error: `この取引先は 出面${reports}件・請求書${invoices}件 に使われているため削除できません。無効化してください。`,
    };
  }
  await prisma.$transaction([
    prisma.rateCard.deleteMany({ where: { clientId: id } }),
    prisma.site.deleteMany({ where: { clientId: id } }),
    prisma.lumpContract.deleteMany({ where: { clientId: id } }),
    prisma.client.delete({ where: { id } }),
  ]);
  revalidatePath(MASTERS_PATH);
  return { ok: true };
}

/**
 * 職人（Worker）を削除。出面（ReportEntry）に使われている場合は不可（無効化へ誘導）。
 */
export async function deleteWorkerAction(fd: FormData): Promise<DeleteResult> {
  await requireAdminAction();
  const id = str(fd, "id");
  if (!id) return { ok: false, error: "id がありません" };
  const used = await prisma.reportEntry.count({ where: { workerId: id } });
  if (used > 0) {
    return {
      ok: false,
      error: `この職人は 出面${used}件 に使われているため削除できません。無効化してください。`,
    };
  }
  await prisma.worker.delete({ where: { id } });
  revalidatePath(MASTERS_PATH);
  return { ok: true };
}

/**
 * 組織（Organization）を削除。ユーザー/職人/出面が紐づく場合は不可（無効化へ誘導）。
 *   ※ 「自社（SELF）が2つある」等の重複組織を、参照ゼロのものに限り掃除できる。
 *     紐づき件数をメッセージに含め、どちらが空（削除可）か分かるようにする。
 */
export async function deleteOrganizationAction(
  fd: FormData,
): Promise<DeleteResult> {
  await requireAdminAction();
  const id = str(fd, "id");
  if (!id) return { ok: false, error: "id がありません" };
  const [users, workers, reports] = await Promise.all([
    prisma.user.count({ where: { orgId: id } }),
    prisma.worker.count({ where: { orgId: id } }),
    prisma.report.count({ where: { orgId: id } }),
  ]);
  if (users > 0 || workers > 0 || reports > 0) {
    return {
      ok: false,
      error: `この組織には ユーザー${users}・職人${workers}・出面${reports} が紐づくため削除できません。先に職人やユーザーを別の組織へ移すか、無効化してください。`,
    };
  }
  await prisma.organization.delete({ where: { id } });
  revalidatePath(MASTERS_PATH);
  return { ok: true };
}

/**
 * 請求書（Invoice）を削除。明細（InvoiceLine）は onDelete: Cascade で自動削除。
 */
export async function deleteInvoiceAction(fd: FormData): Promise<DeleteResult> {
  await requireAdminAction();
  const id = str(fd, "id");
  if (!id) return { ok: false, error: "id がありません" };
  await prisma.invoice.delete({ where: { id } });
  revalidatePath(INVOICES_PATH);
  return { ok: true };
}

/**
 * ユーザー（User）を削除。ログイン中の管理者自身は削除不可（誤って締め出さないため）。
 *   User は他モデルから FK 参照されない（Report.createdById は String・リレーション未定義）
 *   ため、件数チェックは不要でそのまま削除できる。
 */
export async function deleteUserAction(fd: FormData): Promise<DeleteResult> {
  await requireAdminAction();
  const id = str(fd, "id");
  if (!id) return { ok: false, error: "id がありません" };
  const admin = await getAdminContext();
  if (admin && admin.user.id === id) {
    return { ok: false, error: "自分自身は削除できません。" };
  }
  await prisma.user.delete({ where: { id } });
  revalidatePath(USERS_PATH);
  return { ok: true };
}

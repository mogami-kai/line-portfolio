// ============================================================
// 出面作成の核（正本）— POST /api/reports（LIFF）と
// 管理画面の createReportAction（代理登録）の両方から呼ぶ。
//
//   冪等キー確認 → 取引先/職人の実在確認 → validateReportRows(聞き返し判定)
//   → Report(+entries+expenses) 保存 → 監査ログ → キャッシュ無効化
//   → 現場利用統計更新 → (SELF かつ postToGroup!==false なら)LINEグループ投稿
//
//   ロジックは元々 api/reports/route.ts に実装されていたものをそのまま移植。
//   挙動を変えたのは投稿条件のみ（org.kind==="SELF" → org.kind==="SELF" && postToGroup!==false）。
// ============================================================

import { revalidateTag } from "next/cache";
import { prisma } from "@/lib/db.js";
import {
  formatReportLog,
  pushToGroup,
  type ReportLogInput,
} from "@/lib/line.js";
import {
  buildAskbackMessage,
  validateReportRows,
  type RowInput,
} from "@/lib/validate.js";
import { isValidReceiptId } from "@/lib/storage.js";
import { reportLabel, writeAuditLog } from "@/lib/audit.js";
import type { ContractType, OrgKind, Shift } from "@prisma/client";

export interface CreateReportEntryInput {
  workerId: string;
  shift: Shift;
  manDays: number;
  otHours: number;
}

export interface CreateReportExpenseInput {
  kind: string;
  amount: number;
  billable: boolean;
  paidBy?: string;
  receiptPath?: string;
}

export interface CreateReportInput {
  workDate: string; // yyyy-MM-dd
  clientId: string;
  siteName?: string;
  siteId?: string;
  contractType: ContractType;
  contractAmount?: number | null;
  entries: CreateReportEntryInput[];
  expenses?: CreateReportExpenseInput[];
  clientRequestId?: string;
}

export interface CreateReportContext {
  orgId: string;
  orgKind: OrgKind;
  createdById: string;
  createdByName: string;
  // undefined = 既存どおり org.kind で自動判定(SELF→投稿)。
  // false を渡すと SELF でも投稿をスキップ（管理画面の代理登録用）。
  postToGroup?: boolean;
}

export type CreateReportResult =
  | {
      ok: true;
      reportId: string;
      status: "CONFIRMED" | "NEEDS_REVIEW";
      postedToGroup: boolean;
      deduped?: boolean;
      askback?: string;
    }
  | { ok: false; kind: "hold"; message: string; askback: string }
  | { ok: false; kind: "client_not_found" | "worker_not_found"; message: string }
  | { ok: false; kind: "conflict"; message: string };

export async function createReportCore(
  input: CreateReportInput,
  ctx: CreateReportContext,
): Promise<CreateReportResult> {
  // ── 冪等性: clientRequestId が既存なら、その結果を返す（新規作成しない）──
  if (input.clientRequestId) {
    const dup = await prisma.report.findUnique({
      where: { clientRequestId: input.clientRequestId },
      select: { id: true, status: true, postedToGroup: true, createdById: true },
    });
    if (dup) {
      if (dup.createdById !== ctx.createdById) {
        return { ok: false, kind: "conflict", message: "同一キーの出面が別の入力者で既に存在します。" };
      }
      return {
        ok: true,
        reportId: dup.id,
        status: dup.status,
        postedToGroup: dup.postedToGroup,
        deduped: true,
      };
    }
  }

  // 参照整合性: clientId が DB に存在し、かつ有効(active)か。
  const client = await prisma.client.findFirst({
    where: { id: input.clientId, active: true },
    select: { id: true, name: true },
  });
  if (!client) {
    return { ok: false, kind: "client_not_found", message: "取引先が見つからないか、無効化されています。" };
  }

  let site: { id: string; name: string } | null = null;
  if (input.siteId) {
    site = await prisma.site.findFirst({
      where: { id: input.siteId, clientId: input.clientId },
      select: { id: true, name: true },
    });
  }

  const siteName = (input.siteName ?? site?.name ?? "").trim();

  const workerIds = input.entries.map((e) => e.workerId);
  const workers = await prisma.worker.findMany({
    where: { id: { in: workerIds }, orgId: ctx.orgId, active: true },
    select: { id: true, name: true },
  });
  const workerById = new Map(workers.map((w) => [w.id, w]));
  const missingWorker = workerIds.find((id) => !workerById.has(id));
  if (missingWorker) {
    return { ok: false, kind: "worker_not_found", message: "職人が見つからないか、無効化されています。" };
  }

  // ── 聞き返し判定（@/lib/validate）──
  const refDate = new Date();
  const rows: RowInput[] = input.entries.map((e) => ({
    client: client.name,
    site: siteName,
    date: input.workDate,
    worker: workerById.get(e.workerId)!.name,
    qty: e.manDays,
    ot: e.otHours,
  }));

  const report = validateReportRows(rows, {
    canonicals: [client.name],
    resolveClient: () => client.name,
    refDate,
  });

  if (report.status === "hold") {
    return { ok: false, kind: "hold", message: buildAskbackMessage(report), askback: buildAskbackMessage(report) };
  }

  const status = report.status === "confirm" ? "NEEDS_REVIEW" : "CONFIRMED";

  const dayStart = new Date(`${input.workDate}T00:00:00.000Z`);

  // 領収書IDの所有権検証: 形式が正しく、かつ自組織(orgId)の ReceiptImage に実在するものだけ許可。
  const receiptIdCandidates = (input.expenses ?? [])
    .map((x) => x.receiptPath)
    .filter((v): v is string => Boolean(v) && isValidReceiptId(v as string));
  const ownedReceiptIds = new Set<string>(
    receiptIdCandidates.length
      ? (
          await prisma.receiptImage.findMany({
            where: { id: { in: receiptIdCandidates }, orgId: ctx.orgId },
            select: { id: true },
          })
        ).map((r) => r.id)
      : [],
  );

  const createReport = () =>
    prisma.report.create({
      data: {
        workDate: dayStart,
        clientId: client.id,
        siteId: site?.id ?? null,
        siteName: siteName || null,
        contractType: input.contractType,
        contractAmount:
          input.contractType === "UKEOI" ? (input.contractAmount ?? null) : null,
        source: ctx.orgKind,
        orgId: ctx.orgId,
        createdById: ctx.createdById,
        status,
        postedToGroup: false,
        clientRequestId: input.clientRequestId ?? null,
        entries: {
          create: input.entries.map((e) => ({
            workerId: e.workerId,
            shift: e.shift,
            manDays: e.manDays,
            otHours: e.otHours,
          })),
        },
        expenses: input.expenses?.length
          ? {
              create: input.expenses.map((x) => ({
                workDate: dayStart,
                clientId: client.id,
                siteId: site?.id ?? null,
                kind: x.kind,
                amount: x.amount,
                billable: x.billable,
                paidBy: x.paidBy || null,
                receiptPath:
                  x.receiptPath && ownedReceiptIds.has(x.receiptPath)
                    ? x.receiptPath
                    : null,
              })),
            }
          : undefined,
      },
      include: {
        client: { select: { name: true } },
        entries: { include: { worker: { select: { name: true } } } },
        expenses: { select: { kind: true, amount: true } },
      },
    });

  let created: Awaited<ReturnType<typeof createReport>>;
  try {
    created = await createReport();
  } catch (e) {
    if (
      input.clientRequestId &&
      typeof e === "object" &&
      e !== null &&
      (e as { code?: string }).code === "P2002"
    ) {
      const existing = await prisma.report.findUnique({
        where: { clientRequestId: input.clientRequestId },
        select: { id: true, status: true, postedToGroup: true },
      });
      if (existing) {
        return {
          ok: true,
          reportId: existing.id,
          status: existing.status,
          postedToGroup: existing.postedToGroup,
          deduped: true,
        };
      }
    }
    throw e;
  }

  await writeAuditLog({
    actorId: ctx.createdById,
    actorName: ctx.createdByName,
    action: "REPORT_CREATE",
    reportId: created.id,
    summary: `${reportLabel(created.workDate, created.client.name, created.siteName)} を入力`,
  });

  revalidateTag("reports");

  if (site) {
    try {
      await prisma.site.update({
        where: { id: site.id },
        data: { usageCount: { increment: 1 }, lastUsedAt: dayStart },
      });
    } catch (e) {
      console.error("[reportCreate] site usage update failed", e);
    }
  }

  // ── 投稿ルーティング: SELF かつ postToGroup!==false のときだけグループへ投稿 ──
  let postedToGroup = false;
  if (ctx.orgKind === "SELF" && ctx.postToGroup !== false) {
    try {
      const baseSiteName = created.siteName ?? "";
      const ukeoiNote =
        created.contractType === "UKEOI" && created.contractAmount != null
          ? `（請負 ¥${created.contractAmount.toLocaleString("ja-JP")}）`
          : "";
      const displaySiteName = `${baseSiteName}${ukeoiNote}`.trim();
      const logInput: ReportLogInput = {
        workDate: created.workDate,
        contractType: created.contractType,
        client: created.client,
        site: displaySiteName ? { name: displaySiteName } : null,
        entries: created.entries.map((e) => ({
          shift: e.shift,
          manDays: e.manDays,
          otHours: e.otHours,
          worker: e.worker,
        })),
        expenses: created.expenses.map((x) => ({
          kind: x.kind,
          amount: x.amount,
        })),
      };
      await pushToGroup(formatReportLog(logInput));
      postedToGroup = true;
      await prisma.report.update({
        where: { id: created.id },
        data: { postedToGroup: true },
      });
    } catch (e) {
      console.error("[reportCreate] pushToGroup failed", e);
    }
  }

  return {
    ok: true,
    reportId: created.id,
    status: created.status,
    postedToGroup,
    askback: report.status === "confirm" ? buildAskbackMessage(report) : undefined,
  };
}

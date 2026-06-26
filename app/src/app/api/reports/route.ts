// ============================================================
// POST /api/reports — 出面送信（2系統ルーティングの核）
//
// フロー:
//   1) Authorization: Bearer <LIFF access token> → lineUserId → User+Org
//   2) 未承認なら 403
//   3) zod でボディ検証 → @/lib/validate(validateReportRows) で聞き返し判定
//        hold    → 422（buildAskbackMessage を返す。保存しない）
//        confirm → status=NEEDS_REVIEW で保存（管理者承認キューへ）
//        ok      → status=CONFIRMED で保存
//   4) Report(+entries+expenses) を保存（source=org.kind / orgId / createdById）
//   5) ★ルーティング（org.kind で1分岐）★
//        SELF    → pushToGroup(formatReportLog(...)) ＋ postedToGroup=true
//        PARTNER → push しない（管理ダッシュボードでのみ集約）
//   6) { ok, reportId, status } を返す
// ============================================================

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db.js";
import {
  bearerToken,
  requireApproved,
  resolveUserFromAccessToken,
} from "@/lib/auth.js";
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── 入力スキーマ ──
const entrySchema = z.object({
  workerId: z.string().min(1),
  shift: z.enum(["DAY", "HALF", "NIGHT"]).default("DAY"),
  manDays: z.number().positive(),
  otHours: z.number().min(0).default(0),
});

const expenseSchema = z.object({
  kind: z.string().min(1),
  amount: z.number().int(),
  billable: z.boolean().default(true),
});

const bodySchema = z.object({
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "workDate must be yyyy-MM-dd"),
  clientId: z.string().min(1),
  siteId: z.string().min(1).optional(),
  contractType: z.enum(["JOYO", "UKEOI"]).default("JOYO"),
  entries: z.array(entrySchema).min(1, "at least one entry required"),
  expenses: z.array(expenseSchema).optional(),
  // 任意: クライアントが新規現場名を渡してきた場合の補助（NEEDS_REVIEW 材料）。
  newSiteName: z.string().trim().min(1).optional(),
  // 任意: 二重送信防止の冪等キー（クライアント生成）。同一キーの再POSTは
  // 既存レポートを返し、新規作成しない（リトライ/連打の安全網）。
  clientRequestId: z.string().trim().min(1).max(100).optional(),
});

type Body = z.infer<typeof bodySchema>;

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status });
}

export async function POST(req: Request) {
  // ── 1) 認証（LIFF アクセストークン）──
  const token = bearerToken(req.headers.get("authorization"));
  if (!token) {
    return json(401, { ok: false, error: "missing access token" });
  }

  const resolved = await resolveUserFromAccessToken(token);
  if (!resolved) {
    return json(401, { ok: false, error: "invalid access token" });
  }

  // ── 2) 承認チェック ──
  try {
    requireApproved(resolved);
  } catch {
    return json(403, {
      ok: false,
      error: "not_approved",
      message: "アカウントが未承認です。管理者の承認をお待ちください。",
    });
  }

  const { user, org } = resolved;

  // ── 3a) ボディ検証（zod）──
  let body: Body;
  try {
    const raw = await req.json();
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return json(400, {
        ok: false,
        error: "invalid_body",
        issues: parsed.error.flatten(),
      });
    }
    body = parsed.data;
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }

  // ── 冪等性: clientRequestId が既存なら、その結果を返す（新規作成しない）──
  // ネットワーク再送・ボタン連打での二重登録を防ぐ。所有者一致も確認する。
  if (body.clientRequestId) {
    const dup = await prisma.report.findUnique({
      where: { clientRequestId: body.clientRequestId },
      select: { id: true, status: true, postedToGroup: true, createdById: true },
    });
    if (dup) {
      // 別人のキーと衝突した場合は新規キー扱いにせず、安全側で受理済みとして返す
      // （ここでは作成者一致のときのみ "既存" を返し、不一致は 409 で弾く）。
      if (dup.createdById !== user.id) {
        return json(409, { ok: false, error: "request_id_conflict" });
      }
      return json(200, {
        ok: true,
        reportId: dup.id,
        status: dup.status,
        postedToGroup: dup.postedToGroup,
        deduped: true,
      });
    }
  }

  // 参照整合性: clientId / siteId / workerId が DB に存在するか。
  const client = await prisma.client.findUnique({
    where: { id: body.clientId },
    select: { id: true, name: true },
  });
  if (!client) {
    return json(400, { ok: false, error: "client_not_found" });
  }

  let site: { id: string; name: string } | null = null;
  if (body.siteId) {
    site = await prisma.site.findFirst({
      where: { id: body.siteId, clientId: body.clientId },
      select: { id: true, name: true },
    });
    if (!site) {
      return json(400, { ok: false, error: "site_not_found" });
    }
  }

  const workerIds = body.entries.map((e) => e.workerId);
  const workers = await prisma.worker.findMany({
    where: { id: { in: workerIds }, orgId: org.id },
    select: { id: true, name: true },
  });
  const workerById = new Map(workers.map((w) => [w.id, w]));
  const missingWorker = workerIds.find((id) => !workerById.has(id));
  if (missingWorker) {
    return json(400, {
      ok: false,
      error: "worker_not_found",
      message: "職人が自組織に見つかりません。",
    });
  }

  // ── 3b) 聞き返し判定（@/lib/validate）──
  // 構造化入力なので取引先/職人は確定。日付・人工・残業・重複を精査する。
  const refDate = new Date();
  const siteName = site?.name ?? body.newSiteName ?? "";
  const rows: RowInput[] = body.entries.map((e) => ({
    client: client.name,
    site: siteName,
    date: body.workDate,
    worker: workerById.get(e.workerId)!.name,
    qty: e.manDays,
    ot: e.otHours,
  }));

  // 既知取引先＝選択済みなので resolveClient で常に正式名を返す（取引先チェックは ok 化）。
  const report = validateReportRows(rows, {
    canonicals: [client.name],
    resolveClient: () => client.name,
    refDate,
  });

  if (report.status === "hold") {
    // 保存せず聞き返し。
    return json(422, {
      ok: false,
      status: "hold",
      message: buildAskbackMessage(report),
    });
  }

  // confirm → 管理者承認キュー（NEEDS_REVIEW）。ok → CONFIRMED。
  // パートナーの新規現場（newSiteName 指定・既存 site なし）も要確認に倒す。
  const isNewSite = !site && Boolean(body.newSiteName);
  const status =
    report.status === "confirm" || isNewSite ? "NEEDS_REVIEW" : "CONFIRMED";

  // ── 4) 保存（Report + entries + expenses）──
  // source は org.kind から自動判定（本人は選ばない）。
  // create を関数化して戻り型を推論させ、冪等キー競合（P2002）のみ握る。
  const dayStart = new Date(`${body.workDate}T00:00:00.000Z`);
  const createReport = () =>
    prisma.report.create({
      data: {
        workDate: dayStart,
        clientId: client.id,
        siteId: site?.id ?? null,
        contractType: body.contractType,
        source: org.kind,
        orgId: org.id,
        createdById: user.id,
        status,
        postedToGroup: false,
        clientRequestId: body.clientRequestId ?? null,
        entries: {
          create: body.entries.map((e) => ({
            workerId: e.workerId,
            shift: e.shift,
            manDays: e.manDays,
            otHours: e.otHours,
          })),
        },
        expenses: body.expenses?.length
          ? {
              create: body.expenses.map((x) => ({
                workDate: dayStart,
                clientId: client.id,
                siteId: site?.id ?? null,
                kind: x.kind,
                amount: x.amount,
                billable: x.billable,
              })),
            }
          : undefined,
      },
      include: {
        client: { select: { name: true } },
        site: { select: { name: true } },
        entries: { include: { worker: { select: { name: true } } } },
      },
    });

  let created: Awaited<ReturnType<typeof createReport>>;
  try {
    created = await createReport();
  } catch (e) {
    // 冪等キーの競合（同時 2 連打）: 既存レポートを返して二重作成を避ける。
    if (
      body.clientRequestId &&
      typeof e === "object" &&
      e !== null &&
      (e as { code?: string }).code === "P2002"
    ) {
      const existing = await prisma.report.findUnique({
        where: { clientRequestId: body.clientRequestId },
        select: { id: true, status: true, postedToGroup: true },
      });
      if (existing) {
        return json(200, {
          ok: true,
          reportId: existing.id,
          status: existing.status,
          postedToGroup: existing.postedToGroup,
          deduped: true,
        });
      }
    }
    throw e;
  }

  // ── 5) ★2系統ルーティング（org.kind で1分岐）★ ──
  let postedToGroup = false;
  if (org.kind === "SELF") {
    // 自社 → 出面グループへ整形ログ投稿。
    try {
      const logInput: ReportLogInput = {
        workDate: created.workDate,
        contractType: created.contractType,
        client: created.client,
        site: created.site,
        entries: created.entries.map((e) => ({
          shift: e.shift,
          manDays: e.manDays,
          otHours: e.otHours,
          worker: e.worker,
        })),
      };
      await pushToGroup(formatReportLog(logInput));
      postedToGroup = true;
      await prisma.report.update({
        where: { id: created.id },
        data: { postedToGroup: true },
      });
    } catch (e) {
      // 投稿失敗でも保存は確定済み。投稿フラグは false のまま返す。
      console.error("[reports] pushToGroup failed", e);
    }
  }
  // PARTNER → 何もしない（グループ非投稿・管理ダッシュボードでのみ集約）。

  // ── 6) レスポンス ──
  return json(200, {
    ok: true,
    reportId: created.id,
    status: created.status,
    postedToGroup,
    askback:
      report.status === "confirm" ? buildAskbackMessage(report) : undefined,
  });
}

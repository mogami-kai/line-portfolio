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
import { revalidateTag } from "next/cache";
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
  // 1出面=1人の1日ぶん。人工は実運用で 0.5〜1 程度。上限は安全網（不正値の遮断）。
  manDays: z.number().positive().max(31),
  otHours: z.number().min(0).max(24).default(0),
});

const expenseSchema = z.object({
  kind: z.string().min(1).max(50),
  // 立替は非負・現実的上限まで。負数・桁あふれが請求金額/xlsx へ伝播するのを防ぐ。
  amount: z.number().int().min(0).max(10_000_000),
  billable: z.boolean().default(true),
});

const bodySchema = z.object({
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "workDate must be yyyy-MM-dd"),
  clientId: z.string().min(1),
  // v3: 現場は自由入力（現場マスタに依存しない）。Report.siteName に保存する。
  // 空文字可（現場未記入の出面を許容）。siteId はもう送られない想定だが、
  // 過去クライアント互換のため受理は残す（後方互換・現場マスタ自動作成はしない）。
  siteName: z.string().trim().max(200).optional(),
  siteId: z.string().min(1).optional(),
  contractType: z.enum(["JOYO", "UKEOI"]).default("JOYO"),
  // v3: 請負(UKEOI)の請負金額（税抜・正の整数）。請求は「○月委託料 数量1 単価=金額」。
  // JOYO 時は無し。下の superRefine で contractType との整合を強制する。
  contractAmount: z.number().int().positive().max(1_000_000_000).optional(),
  entries: z.array(entrySchema).min(1, "出面が1件もありません。職人を1人以上入力してください。"),
  expenses: z.array(expenseSchema).optional(),
  // 任意: 二重送信防止の冪等キー（クライアント生成）。同一キーの再POSTは
  // 既存レポートを返し、新規作成しない（リトライ/連打の安全網）。
  clientRequestId: z.string().trim().min(1).max(100).optional(),
}).superRefine((v, ctx) => {
  // 請負金額は UKEOI 専用。JOYO に金額が付いていたら弾く（誤入力の遮断）。
  if (v.contractType === "JOYO" && v.contractAmount !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contractAmount"],
      message: "請負金額は請負（UKEOI）のときだけ指定できます。",
    });
  }
  // 請負(UKEOI)は請負金額が必須。無いと請求時に明細なし/0円になるのを防ぐ。
  if (
    v.contractType === "UKEOI" &&
    (v.contractAmount === undefined || v.contractAmount <= 0)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contractAmount"],
      message: "請負（UKEOI）のときは請負金額（1円以上）を入力してください。",
    });
  }
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

  // 無効化された組織のユーザーは送信不可（古い LIFF / 直叩き対策）。
  if (!org.active) {
    return json(403, {
      ok: false,
      error: "org_disabled",
      message: "所属組織が無効化されています。管理者にご確認ください。",
    });
  }

  // ── 3a) ボディ検証（zod）──
  let body: Body;
  try {
    const raw = await req.json();
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      // 先頭の検証エラー文を人が読めるメッセージとして返す（「invalid_body だけ」を避ける）。
      const firstMsg =
        parsed.error.issues.find((i) => i.message)?.message ??
        "入力内容に誤りがあります。もう一度ご確認ください。";
      return json(400, {
        ok: false,
        error: "invalid_body",
        message: firstMsg,
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

  // 参照整合性: clientId / siteId / workerId が DB に存在し、かつ有効(active)か。
  const client = await prisma.client.findFirst({
    where: { id: body.clientId, active: true },
    select: { id: true, name: true },
  });
  if (!client) {
    return json(400, {
      ok: false,
      error: "client_not_found",
      message: "取引先が見つからないか、無効化されています。",
    });
  }

  // v3: 現場は自由入力（Report.siteName）に一本化。現場マスタ自動作成はしない。
  // siteId は基本 null。過去クライアント互換で siteId が来た場合のみ存在確認して
  // 紐付ける（無ければ無視＝siteName だけで保存し、出面自体は通す）。
  let site: { id: string; name: string } | null = null;
  if (body.siteId) {
    site = await prisma.site.findFirst({
      where: { id: body.siteId, clientId: body.clientId },
      select: { id: true, name: true },
    });
  }

  // 保存・投稿・検証に使う現場表記。siteName（自由入力）を最優先。
  // 互換で来た siteId が解決できた場合のみその名前にフォールバック。空文字可。
  const siteName = (body.siteName ?? site?.name ?? "").trim();

  const workerIds = body.entries.map((e) => e.workerId);
  const workers = await prisma.worker.findMany({
    where: { id: { in: workerIds }, orgId: org.id, active: true },
    select: { id: true, name: true },
  });
  const workerById = new Map(workers.map((w) => [w.id, w]));
  const missingWorker = workerIds.find((id) => !workerById.has(id));
  if (missingWorker) {
    return json(400, {
      ok: false,
      error: "worker_not_found",
      message: "職人が見つからないか、無効化されています。",
    });
  }

  // ── 3b) 聞き返し判定（@/lib/validate）──
  // 構造化入力なので取引先/職人は確定。日付・人工・残業・重複を精査する。
  const refDate = new Date();
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
  // 現場は自由入力（Report.siteName）なので、新規現場ゲートは設けない。
  const status = report.status === "confirm" ? "NEEDS_REVIEW" : "CONFIRMED";

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
        // v3: 現場は自由入力。空文字は null として保存（未記入と区別しやすく）。
        siteName: siteName || null,
        contractType: body.contractType,
        // v3: 請負(UKEOI)のみ請負金額を保存。常用(JOYO)は null。
        // 上の superRefine で JOYO×contractAmount は弾いているので二重ガード。
        contractAmount:
          body.contractType === "UKEOI"
            ? (body.contractAmount ?? null)
            : null,
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
        // site 関係は v3 では投稿に使わない（現場は scalar の siteName を使う）。
        // siteName / contractAmount は scalar なので include 無しで返る。
        entries: { include: { worker: { select: { name: true } } } },
        expenses: { select: { kind: true, amount: true } },
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

  // 新規出面が増えたので、管理ダッシュボードの月次集計キャッシュを無効化。
  revalidateTag("reports");

  // 現場の利用統計を更新（LIFFの「最近使った/よく使う」並び順用）。失敗は無視（保存は確定済み）。
  if (site) {
    try {
      await prisma.site.update({
        where: { id: site.id },
        data: { usageCount: { increment: 1 }, lastUsedAt: dayStart },
      });
    } catch (e) {
      console.error("[reports] site usage update failed", e);
    }
  }

  // ── 5) ★2系統ルーティング（org.kind で1分岐）★ ──
  let postedToGroup = false;
  if (org.kind === "SELF") {
    // 自社 → 出面グループへ整形ログ投稿。
    try {
      // v3: 現場表記は自由入力（Report.siteName）を使う（現場マスタ名ではない）。
      // 請負(UKEOI)は請負金額が分かるよう現場行に「（請負 ¥1,234,000）」を併記する。
      // 空なら null を渡し、formatReportLog 側の「(現場未設定)」表記に委ねる。
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

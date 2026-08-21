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
import {
  bearerToken,
  requireApproved,
  resolveUserFromAccessToken,
} from "@/lib/auth.js";
import { createReportCore } from "@/lib/reportCreate.js";

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
  // 立替えた人の名前（立替集計用・任意）。
  paidBy: z.string().trim().max(50).optional(),
  // 領収書写真（/api/receipts が返した ReceiptImage.id・任意）。
  // 形式は isValidReceiptId、所有権（自組織の画像か）は保存前に DB で検証する。
  receiptPath: z.string().trim().max(64).optional(),
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
  // ※ 請負金額はフォームからは送らず、管理側で入力・管理する運用（API は optional 受理）。
  if (v.contractType === "JOYO" && v.contractAmount !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contractAmount"],
      message: "請負金額は請負（UKEOI）のときだけ指定できます。",
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

  // ── 4〜6) 作成本体（正本は @/lib/reportCreate）──
  const result = await createReportCore(
    {
      workDate: body.workDate,
      clientId: body.clientId,
      siteName: body.siteName,
      siteId: body.siteId,
      contractType: body.contractType,
      contractAmount: body.contractAmount,
      entries: body.entries,
      expenses: body.expenses,
      clientRequestId: body.clientRequestId,
    },
    {
      orgId: org.id,
      orgKind: org.kind,
      createdById: user.id,
      createdByName: user.displayName,
      // postToGroup は渡さない＝org.kind による既存の自動判定を維持。
    },
  );

  if (!result.ok) {
    if (result.kind === "hold") {
      return json(422, { ok: false, status: "hold", message: result.message });
    }
    if (result.kind === "conflict") {
      return json(409, { ok: false, error: "request_id_conflict" });
    }
    return json(400, { ok: false, error: result.kind, message: result.message });
  }

  return json(200, {
    ok: true,
    reportId: result.reportId,
    status: result.status,
    postedToGroup: result.postedToGroup,
    deduped: result.deduped,
    askback: result.askback,
  });
}

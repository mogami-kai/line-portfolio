// ============================================================
// LINE 連携ヘルパー（SDK 非依存・fetch のみ）
//   - pushToGroup     : Messaging API push で出面グループへ整形ログ投稿
//   - getProfile      : LIFF アクセストークン → LINE プロフィール
//   - verifyAccessToken: LIFF アクセストークンの検証（チャネル一致確認）
//   - formatReportLog : v1 bot 受信確認フォーマットのログ文面生成
//
// 秘匿値はすべて process.env から。クライアントには焼かない。
// ============================================================

import type { ContractType, Shift } from "@prisma/client";

const LINE_API = "https://api.line.me";

/** Messaging API のチャネルアクセストークン（push 用）。 */
function channelAccessToken(): string {
  const t = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!t) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not set");
  return t;
}

// ============================================================
// push: 出面グループへテキスト投稿
//   to = LINE_GROUP_ID（出面グループ）
// ============================================================
export async function pushToGroup(text: string): Promise<void> {
  const to = process.env.LINE_GROUP_ID;
  if (!to) {
    // グループ未設定でも入力フロー自体は失敗させない（ログのみ）。
    console.warn("[line] LINE_GROUP_ID is not set; skip pushToGroup");
    return;
  }

  const res = await fetch(`${LINE_API}/v2/bot/message/push`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${channelAccessToken()}`,
    },
    body: JSON.stringify({
      to,
      messages: [{ type: "text", text }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LINE push failed: ${res.status} ${body}`);
  }
}

// ============================================================
// LIFF アクセストークン → プロフィール
//   GET /v2/profile （Bearer = LIFF access token）
// ============================================================
export interface LineProfile {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  statusMessage?: string;
}

export async function getProfile(accessToken: string): Promise<LineProfile> {
  const res = await fetch(`${LINE_API}/v2/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LINE getProfile failed: ${res.status} ${body}`);
  }
  return (await res.json()) as LineProfile;
}

// ============================================================
// LIFF アクセストークンの検証
//   GET https://api.line.me/oauth2/v2.1/verify?access_token=...
//   client_id が LINE_CHANNEL_ID と一致するか確認し、なりすましを防ぐ。
//   検証 OK ならプロフィールを取得して lineUserId を解決する。
// ============================================================
export interface VerifyResult {
  /** トークン発行先チャネル（LINE Login チャネル）の ID。 */
  clientId: string;
  /** 残り有効秒数。 */
  expiresIn: number;
  scope: string;
}

export async function verifyAccessToken(
  accessToken: string,
): Promise<VerifyResult> {
  const url = new URL(`${LINE_API}/oauth2/v2.1/verify`);
  url.searchParams.set("access_token", accessToken);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LINE verify failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as {
    client_id: string;
    expires_in: number;
    scope: string;
  };
  return {
    clientId: json.client_id,
    expiresIn: json.expires_in,
    scope: json.scope,
  };
}

/**
 * LIFF アクセストークンから lineUserId を解決する。
 *  1) /oauth2/v2.1/verify でトークンが自社 LINE_CHANNEL_ID 宛か検証
 *  2) /v2/profile で userId / displayName を取得
 * 検証に失敗（チャネル不一致・期限切れ等）した場合は null。
 */
export async function resolveLineUserFromToken(
  accessToken: string,
): Promise<{ lineUserId: string; displayName: string } | null> {
  try {
    const verified = await verifyAccessToken(accessToken);
    const expectedChannel = process.env.LINE_CHANNEL_ID;
    // LINE_CHANNEL_ID が設定されている場合のみチャネル一致を強制する。
    if (expectedChannel && verified.clientId !== expectedChannel) {
      console.warn(
        `[line] token channel mismatch: got ${verified.clientId}, expected ${expectedChannel}`,
      );
      return null;
    }
    if (verified.expiresIn <= 0) return null;
    const profile = await getProfile(accessToken);
    if (!profile?.userId) return null;
    return { lineUserId: profile.userId, displayName: profile.displayName };
  } catch (e) {
    console.warn("[line] resolveLineUserFromToken error", e);
    return null;
  }
}

// ============================================================
// 受信確認ログ（v1 bot フォーマット踏襲）
//   日付 / 取引先 / 現場 / 職人ごとの 人工・残業
// ============================================================
const SHIFT_LABEL: Record<Shift, string> = {
  DAY: "日勤",
  HALF: "半日",
  NIGHT: "夜勤",
};

const CONTRACT_LABEL: Record<ContractType, string> = {
  JOYO: "常用",
  UKEOI: "請負",
};

/** formatReportLog に渡す最小形（Prisma の Report + relations を満たす）。 */
export interface ReportLogInput {
  workDate: Date | string;
  contractType: ContractType;
  client: { name: string };
  site: { name: string } | null;
  entries: Array<{
    shift: Shift;
    manDays: number;
    otHours: number;
    worker: { name: string };
  }>;
}

function fmtDate(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

/** 出面グループ投稿用のテキストを生成（v1 受信確認フォーマット）。 */
export function formatReportLog(report: ReportLogInput): string {
  const lines: string[] = [];
  lines.push("【出面記録】受信しました");
  lines.push(`日付：${fmtDate(report.workDate)}`);
  lines.push(`取引先：${report.client.name}`);
  lines.push(`現場：${report.site?.name ?? "(現場未設定)"}`);
  lines.push(`契約：${CONTRACT_LABEL[report.contractType]}`);
  lines.push("―――――――――――");

  let totalMd = 0;
  let totalOt = 0;
  for (const e of report.entries) {
    totalMd += Number(e.manDays) || 0;
    totalOt += Number(e.otHours) || 0;
    const parts = [`・${e.worker.name}`, `${e.manDays}人工`];
    if (e.shift !== "DAY") parts.push(`(${SHIFT_LABEL[e.shift]})`);
    if (Number(e.otHours) > 0) parts.push(`残業${e.otHours}h`);
    lines.push(parts.join(" "));
  }

  lines.push("―――――――――――");
  const totalLine = [`合計 ${totalMd}人工`];
  if (totalOt > 0) totalLine.push(`残業${totalOt}h`);
  lines.push(totalLine.join(" / "));

  return lines.join("\n");
}

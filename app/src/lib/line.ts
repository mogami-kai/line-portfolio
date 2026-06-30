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
    // 宛先の種別だけ添える（C…=グループ / R…=トークルーム / U…=ユーザー）。
    // 「グループID のはずが U… 」なら LINE_GROUP_ID の設定ミス。フルIDはログに出さない。
    const head = to[0];
    const kind =
      head === "C" ? "group(C)" : head === "R" ? "room(R)" : head === "U" ? "user(U)" : `other(${head})`;
    throw new Error(
      `LINE push failed: ${res.status} to=${kind} len=${to.length} body=${body}`,
    );
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
    // verify と profile は互いに独立な GET。直列だと East/Tokyo 間で 2 往復になり
    // /api/masters・/api/reports の待ち時間に直結するため、並列実行で 1 往復に短縮。
    // verify がチャネル不一致/期限切れなら profile は破棄する。
    const [verified, profile] = await Promise.all([
      verifyAccessToken(accessToken),
      getProfile(accessToken),
    ]);
    // LIFF はこの LINE Login チャネルに属する。期待チャネルは LINE_LOGIN_CHANNEL_ID
    // を優先（無ければ旧名 LINE_CHANNEL_ID にフォールバック）。設定時のみ一致を強制。
    const expectedChannel =
      process.env.LINE_LOGIN_CHANNEL_ID || process.env.LINE_CHANNEL_ID;
    if (expectedChannel && verified.clientId !== expectedChannel) {
      console.warn(
        `[line] token channel mismatch: got ${verified.clientId}, expected ${expectedChannel}`,
      );
      return null;
    }
    if (verified.expiresIn <= 0) return null;
    if (!profile?.userId) return null;
    return { lineUserId: profile.userId, displayName: profile.displayName };
  } catch (e) {
    console.warn("[line] resolveLineUserFromToken error", e);
    return null;
  }
}

// ============================================================
// LINE Login（OAuth 2.0 / Authorization Code）— 管理画面ログイン用
//   1) buildLoginUrl  : 認可エンドポイントへのリダイレクト URL を作る（state 付き）
//   2) exchangeCode   : code → access_token（/oauth2/v2.1/token）
//   3) getProfile     : access_token → プロフィール（lineUserId/displayName）
//
//   LINE Login チャネルの ID/SECRET を使う（Messaging API とは別チャネル）。
//   env が無ければ LINE_CHANNEL_ID/SECRET にフォールバック（DEPLOY.md 参照）。
// ============================================================

/** LINE Login チャネル ID（無ければ LINE_CHANNEL_ID にフォールバック）。 */
export function loginChannelId(): string {
  const id = process.env.LINE_LOGIN_CHANNEL_ID || process.env.LINE_CHANNEL_ID;
  if (!id) throw new Error("LINE_LOGIN_CHANNEL_ID (or LINE_CHANNEL_ID) is not set");
  return id;
}

/** LINE Login チャネル SECRET（無ければ LINE_CHANNEL_SECRET にフォールバック）。 */
export function loginChannelSecret(): string {
  const s =
    process.env.LINE_LOGIN_CHANNEL_SECRET || process.env.LINE_CHANNEL_SECRET;
  if (!s)
    throw new Error("LINE_LOGIN_CHANNEL_SECRET (or LINE_CHANNEL_SECRET) is not set");
  return s;
}

/** 管理ログインのコールバック URL（env で固定）。 */
export function adminRedirectUrl(): string {
  const u = process.env.ADMIN_LOGIN_REDIRECT_URL;
  if (!u) throw new Error("ADMIN_LOGIN_REDIRECT_URL is not set");
  return u;
}

/** 認可リクエスト URL（state/nonce は CSRF 対策に呼び出し側で生成）。 */
export function buildLoginUrl(state: string, nonce?: string): string {
  const url = new URL("https://access.line.me/oauth2/v2.1/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", loginChannelId());
  url.searchParams.set("redirect_uri", adminRedirectUrl());
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "openid profile");
  if (nonce) url.searchParams.set("nonce", nonce);
  return url.toString();
}

/** authorization code → access_token を交換する。失敗時 null。 */
export async function exchangeCode(
  code: string,
): Promise<{ accessToken: string; idToken?: string } | null> {
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: adminRedirectUrl(),
      client_id: loginChannelId(),
      client_secret: loginChannelSecret(),
    });
    const res = await fetch(`${LINE_API}/oauth2/v2.1/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn(`[line] token exchange failed: ${res.status} ${t}`);
      return null;
    }
    const json = (await res.json()) as {
      access_token: string;
      id_token?: string;
    };
    if (!json.access_token) return null;
    return { accessToken: json.access_token, idToken: json.id_token };
  } catch (e) {
    console.warn("[line] exchangeCode error", e);
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
  /** 立替経費（任意）。グループ投稿に「パーキング800円」等で併記する。 */
  expenses?: Array<{ kind: string; amount: number }>;
}

/** 曜日。workDate は UTC 0時保存なので UTC で読む（TZズレで前日/翌日にならないように）。 */
const WEEKDAY_JP = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** "M月D日(曜)"。workDate は UTC 0時のため UTC メソッドで読む。 */
function fmtDateJp(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return `${dt.getUTCMonth() + 1}月${dt.getUTCDate()}日(${WEEKDAY_JP[dt.getUTCDay()]})`;
}

/**
 * 出面グループ投稿用テキスト（実運用ログのフォーマット踏襲）:
 *   1行目: 日付(曜)
 *   2行目: 取引先　契約（常用/請負）
 *   3行目: 現場
 *   4行目: 職人（半日/夜勤/残業を各人に「（…）」で注記。日勤は無印）
 *   5行目: 経費（あれば「パーキング800円」等を併記）
 */
export function formatReportLog(report: ReportLogInput): string {
  const lines: string[] = [];
  lines.push(fmtDateJp(report.workDate));
  lines.push(`${report.client.name}　${CONTRACT_LABEL[report.contractType]}`);
  lines.push(report.site?.name ?? "(現場未設定)");

  const workerTokens = report.entries.map((e) => {
    const notes: string[] = [];
    if (e.shift !== "DAY") notes.push(SHIFT_LABEL[e.shift]); // 半日 / 夜勤
    if (Number(e.otHours) > 0) notes.push(`残${e.otHours}h`);
    return notes.length
      ? `${e.worker.name}（${notes.join("・")}）`
      : e.worker.name;
  });
  lines.push(workerTokens.join("　"));

  if (report.expenses?.length) {
    lines.push(report.expenses.map((x) => `${x.kind}${x.amount}円`).join("　"));
  }

  return lines.join("\n");
}

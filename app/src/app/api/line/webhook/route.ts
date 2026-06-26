// ============================================================
// POST /api/line/webhook — LINE Messaging API Webhook
//
//   - x-line-signature を HMAC-SHA256(LINE_CHANNEL_SECRET, rawBody) base64 で検証。
//   - イベントを軽く処理して即 200 を返す（LINE は素早い 200 応答を要求）。
//   - 重要: source.groupId をログ出力 → 管理者が LINE_GROUP_ID を採取できる。
//   - join / follow は受領のみ（応答返信は将来拡張）。
//
//   署名検証のため raw body をそのまま読む（req.text()）。
// ============================================================

import crypto from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface LineEventSource {
  type?: string;
  userId?: string;
  groupId?: string;
  roomId?: string;
}

interface LineEvent {
  type: string;
  source?: LineEventSource;
  message?: { type?: string; text?: string };
  replyToken?: string;
}

/** 署名検証: base64(HMAC-SHA256(channelSecret, rawBody)) === x-line-signature。 */
function verifySignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) {
    console.warn("[webhook] LINE_CHANNEL_SECRET not set; rejecting");
    return false;
  }
  if (!signature) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  // タイミング安全比較（長さ不一致は即 false）。
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  // 署名検証のため raw text を読む。
  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature");

  if (!verifySignature(rawBody, signature)) {
    return NextResponse.json({ ok: false, error: "bad_signature" }, { status: 401 });
  }

  let payload: { events?: LineEvent[] };
  try {
    payload = JSON.parse(rawBody) as { events?: LineEvent[] };
  } catch {
    // 不正 JSON でも 200（LINE 側のリトライ抑止）。
    return NextResponse.json({ ok: true });
  }

  const events = payload.events ?? [];
  for (const ev of events) {
    const src = ev.source ?? {};
    // ★ グループ ID を採取できるようログ出力（管理者が LINE_GROUP_ID を控える）。
    if (src.groupId) {
      console.log(
        `[webhook] event=${ev.type} groupId=${src.groupId} (← これを LINE_GROUP_ID に設定)`,
      );
    } else {
      console.log(
        `[webhook] event=${ev.type} sourceType=${src.type ?? "?"} userId=${src.userId ?? "-"}`,
      );
    }

    switch (ev.type) {
      case "join":
        // bot がグループ/ルームに参加 → groupId を採取（LINE_GROUP_ID 設定用）。
        console.log(
          `[webhook] joined ${src.type ?? "group"}: groupId=${
            src.groupId ?? "-"
          } roomId=${src.roomId ?? "-"}`,
        );
        break;
      case "follow":
        // 友だち追加 → 初回ユーザー。ここでは登録/応答せず即 200 を優先。
        // ユーザー作成・ロール付与は LIFF 初回オープン時 or 管理画面の承認で行う。
        console.log(`[webhook] followed by user: ${src.userId ?? "-"}`);
        break;
      case "unfollow":
        console.log(`[webhook] unfollowed by user: ${src.userId ?? "-"}`);
        break;
      case "message":
        // 当面はメッセージに自動応答しない（LIFF 入力に一本化）。
        // ただしグループからのメッセージなら groupId を採取できるようログする。
        if (src.groupId) {
          console.log(
            `[webhook] group message: groupId=${src.groupId} (← LINE_GROUP_ID 候補)`,
          );
        }
        break;
      default:
        break;
    }
  }

  // 速やかに 200。
  return NextResponse.json({ ok: true });
}

// GET は疎通確認用（LINE の Verify ボタンは POST だが、ブラウザ確認向けに 200）。
export async function GET() {
  return NextResponse.json({ ok: true, service: "line-webhook" });
}

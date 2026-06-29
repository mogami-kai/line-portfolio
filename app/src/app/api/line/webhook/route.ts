// ============================================================
// POST /api/line/webhook — LINE Messaging API Webhook
//
//   - x-line-signature を HMAC-SHA256(Messaging APIチャネルのsecret, rawBody) base64 で検証。
//     secret は LINE_MESSAGING_CHANNEL_SECRET（無ければ LINE_CHANNEL_SECRET にフォールバック）。
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
  // Messaging API チャネル（出面bot）の secret。LIFF/管理ログインの LINE_CHANNEL_SECRET
  // とは別チャネルなので専用変数を優先。後方互換で LINE_CHANNEL_SECRET にフォールバック。
  const secret =
    process.env.LINE_MESSAGING_CHANNEL_SECRET || process.env.LINE_CHANNEL_SECRET;
  if (!secret) {
    console.warn(
      "[webhook] LINE_MESSAGING_CHANNEL_SECRET / LINE_CHANNEL_SECRET not set; rejecting",
    );
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

// 取得用: 直近に観測した groupId を保持（GET で確認できる）。
const seenGroupIds: string[] = [];

async function replyText(replyToken: string, text: string) {
  const token = process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN || process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.warn("[webhook] no access token");
    return;
  }
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
  if (!res.ok) {
    console.error(`[webhook] reply failed: ${res.status} ${await res.text()}`);
  }
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
    return NextResponse.json({ ok: true });
  }

  const events = payload.events ?? [];
  for (const ev of events) {
    const src = ev.source ?? {};
    if (src.groupId) {
      console.log(`[webhook] event=${ev.type} groupId=${src.groupId}`);
      if (!seenGroupIds.includes(src.groupId)) seenGroupIds.unshift(src.groupId);
    }

    switch (ev.type) {
      case "join":
        if (src.groupId && ev.replyToken) {
          await replyText(ev.replyToken, `[GROUP ID取得用]\nこのグループのIDは:\n${src.groupId}`);
        }
        break;
      case "message":
        if (src.groupId && ev.replyToken) {
          await replyText(ev.replyToken, `[GROUP ID取得用]\nこのグループのIDは:\n${src.groupId}`);
        }
        break;
      default:
        break;
    }
  }

  return NextResponse.json({ ok: true });
}

// GET は疎通確認用 + 取得した groupId 確認用。
export async function GET() {
  return NextResponse.json({ ok: true, service: "line-webhook", seenGroupIds });
}

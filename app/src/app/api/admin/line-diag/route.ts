// ============================================================
// GET /api/admin/line-diag — 管理者用：グループ投稿(push)の不調を切り分ける診断。
//
//   グループ投稿が 400「Failed to send messages」で失敗するとき、原因は次のどれか:
//     (a) LINE_GROUP_ID の値違い（グループIDのはずが U…=ユーザーID 等）
//     (b) LINE_CHANNEL_ACCESS_TOKEN が「その bot がいるグループ」と別チャネルのもの
//     (c) その bot が対象グループにいない（参加していない）
//   これを断定するため、トークンの bot 情報と、その bot が LINE_GROUP_ID の
//   グループにいるか（group summary）を LINE API に問い合わせて返す。
//
//   ※ 管理者のみ（getAdminContext ＋ middleware）。トークン本体は返さない（長さのみ）。
//   ※ 結果は console.log("[line-diag]", ...) にも出すので Vercel ログから確認できる。
// ============================================================

import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LINE_API = "https://api.line.me";

function groupIdKind(id: string): string {
  if (!id) return "none";
  const h = id[0];
  return h === "C"
    ? "group(C)"
    : h === "R"
      ? "room(R)"
      : h === "U"
        ? "user(U)"
        : `other(${h})`;
}

export async function GET() {
  const admin = await getAdminContext();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const token = (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
  const groupId = (process.env.LINE_GROUP_ID || "").trim();

  const out: Record<string, unknown> = {
    env: {
      hasToken: Boolean(token),
      tokenLen: token.length,
      hasGroupId: Boolean(groupId),
      groupIdKind: groupIdKind(groupId),
      groupIdLen: groupId.length,
      // 末尾に空白/改行が混入していないかの簡易チェック。
      groupIdTrimmedEqualsRaw: groupId === (process.env.LINE_GROUP_ID || ""),
    },
  };

  // 1) bot info … このトークンがどの LINE公式アカウント(チャネル)のものか。
  //    displayName / basicId を見れば「グループに入れた bot と同じか」を確認できる。
  if (token) {
    try {
      const r = await fetch(`${LINE_API}/v2/bot/info`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      out.botInfo = { status: r.status, body: await r.json().catch(() => ({})) };
    } catch (e) {
      out.botInfo = { error: String(e) };
    }
  } else {
    out.botInfo = { skipped: "LINE_CHANNEL_ACCESS_TOKEN 未設定" };
  }

  // 2) group summary … そのトークンの bot が LINE_GROUP_ID のグループにいるか。
  //    200＋groupName が返れば bot は在席（push できるはず）。404/400 なら未在席か groupId 違い。
  if (token && groupId) {
    try {
      const r = await fetch(
        `${LINE_API}/v2/bot/group/${encodeURIComponent(groupId)}/summary`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      out.groupSummary = {
        status: r.status,
        body: await r.json().catch(() => ({})),
      };
    } catch (e) {
      out.groupSummary = { error: String(e) };
    }
  } else {
    out.groupSummary = { skipped: "token か groupId が未設定" };
  }

  console.log("[line-diag]", JSON.stringify(out));
  return NextResponse.json({ ok: true, ...out });
}

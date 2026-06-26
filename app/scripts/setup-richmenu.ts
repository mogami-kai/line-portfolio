// ============================================================
// scripts/setup-richmenu.ts — 自社リッチメニュー作成（LINE Messaging API）
//
//   友だち追加した各メンバーの「1対1トーク」に「日報入力」入口を出す。
//   ※ リッチメニューは1対1のみ表示（LINE 仕様）。グループには出ない＝
//     パートナーには自社メニューが見えない（要件の不可視性と整合）。
//   ※ パートナーには別途パートナー専用 LIFF リンクを個別配布（メニューに載せない）。
//
//   実行（app/ で）:
//     LINE_CHANNEL_ACCESS_TOKEN=xxx \
//     LIFF_URL="https://liff.line.me/<LIFF_ID>" \
//     [RICHMENU_IMAGE=./richmenu.png] \
//     npx tsx scripts/setup-richmenu.ts
//
//   省略可能な env:
//     NEXT_PUBLIC_LIFF_ID … LIFF_URL 未指定時に https://liff.line.me/<ID> を組み立て。
//     RICHMENU_IMAGE      … 2500x1686 もしくは 2500x843 の PNG/JPEG。未指定なら
//                            生成のみ（画像未設定。後で Console から画像を貼れる）。
//
//   行う処理:
//     1) リッチメニュー定義を作成（POST /v2/bot/richmenu）→ richMenuId
//     2) 画像があればアップロード（POST /v2/bot/richmenu/{id}/content）
//     3) 既定メニューに設定（POST /v2/bot/user/all/richmenu/{id}）
//   依存ゼロ（fetch / node:fs のみ）。
// ============================================================

import { readFile } from "node:fs/promises";

const API = "https://api.line.me";
const API_DATA = "https://api-data.line.me";

function token(): string {
  const t = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!t) {
    throw new Error("LINE_CHANNEL_ACCESS_TOKEN が未設定です。");
  }
  return t;
}

function liffUrl(): string {
  const direct = process.env.LIFF_URL;
  if (direct) return direct;
  const id = process.env.NEXT_PUBLIC_LIFF_ID;
  if (id) return `https://liff.line.me/${id}`;
  throw new Error(
    "LIFF_URL（または NEXT_PUBLIC_LIFF_ID）が未設定です。日報入力の遷移先 URL が必要です。",
  );
}

// 幅2500・高さ843（1行レイアウト）。全面を「日報入力」(LIFF)に割り当てる。
function richMenuDefinition(url: string) {
  return {
    size: { width: 2500, height: 843 },
    selected: true,
    name: "自社メニュー（日報入力）",
    chatBarText: "メニュー",
    areas: [
      {
        bounds: { x: 0, y: 0, width: 2500, height: 843 },
        action: { type: "uri", label: "日報入力", uri: url },
      },
    ],
  };
}

async function createRichMenu(def: unknown): Promise<string> {
  const res = await fetch(`${API}/v2/bot/richmenu`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token()}`,
    },
    body: JSON.stringify(def),
  });
  if (!res.ok) {
    throw new Error(`richmenu 作成失敗: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { richMenuId: string };
  return json.richMenuId;
}

async function uploadImage(richMenuId: string, path: string): Promise<void> {
  const buf = await readFile(path);
  const contentType = path.toLowerCase().endsWith(".jpg") || path.toLowerCase().endsWith(".jpeg")
    ? "image/jpeg"
    : "image/png";
  const res = await fetch(
    `${API_DATA}/v2/bot/richmenu/${richMenuId}/content`,
    {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        Authorization: `Bearer ${token()}`,
      },
      body: new Uint8Array(buf),
    },
  );
  if (!res.ok) {
    throw new Error(`画像アップロード失敗: ${res.status} ${await res.text()}`);
  }
}

async function setDefault(richMenuId: string): Promise<void> {
  const res = await fetch(`${API}/v2/bot/user/all/richmenu/${richMenuId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (!res.ok) {
    throw new Error(`既定メニュー設定失敗: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  const url = liffUrl();
  console.log("[richmenu] LIFF URL:", url);

  const richMenuId = await createRichMenu(richMenuDefinition(url));
  console.log("[richmenu] 作成: richMenuId =", richMenuId);

  const imagePath = process.env.RICHMENU_IMAGE;
  if (imagePath) {
    await uploadImage(richMenuId, imagePath);
    console.log("[richmenu] 画像アップロード完了:", imagePath);
    await setDefault(richMenuId);
    console.log("[richmenu] 既定メニューに設定しました（全ユーザーの1対1に表示）。");
  } else {
    console.log(
      "[richmenu] 画像未指定のため作成のみ。\n" +
        "  次のいずれかで画像を設定してください:\n" +
        `  - RICHMENU_IMAGE=./richmenu.png を付けて再実行（または個別に content API へ PUT）\n` +
        "  - LINE Official Account Manager / Developers Console から画像を貼付\n" +
        `  画像設定後に既定化: POST ${API}/v2/bot/user/all/richmenu/${richMenuId}`,
    );
  }

  console.log("[richmenu] 完了。");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

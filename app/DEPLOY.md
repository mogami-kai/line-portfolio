# デプロイ手順 ＆「あなたにしかできない作業」

このアプリは **コードは完成**させてあるが、**外部サービスの認証情報・設定はオーナー本人（=あなた）しか作成/操作できない**。以下がその一覧と手順。

> 自動化済み（コード側）: 入力フォーム(LIFF)・送信API・2系統ルーティング・グループ投稿・集計・請求書(xlsx/CSV)・バリデーション・Prismaスキーマ。
> 手動（あなた）: 下記アカウント作成・キー発行・env設定・migrate・デプロイ・LINE設定・初期マスタ入力。

---

## 1. Supabase（DB）— あなたの作業

1. supabase.com でプロジェクト作成（リージョンは東京 `ap-northeast-1` 推奨）。
2. Project Settings → Database → Connection string から取得し `.env` に設定:
   - `DATABASE_URL`（**Transaction pooler** / port 6543 / `?pgbouncer=true`）
   - `DIRECT_URL`（**Direct** / port 5432。migrate 用）
3. スキーマ反映: `cd app && npx prisma migrate deploy`（初回は `npx prisma migrate dev --name init`）。

## 2. LINE（公式アカウント / Messaging API / LIFF）— あなたの作業

LINE Developers Console（developers.line.biz）で:

1. **Messaging API チャネル**（既存の出面botのものを流用可）:
   - `LINE_CHANNEL_ACCESS_TOKEN`（長期）→ `.env`
   - Webhook URL = `https://<your-vercel-domain>/api/line/webhook` を設定・Webhook利用ON。
2. **LINE Login チャネル**（LIFF用。同じProviderに作成）:
   - `LINE_CHANNEL_ID` / `LINE_CHANNEL_SECRET` → `.env`
3. **LIFF アプリ**を追加:
   - Endpoint URL = `https://<your-vercel-domain>/liff`
   - サイズ = Full、`openid profile` スコープ。
   - 発行された `LIFF ID` → `NEXT_PUBLIC_LIFF_ID`
4. **出面グループのID** `LINE_GROUP_ID`:
   - botをグループに入れて、webhookに来るイベントの `source.groupId` を控える → `.env`。
5. **リッチメニュー**（自社入力の入口。各メンバーがbotを友だち追加すると1対1に表示。※グループには出ない仕様）:
   - 画像＋「日報入力」領域 → action: URI = LIFF URL。
   - パートナーは**別のLIFFリンク**を個別配布（リッチメニューには載せない＝自社に見えない）。

## 3. Vercel（ホスティング）— あなたの作業

1. vercel.com で本リポジトリをImport。**Root Directory = `app`** に設定。
2. Environment Variables に `.env` の全項目を登録（`NEXT_PUBLIC_` 以外はSecret）。
3. Build Command = `prisma generate && next build`（既定でOK）。Deploy。
4. デプロイ後のドメインを、上記 LINE の Webhook / LIFF Endpoint に反映。

## 4. 初期マスタ入力（管理ダッシュボード or Supabase）— あなたの作業

- `InvoiceSetting`: 発行元名・住所・登録番号・**振込先**・税率（自社情報）。
- `Organization`: 自社（kind=SELF）＋パートナー各社（kind=PARTNER）。
- `User`: 管理者の `lineUserId` に role=ADMIN（`ADMIN_LINE_USER_IDS` で初期付与）。
- `Client`/`Site`/`RateCard`: 取引先・現場・単価。`aliases` に表記揺れ。
- `Worker`: 職人。
- 実取引先名・住所・口座・個人名は**ここ（DB）にだけ**入れる（コードには入れない）。

---

## ✅ あなたにしかできない作業 チェックリスト

- [ ] Supabase プロジェクト作成＋接続文字列を `.env`（`DATABASE_URL`/`DIRECT_URL`）
- [ ] `prisma migrate` 実行（スキーマ→DB）
- [ ] LINE Messaging API のアクセストークン取得＋Webhook URL設定
- [ ] LINE Login チャネル＋LIFFアプリ作成（`NEXT_PUBLIC_LIFF_ID`）
- [ ] 出面グループの `LINE_GROUP_ID` 取得
- [ ] リッチメニュー作成（自社入口）／パートナー用LIFFリンク配布
- [ ] Vercel に Import（Root=`app`）＋ env 登録＋デプロイ
- [ ] デプロイ後ドメインを LINE Webhook/LIFF に反映
- [ ] 初期マスタ入力（自社情報・取引先・単価・職人・管理者ロール）
- [ ] 自分のLINEで1往復テスト（自社入力→グループ投稿、パートナー入力→管理画面のみ）

> これらは外部アカウントの所有権・本人認証が必要で、サンドボックスからは実行不可。コードはすべて整っているので、上を順に埋めれば稼働する。

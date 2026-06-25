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
3. スキーマ反映（**初期マイグレーション `prisma/migrations/0_init/` を同梱済み**）。次のどちらかで適用:
   - **A. ローカルから（推奨・Prisma管理下に置く）**: `.env` に接続文字列を置いて `cd app && npx prisma migrate deploy`。
     `_prisma_migrations` に記録され、以後のスキーマ変更も `migrate dev`/`migrate deploy` で追える。
   - **B. ローカル環境なし（最短）**: Supabase ダッシュボード → **SQL Editor** に
     `app/prisma/migrations/0_init/migration.sql` の全文を貼って **Run**。これだけでテーブルが作られ、
     アプリは即動く（Prisma Client は実行時に接続するだけ）。後で Prisma 管理下に置きたくなったら
     ローカルで一度 `npx prisma migrate resolve --applied 0_init` を実行。
   - 初期データ（ダミー）投入（任意）: `npx prisma db seed`。
     ※ seed を流さなくても、初期 ADMIN は「`ADMIN_LINE_USER_IDS` に自分の userId を入れて LIFF を一度開く」だけで自動作成される。

## 2. LINE（公式アカウント / Messaging API / LIFF）— あなたの作業

LINE Developers Console（developers.line.biz）で:

1. **Messaging API チャネル**（既存の出面botのものを流用可）:
   - `LINE_CHANNEL_ACCESS_TOKEN`（長期）→ `.env`
   - Webhook URL = `https://<your-vercel-domain>/api/line/webhook` を設定・Webhook利用ON。
2. **LINE Login チャネル**（LIFF用。同じProviderに作成）:
   - `LINE_CHANNEL_ID` / `LINE_CHANNEL_SECRET` → `.env`
   - **管理画面ログインにも使用**（OAuth 認可コードフロー）。専用チャネルを分ける場合は
     `LINE_LOGIN_CHANNEL_ID` / `LINE_LOGIN_CHANNEL_SECRET` に設定（未設定なら上記を流用）。
   - **Callback URL** に `https://<your-vercel-domain>/api/auth/line/callback` を登録し、
     同じ値を `.env` の `ADMIN_LOGIN_REDIRECT_URL` にも設定（**完全一致**が必須）。
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

1. vercel.com で本リポジトリをImport。**Root Directory = `app`** に設定（`app/vercel.json` あり）。
2. Environment Variables に `.env` の全項目を登録（`NEXT_PUBLIC_` 以外はSecret）。
   - **必須追加**: `SESSION_SECRET`（32文字以上のランダム）, `ADMIN_LOGIN_REDIRECT_URL`。
     必要なら `LINE_LOGIN_CHANNEL_ID/SECRET`。
3. Build Command = `prisma generate && next build`（`vercel.json` で固定済み）。Deploy。
4. デプロイ後のドメインを、上記 LINE の Webhook / LIFF Endpoint / **Callback URL** に反映。

### 3-1. 管理画面ログイン（本人認証）

- `/admin` は **LINE Login → 署名付きクッキー（`demen_session`）** で保護。`src/middleware.ts` が
  `/admin/*`・`/api/invoices/*`・`/api/admin/*` をガードし、未ログインは `/admin`（ログイン画面）/ 401 に倒す。
- ログインを通すには、その LINE ユーザーが **承認済み・role=ADMIN の `User`** であること。
  初期 ADMIN は `ADMIN_LINE_USER_IDS` に lineUserId を入れ、その本人が一度 **LIFF を開く**と
  自動で role=ADMIN・approved=true で登録される（→ 以後 `/admin` からログイン可能）。
- セッションは **ステートレス**（DB を引かずクッキーの署名のみで検証）。失効は `SESSION_SECRET`
  ローテーション or TTL（既定7日）で行う。**`SESSION_SECRET` は必ず本番固有のランダム値**にすること。

### 3-2. リッチメニュー作成（自社入口・スクリプト）

`app/scripts/setup-richmenu.ts`（tsx 実行）で自社リッチメニューを作成・既定化できる:

```bash
cd app
LINE_CHANNEL_ACCESS_TOKEN=xxxxx \
LIFF_URL="https://liff.line.me/<LIFF_ID>" \
RICHMENU_IMAGE=./richmenu.png \   # 任意（2500x843 等）。省略時は作成のみ
npx tsx scripts/setup-richmenu.ts
```

- 全面を「日報入力」(LIFF) に割り当て。リッチメニューは1対1のみ表示＝**グループ/パートナーには出ない**。
- パートナーには**別の LIFF リンク**を個別配布（メニューには載せない）。

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
- [ ] スキーマ反映（同梱の `0_init` を `prisma migrate deploy` で適用、または SQL Editor に貼る）＋（任意）`prisma db seed`
- [ ] LINE Messaging API のアクセストークン取得＋Webhook URL設定
- [ ] LINE Login チャネル＋LIFFアプリ作成（`NEXT_PUBLIC_LIFF_ID`）
- [ ] **管理ログイン用 Callback URL 登録**（`/api/auth/line/callback`）＋ `ADMIN_LOGIN_REDIRECT_URL`
- [ ] **`SESSION_SECRET`（本番固有のランダム値）を発行・登録**
- [ ] 出面グループの `LINE_GROUP_ID` 取得
- [ ] リッチメニュー作成（`scripts/setup-richmenu.ts`）／パートナー用LIFFリンク配布
- [ ] Vercel に Import（Root=`app`）＋ env 登録＋デプロイ
- [ ] デプロイ後ドメインを LINE Webhook/LIFF/Callback に反映
- [ ] 初期 ADMIN（`ADMIN_LINE_USER_IDS`）が一度 LIFF を開く → `/admin` からログインできるか確認
- [ ] 初期マスタ入力（管理画面 `/admin/masters`: 自社情報・取引先・単価・職人・組織・請負金額）
- [ ] 未承認ユーザーを `/admin/users` で承認（パートナーは PARTNER 組織へ）
- [ ] 自分のLINEで1往復テスト（自社入力→グループ投稿、パートナー入力→管理画面のみ）

> これらは外部アカウントの所有権・本人認証が必要で、サンドボックスからは実行不可。コードはすべて整っているので、上を順に埋めれば稼働する。

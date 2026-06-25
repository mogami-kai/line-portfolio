# 出面管理アプリ（Next.js / Supabase / Prisma / LIFF）

要件定義は[リポジトリ直下 `REQUIREMENTS.md`（v2）](../REQUIREMENTS.md)。
入力（LIFF）→ DB（Supabase）→ 集計 → 取引先ごとの請求書（xlsx/CSV）まで一貫。

## 2系統ルーティング（要点）

所属 org からサーバが自動判定（本人は選ばない）。自社にパートナーを意識させない。

- **SELF（自社）** … 保存 ＋ Messaging API で出面グループへログ投稿
- **PARTNER（協力）** … 保存のみ・グループ非投稿。管理ダッシュボードのみ集約閲覧
- パートナー追加＝`Organization(kind=PARTNER)` を足してエントリリンクを渡すだけ

## 管理画面の認証（本人認証）

- `/admin` は **LINE Login（OAuthコード）→ 署名付きクッキー `demen_session`**（`node:crypto` HMAC）で保護。
- `src/middleware.ts` が `/admin/*`・`/api/invoices/*`・`/api/admin/*` をガード（未ログイン→ログイン画面 / 401）。
  クッキーは Web Crypto で検証（Edge 互換）。各ページ/ハンドラは `getAdminContext()` で
  **DB 上の承認済み ADMIN** を毎回再確認する（多層防御）。
- ログイン可能なのは **承認済み・role=ADMIN の `User`** のみ。初期 ADMIN は `ADMIN_LINE_USER_IDS`
  に lineUserId を入れ、その本人が一度 LIFF を開くと自動登録される。
- 管理ページ: `/admin`（集計・要確認）/ `/admin/invoices`（請求書）/ `/admin/masters`（マスタ）/ `/admin/users`（ユーザー承認）。

## セットアップ（P1）

```bash
cd app
npm install
cp .env.example .env   # 値を設定（SESSION_SECRET / ADMIN_LOGIN_REDIRECT_URL 含む）
npx prisma migrate dev # スキーマ → Supabase
npx prisma db seed     # ダミー初期データ
npm run dev
```

## 環境変数

| 変数 | 用途 |
|---|---|
| `DATABASE_URL` / `DIRECT_URL` | Supabase（pooler / 直結 migrate 用） |
| `LINE_CHANNEL_ID` / `LINE_CHANNEL_SECRET` | LINE Login / 検証（LIFF・管理ログイン） |
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API（グループ push / リッチメニュー） |
| `NEXT_PUBLIC_LIFF_ID` | LIFF 入力フォーム |
| `LINE_GROUP_ID` | 出面グループ（SELF のログ投稿先） |
| `ADMIN_LINE_USER_IDS` | 初期 ADMIN 付与（カンマ区切り lineUserId） |
| `SESSION_SECRET` | 管理セッション署名鍵（**必須・32文字以上のランダム**） |
| `LINE_LOGIN_CHANNEL_ID` / `LINE_LOGIN_CHANNEL_SECRET` | 管理ログイン用チャネル（未設定なら `LINE_CHANNEL_*` を流用） |
| `ADMIN_LOGIN_REDIRECT_URL` | LINE Login コールバック（`/api/auth/line/callback`・Console と完全一致） |

※ 実名・住所・口座・トークンはコミットしない（`.env` はギット管理外）。

## 構成（予定）

```
app/
  prisma/schema.prisma          # データモデル
  src/middleware.ts             # /admin・管理API のルート保護（セッション検証）
  src/app/liff/                 # 入力フォーム（LIFF）
  src/app/admin/                # 管理（集計 / invoices / masters / users）
    _actions.ts                 # マスタCRUD・ユーザー承認の Server Actions（ADMIN ガード）
  src/app/api/auth/line/        # LINE Login（login / callback）
  src/app/api/auth/logout/      # ログアウト
  src/app/api/                  # 送信API（reports）・masters・invoices export・LINE webhook
  src/lib/                      # session / auth / 集計 / 請求書(xlsx/CSV) / バリデーション
  scripts/setup-richmenu.ts     # 自社リッチメニュー作成（LINE Messaging API）
```

GAS資産（`../line-daily-report/`）が移植元：`invoice_doc.js`(請求書)・`report_validate.js`(検証)・`billing.js`(単価/名寄せ)。

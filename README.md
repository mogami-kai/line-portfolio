# 出面管理 → 集計 → 請求書 一貫システム

LINE（LIFF）で現場の出面（でづら）を入力 → Supabase(Postgres) に保存 → 取引先ごとに集計 → **請求書(xlsx/CSV)** まで自動化する Web アプリ。

- **スタック**: Next.js (App Router) / Vercel / Supabase(Postgres) / Prisma / LINE(LIFF・Login・Messaging API)
- **要件定義**: [`REQUIREMENTS.md`](./REQUIREMENTS.md)
- **アプリ本体・セットアップ・デプロイ**: [`app/`](./app)（[README](./app/README.md) / [DEPLOY.md](./app/DEPLOY.md)）

## 2系統ルーティング（核）

所属 org からサーバが自動判定（本人は source を選ばない）。**自社にパートナーを意識させない**。

- **自社 (SELF)** … 保存 ＋ LINEグループへログ投稿
- **パートナー (PARTNER)** … 保存のみ・グループ非投稿。**管理ダッシュボードのみ集約**（自社に不可視）
- パートナー追加＝`Organization(kind=PARTNER)` を足してエントリリンクを渡すだけ

## 構成

```
app/
  prisma/schema.prisma        データモデル（12モデル）
  src/middleware.ts           /admin・管理API のルート保護（署名セッション）
  src/app/liff/               入力フォーム（LIFF・スマホ最適化）
  src/app/admin/              管理（集計 / invoices / masters / users）
  src/app/api/                送信API（reports）・masters・invoices export・LINE webhook・認証
  src/lib/                    集計 / 請求書(xlsx・CSV) / 検証 / 単価 / session / auth
  scripts/setup-richmenu.ts   自社リッチメニュー作成（LINE Messaging API）
REQUIREMENTS.md               要件定義 v2
```

## 開発

```bash
cd app
npm install
cp .env.example .env          # 値を設定（Supabase / LINE / SESSION_SECRET）
npx prisma migrate dev        # スキーマ → DB
npx prisma db seed            # ダミー初期データ
npm run dev
```

本番セットアップ（Supabase / LINE / Vercel の設定と「あなたにしかできない作業」）は [`app/DEPLOY.md`](./app/DEPLOY.md) を参照。

## テスト

```bash
cd app && npm test            # 中核ロジック（単価計算・検証・請求書・セッション）
```

> 実名・住所・口座・トークンはリポジトリに含めない（DB / 環境変数に保持）。

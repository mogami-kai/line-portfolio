# 出面管理アプリ（Next.js / Supabase / Prisma / LIFF）

要件定義は[リポジトリ直下 `REQUIREMENTS.md`（v2）](../REQUIREMENTS.md)。
入力（LIFF）→ DB（Supabase）→ 集計 → 取引先ごとの請求書（xlsx/CSV）まで一貫。

## 2系統ルーティング（要点）

所属 org からサーバが自動判定（本人は選ばない）。自社にパートナーを意識させない。

- **SELF（自社）** … 保存 ＋ Messaging API で出面グループへログ投稿
- **PARTNER（協力）** … 保存のみ・グループ非投稿。管理ダッシュボードのみ集約閲覧
- パートナー追加＝`Organization(kind=PARTNER)` を足してエントリリンクを渡すだけ

## セットアップ（P1）

```bash
cd app
npm install
cp .env.example .env   # 値を設定
npx prisma migrate dev # スキーマ → Supabase
npm run dev
```

## 環境変数

| 変数 | 用途 |
|---|---|
| `DATABASE_URL` / `DIRECT_URL` | Supabase（pooler / 直結 migrate 用） |
| `LINE_CHANNEL_ID` / `LINE_CHANNEL_SECRET` | LINE Login / 検証 |
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API（グループ push） |
| `LIFF_ID` | LIFF 入力フォーム |
| `LINE_GROUP_ID` | 出面グループ（SELF のログ投稿先） |

※ 実名・住所・口座・トークンはコミットしない（`.env` はギット管理外）。

## 構成（予定）

```
app/
  prisma/schema.prisma   # データモデル（done）
  src/app/liff/          # 入力フォーム（LIFF）
  src/app/admin/         # 管理ダッシュボード
  src/app/api/           # 送信API・LINE webhook
  src/lib/               # 集計・請求書(xlsx/CSV)・バリデーション（GASから移植）
```

GAS資産（`../line-daily-report/`）が移植元：`invoice_doc.js`(請求書)・`report_validate.js`(検証)・`billing.js`(単価/名寄せ)。

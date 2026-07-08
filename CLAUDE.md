# CLAUDE.md — line-portfolio（足場の出面アプリ）

## これは何か

LINE(LIFF)で現場の出面を入力 → Supabase(Postgres) 保存 → 取引先ごと集計 → 請求書(xlsx/CSV) までを自動化する Web アプリ。
詳細は [`README.md`](./README.md) と [`REQUIREMENTS.md`](./REQUIREMENTS.md)（要件定義v2）。ここには複製しない。

## 最重要（触る前に）

- **アプリ本体は `app/` 配下**。npm コマンドは `cd app` してから叩く（リポジトリ直下では動かない）
- **2系統ルーティングが核**: 所属org からサーバが SELF / PARTNER を自動判定する。
  - SELF = 保存＋LINEグループへログ投稿 / PARTNER = 保存のみ・グループ非投稿・管理ダッシュボードのみ集約
  - **不変条件: 自社にパートナーの存在を意識させない**（PARTNERの投稿・可視化を自社側に漏らさない）
- スタック: Next.js(App Router) / Vercel / Supabase(Postgres) / Prisma / LINE(LIFF・Login・Messaging API)
- データモデルは `app/prisma/schema.prisma`（12モデル）。DB変更は必ず Prisma migrate 経由

## コマンド

```bash
cd app
npm run dev            # 開発サーバ
npm run typecheck      # tsc --noEmit
npm run test           # vitest run
npm run prisma:migrate # スキーマ→DB
```

## 絶対ルール

- `.env` は `app/` 内のみ（Supabase / LINE / SESSION_SECRET）。コミット禁止・読み上げ禁止
- `/admin`・管理APIは `src/middleware.ts` の署名セッションで保護。認証まわりを触る時はここを先に読む
- UI変更はブラウザ（LIFFはスマホ幅）で確認してから完了報告する
- git remote: `github.com/mogami-kai/line-portfolio`（＝バックアップ済み。push はGitHubを正とする）

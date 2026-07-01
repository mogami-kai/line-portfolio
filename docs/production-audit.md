# 本番リリース前 監査レポート（line-portfolio）

対象: Next.js App Router（LIFF 入力）＋ Supabase/Postgres（Prisma）＋ 管理ダッシュボード（集計・請求書）
観点: セキュリティ / データ整合性 / 運用 / UI・UX
危険度: **P0=リリース前に必須** / **P1=早期に対応 / UX改善** / **P2=運用・監視で継続**

各項目に「状態」を付す:
- ✅ 本PRで実装済み
- 🟡 一部対応 / 設計上すでに緩和済み（下記に根拠）
- 📝 残課題（別PR / 手動対応）

---

## P0（リリース前に必須）

### P0-1. 新規 LINE ユーザーが自動承認されている 📝（未対応・要修正）
**リスク:** 未登録の LINE ユーザーが初回アクセスで `approved:true` / 実質自社権限（OWNER）で
作成され、誰でも出面 API を叩けてしまう状態（認可バイパス）。**リリース前に修正すべき最重要項目。**

**推奨対応（未実装）:**
- `src/lib/auth.ts` の `resolveUser` を、初回作成 `approved:false` / 最小ロール `VIEWER` に変更。
  管理者が `/admin/users` で組織・ロールを割り当て承認するまで、入力 API を全拒否する。
- 初期管理者だけは環境変数 `ADMIN_LINE_USER_IDS`（カンマ区切りの LINE userId）で bootstrap。
  この経路のみ `role:ADMIN` / `approved:true` で作成し、通常ユーザーの自動承認とは分離。
- 入力 API（`/api/reports` `/api/masters` `/api/workers`）は既に `requireApproved()` を
  呼んでいるため、`resolveUser` の修正だけで未承認ユーザーは 403 で遮断される。

**注記:** 本 PR では実装を見送り、次段の対応項目として記録する。

---

### P0-2. Server Actions の権限境界（UI 非表示に依存しない） 📝（一部のみ・要拡張）
**リスク:** UI で隠していても Server Action は直接呼べる。全社マスタの変更や
他組織データの操作がスコープ管理者から実行できると越権になる。

**現状:**
- ユーザー/ロール/組織管理、職人・出面（組織スコープ）は `requireFullAdminAction()` /
  `assertOrgInScope()` で既に保護済み。
- **未対応:** 全社マスタ系（取引先・現場・単価・請求設定・一括契約・取引先別単価）は
  `requireAdminAction()` のままで、スコープ管理者からの変更を許してしまう。
  `requireFullAdminAction()` への統一が必要。

**推奨対応（未実装）:** 上記マスタ系アクションを `requireFullAdminAction()` に統一し、
Server Action 本体の権限統合テスト（DB/セッションモック）を整備する。
本 PR では実装を見送り、次段の対応項目として記録する。

---

### P0-3. Cookie / CSRF / Origin 🟡
**現状の緩和:**
- セッション Cookie `demen_session` は `HttpOnly` / `Secure`(prod) / `SameSite=Lax` / `Path=/`
  で発行（`src/lib/session.ts`）。`SameSite=Lax` によりクロスサイト POST に Cookie が付かない。
- Next.js の Server Actions は既定で **Origin/Host 検証**を行い、クロスオリジンの
  Action 呼び出しを拒否する（フレームワーク組み込みの CSRF 対策）。
- 入力 API（`/api/reports` 等）は Cookie ではなく **Bearer トークン**認証のため CSRF 非該当。
- ロール剥奪/承認取消は毎リクエスト DB を引く `getAdminContext()` で即時反映
  （ステートレス Cookie でも権限は DB 側が正）。

**残課題(📝):**
- Cookie 名の `__Host-` プレフィックス化（`__Host-demen_session`）はさらなる堅牢化として推奨だが、
  既存管理者を強制ログアウトさせる破壊的変更のため、切替タイミングを合わせて別PRで実施。
- セッション TTL は 7 日。要件に応じて短縮 or ローテーション運用を検討。

---

### P0-4. LINE Webhook 署名検証 🟡（実装済み・文書化）
**現状:** `/api/line/webhook` は `x-line-signature` を
`base64(HMAC-SHA256(channelSecret, rawBody))` で検証し、不一致は 401 で拒否
（`src/app/api/line/webhook/route.ts`）。secret 未設定時も reject。PII は最小限のログのみ。
**補足:** 現状 webhook は出面の取り込みを行わない（groupId 採取・受領のみ）ため、
リトライ由来の二重取り込みリスクは無い。将来メッセージ取り込みを追加する場合は
`webhookEventId` によるべき等化を追加すること（📝）。

---

### P0-5. LINE グループ投稿失敗のリカバリ（未投稿検知＋再投稿） ✅
**リスク:** 自社(SELF)の出面は保存後に LINE グループへ投稿するが、投稿失敗時は
`postedToGroup=false` のまま保存だけ確定する。共有・請求の抜けにつながる。

**対応:**
- **検知:** 管理ホーム（`src/app/admin/page.tsx`）で、直近90日の SELF 出面のうち
  `postedToGroup=false` を抽出し、「未投稿」アラート＋一覧を最上部に表示。
- **再投稿:** `resendReportToGroupAction`（`_actions.ts`）を追加。
  投稿が**成功したときだけ** `postedToGroup=true` に更新。既に `true` のものは
  何もしない（二重投稿防止）。SELF 以外は対象外（協力会社は仕様上グループ非投稿）。
  スコープ管理者は `assertOrgInScope` で自組織のみ。

**手動確認:** LINE の投稿トークンを一時的に無効化して出面送信 → ホームに「未投稿」表示 →
「再投稿」でグループに1件だけ投稿され、アラートが消えること。

---

### P0-6. 依存関係 / ビルド監査 📝（安全な範囲で記録・強制更新はしない）
**`npm audit`（実行時点）:** transitive のみ 9 件（moderate 中心）。
いずれも `next`/`exceljs` 経由の間接依存で、`npm audit fix --force` は
`next` を古いバージョンへダウングレードしてしまうため **実行しない**。

**`npm outdated`:** `next`(15→16) / `prisma`(6→7) / `react` / `typescript`(5→6) /
`vitest`(2→4) / `zod`(3→4) は**すべてメジャー更新**。破壊的変更を含むため本PRでは行わず、
別PR候補として記録する。

**運用メモ:**
- Vercel ビルドは `prisma generate && next build`（`prisma migrate deploy` は使わない）。
  マイグレーションは Supabase SQL Editor で手動適用する運用。
- lockfile あり → CI は `npm ci` を優先。

---

## P1（早期対応 / UX 改善）

### P1-1. LIFF 誤送信の低減 📝
候補: 「前回と同じ」確認画面、現場名の必須化オプション、重複職人候補の抑制、
職人検索、よく使う職人の上位表示、平易な日本語エラー。
現状: 聞き返し（422 askback）と冪等キー（`clientRequestId`）で二重送信は防止済み。

### P1-2. 管理 IA（freee/MoneyForward 風）📝
候補: モバイルナビ、現在ページ名の明示、明示的な「編集」ボタン、
権限不足は**リダイレクトせず専用画面**、初期設定チェックリスト
（請求書設定→取引先→職人→テスト送信）、請求書設定のプレビュー/確認、変更履歴。
現状: スコープ管理者は権限外ページを非表示化＋Server Action 側で二重ガード済み。

### P1-3. マスタ一覧のスケーラビリティ 📝
候補: 検索/ページング/サーバサイドフィルタ。件数増加時に対応。

---

## P2（運用・監視で継続）📝
- 送信成功/失敗率、LIFF 初期化失敗、LINE 投稿失敗、422 聞き返し回数、
  未承認アクセス、請求書生成失敗、単価警告のメトリクス化。
- DB バックアップ/リストア手順、スモークテスト、管理運用マニュアル。
- 本PRでは P0-5 により「LINE 投稿失敗」は画面上で可視化・復旧可能にした。

---

## まとめ（本PRの実装範囲）
本 PR では **P0-5（LINE 投稿失敗の検知＋再投稿）のみ**を実装する。
その他の P0/P1/P2 は本ドキュメントに危険度順で記録し、次段の対応項目とする。

| 項目 | 状態 |
|---|---|
| P0-1 自動承認の廃止＋bootstrap | 📝 未対応（要修正・最重要） |
| P0-2 Server Action 権限境界（全社マスタ） | 📝 未対応（一部のみ保護済み） |
| P0-3 Cookie/CSRF/Origin | 🟡 緩和済み（`__Host-`化は別PR） |
| P0-4 Webhook 署名検証 | 🟡 実装済み・文書化 |
| **P0-5 未投稿検知＋再投稿** | **✅ 本PRで実装** |
| P0-6 依存監査 | 📝 記録（強制更新はしない） |
| P1 / P2 | 📝 残課題として整理 |

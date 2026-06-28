# 出面管理 → 集計 → 請求書 一貫システム 要件定義 v2

> **スタック確定**: Next.js（Vercel）＋ Supabase（Postgres）＋ Prisma ＋ LINE（LIFF / Login / Messaging API）。
> v1（GAS＋Sheets）からアプリへ再定義。GAS資産（`line-daily-report/`）は**ロジックの移植元**として活用する（単価計算・請求書テンプレ・日報バリデーション・入力フォーマット知識）。
> 本書の例はすべて**ダミー名**。実取引先名・住所・口座・個人名はリポジトリに含めず、DB／環境変数に保持する。

---

## 1. 目的・スコープ

LINEからの出面入力 → DB保存 → 集計 → **取引先ごとの請求書**まで、1つのアプリで一貫自動化する。

- 入力は**LIFFフォーム**（構造化）に統一し、表記揺れ・誤字を入力時点で消す。
- **自社**と**パートナー（協力会社）**の二系統を扱い、見え方を分ける。
- **管理者**は全データを1か所（管理ダッシュボード）で見て、月末に請求書を発行する。

## 2. アクター / ロール

| ロール | 主体 | 入力 | 閲覧 | 権限 |
|---|---|---|---|---|
| **ADMIN** 管理者 | 運営（最上/後藤） | 可 | **全部** | マスタ管理・請求書発行・全集約 |
| **OWNER** 自社代表 | 自社の代表者 | 自社日報 | 自社分 | 自社の入力。送信で出面グループへbotログ |
| **VIEWER** 自社メンバー | 職人 | 不可 | グループのログ | LINEグループで閲覧のみ |
| **PARTNER** パートナー | 協力会社の担当 | 自社（=その会社）分 | 自分の組織分のみ | グループには出ない・管理者のみ集約閲覧 |

## 3. 全体アーキテクチャ

```
 LINE公式アカウント
  ├ リッチメニュー ──▶ LIFF（Next.jsページ）入力フォーム
  │      └ LINE Login で lineUserId / 表示名 → User・ロール解決
  └ Messaging API(push) ◀── 自社日報を「出面グループ」へ整形ログ投稿
        ▲
 Next.js (Vercel)  ── Route Handlers / Server Actions
  ├ Prisma ──▶ Supabase(Postgres)   ※パートナー分離は RLS or アプリ層ガード
  ├ 管理ダッシュボード（Web・ロール別）
  └ 集計 → 請求書生成（テンプレ準拠）→ PDF（＋xlsx任意）
```

- **リッチメニューは1対1トークのみ表示**（LINE仕様）。各自がbotを友だち追加し、**1対1から入力**。グループは自社ログの閲覧用。
- 自社日報の送信時のみ Messaging API の push でグループへログ投稿（パートナーは投稿しない）。

## 4. 入力（LIFFフォーム）

リッチメニュー「日報入力」→ LIFF。**ドロップダウン/選択中心でテキスト入力を排除**。

| 項目 | UI | 既定/補完 |
|---|---|---|
| 日付 | ピッカー | 今日 |
| 取引先 | 取引先マスタから選択 | 直近 |
| 現場 | 取引先に紐づく現場から選択（＋新規追加可） | — |
| 契約種別 | 常用 / 請負 | 常用 |
| 勤務体系 | 日勤 / 半日 / 夜勤 | 日勤 |
| 職人 | メンバーから複数選択（各人に半日/夜勤/残業を付与可） | — |
| 人工 | 1 / 0.5 / 0.75（勤務体系から自動も可） | 1 |
| 残業 | 時間（h） | 0 |
| 経費(任意) | 種別＋金額（駐車/燃料/弁当…）＋請求/自社負担 | — |

- 送信 → API → DB保存。`source` で自社/パートナーを判定 → 自社のみグループへbotログ。
- 自由テキストは「現場の新規名」「備考」程度に限定 → **§8のバリデーションは大幅に縮小**（入力時点で構造化済）。

## 5. ルーティング（二系統・最重要）

> **制約**: 自社にパートナーの存在をできるだけ意識させない。自社のUI・グループにパートナーは一切出さず、合流は管理ダッシュボードだけ。

設計の核 = **マルチテナント（org単位）＋入口（エントリ面）の分離＋合流は管理画面のみ**。ルーティングは「ユーザーの所属org」で**サーバ側が自動判定**（本人が自社/パートナーを選ばない）。

```
[識別] LINE Login → User(lineUserId → orgId, role)   ※本人は org/source を選ばない
[入口] 自社      : 出面グループ＋自社リッチメニュー/LIFF（パートナー概念なし）
       パートナー: 別エントリ（パートナー専用LIFFリンク）。自社グループ/メニューに出ない
[判定] 送信時に org.kind で分岐（1箇所）
        SELF    → DB保存 ＋ Messaging API push で出面グループへ整形ログ
        PARTNER → DB保存のみ（グループ非投稿・postedToGroup=false）
[合流] 管理ダッシュボードのみ全org集約（パートナーが見えるのはここだけ）
```

- **不可視性は構造で担保**: ①自社グループにbotはSELFのみ投稿 ②自社の入力UIにパートナー概念なし ③パートナーは別入口で自社面に現れない ④orgId/RLSでデータ分離。
- **拡張性**: パートナー追加＝`Organization(kind=PARTNER)` を足してエントリリンクを渡すだけ（コード変更なし）。初回ユーザーは未承認→管理者がorg/role割当。
- 当面パートナーは**入力専用**（自分用の閲覧は後付け可）。ログ投稿文は v1 のbot受信確認フォーマットを踏襲。

## 6. データモデル（Prisma スケッチ）

```prisma
enum OrgKind     { SELF PARTNER }
enum Role        { ADMIN OWNER VIEWER PARTNER }
enum ContractType{ JOYO UKEOI }            // 常用 / 請負
enum Shift       { DAY HALF NIGHT }        // 日勤 / 半日 / 夜勤
enum ReportStatus{ DRAFT CONFIRMED NEEDS_REVIEW }
enum InvoiceStatus{ DRAFT ISSUED PAID }

model Organization { id String @id @default(cuid()) name String kind OrgKind
  users User[] reports Report[] workers Worker[] }

model User { id String @id @default(cuid()) lineUserId String @unique
  displayName String role Role orgId String org Organization @relation(fields:[orgId], references:[id]) }

model Worker { id String @id @default(cuid()) name String orgId String aliases String[] }

model Client { id String @id @default(cuid()) name String address String? honorific String? // 御中/様
  aliases String[] sites Site[] rates RateCard[] }

model Site { id String @id @default(cuid()) name String clientId String
  client Client @relation(fields:[clientId], references:[id]) }

model RateCard { id String @id @default(cuid()) clientId String siteId String? // null=既定単価
  contractType ContractType unitPrice Int effectiveFrom DateTime? }

model Report { id String @id @default(cuid()) workDate DateTime clientId String siteId String?
  contractType ContractType source OrgKind orgId String createdById String
  status ReportStatus @default(CONFIRMED) postedToGroup Boolean @default(false)
  entries ReportEntry[] createdAt DateTime @default(now()) }

model ReportEntry { id String @id @default(cuid()) reportId String workerId String
  shift Shift @default(DAY) manDays Float @default(1) otHours Float @default(0) }

model Expense { id String @id @default(cuid()) workDate DateTime clientId String? siteId String?
  kind String amount Int billable Boolean @default(true) reportId String? }

model InvoiceSetting { id String @id @default(cuid()) issuerName String address String? tel String?
  email String? regNumber String? bankInfo String? taxRate Float @default(0.10) contactName String? }

model Invoice { id String @id @default(cuid()) clientId String yearMonth String // "2026-06"
  invoiceNo String issueDate DateTime status InvoiceStatus @default(DRAFT) lines InvoiceLine[] }

model InvoiceLine { id String @id @default(cuid()) invoiceId String itemName String
  qty Float unitLabel String unitPrice Int amount Int taxRate Float }
```

> 単価改定は `RateCard.effectiveFrom` で履歴化（任意）。発行済み請求書は `Invoice`/`InvoiceLine` にスナップショット保存し、後からマスタを変えても過去請求は不変。

## 7. 単価・請求計算（v1から移植）

`時給 = 単価 ÷ 8`、残業係数 `1.25`。

| 勤務 | 計算 |
|---|---|
| 1日 | 単価 × 1 |
| 半日 | 単価 × 0.5 |
| 0.75日 | 単価 × 0.75 |
| 残業 Nh | ＋ 単価 ÷ 8 × 1.25 × N |
| 夜勤 | 1日扱い（割増なし。現場により別途） |

- 常用請求額 = Σ(人工×単価) ＋ Σ(残業h × 単価/8×1.25)、請負 = 契約金額。
- 単価は `RateCard`（取引先×現場×種別）から自動。無ければ管理者が請求時に入力。

## 8. バリデーション（LIFFで激減・残る分）

構造化入力で取引先/現場/勤務/職人の揺れは消える。**残るチェック**は入力時/保存時に実施（`report_validate.js` のロジックをTS移植）:

- 日付: 未来日・存在しない日・大幅な過去（打ち間違い）。
- 数値: 人工(0.25刻み・上限)・残業(上限h)。
- 重複: 同一 取引先×現場×日付×職人。
- パートナーの**新規取引先/現場**: 管理者承認キュー（`NEEDS_REVIEW`）に載せる。
- 自由テキスト現場名は近い既存名をサジェスト（レーベンシュタイン）。

## 9. 管理ダッシュボード（Web・ロール別）

- **月次集計**: 取引先別／職人別／自社・パートナー別の人工・残業・金額。
- **要確認キュー**: `NEEDS_REVIEW` の承認/修正。
- **経費**: 立替/自社負担の一覧。
- **マスタ管理**: 取引先・現場・単価(RateCard)・メンバー・パートナー・自社情報(InvoiceSetting)。
- **請求書**: 月選択 → 取引先ごとに生成・プレビュー・PDF発行・ステータス(下書き/発行/入金)。
- **ログ**: 入力履歴・グループ投稿履歴。
- アクセス制御: ADMIN=全部、OWNER=自社、PARTNER=自組織のみ（Supabase RLS もしくはアプリ層ガード）。

## 10. 請求書生成（一貫・テンプレ準拠）

取引先ごとに1通。レイアウトは v1 設計テンプレに準拠:

```
請求書番号 yyyy-NNN(例 2026-001)      請求日 yyyy/MM/dd（末締め）
発行元(InvoiceSetting): 名/〒住所/TEL・Email/登録番号 T../担当
宛先: {取引先} 御中 / {住所}（Client）
明細: No | 品目・内容 | 数量 | 単位 | 単価 | 金額 | 税率
   常用: 「{現場} 常用」数量=人工 単価=RateCard/入力 金額=数量×単価
   残業: 「{現場} 残業」数量=h 単価=単価/8×1.25
   請負: 「{案件} 一式」/ 立替経費（対象外）
小計（税抜）→ 消費税(10%/8%内訳)→ 合計（税込）→ お支払期限=請求日
お振込先（InvoiceSetting.bankInfo）/ 備考: ※お振込手数料は御社にてご負担…
```

- 出力: **xlsx（テンプレ体裁）＋ CSV（明細フラット・会計/freee取込用）**。テンプレ自体は v1 設計で確定。PDFは将来オプション。
- 末締め・請求日＝支払期限（同日）。請求金額はDBにスナップショット保存。

## 11. LINE連携

- **LIFF**: 入力フォーム（Next.jsページを LIFF として登録）。`liff.getProfile()` で本人、`liff.getContext()` で起動元。
- **LINE Login**: User の作成/ロール解決（lineUserId）。
- **Messaging API (push)**: 自社日報を出面グループへログ投稿。
- **Rich Menu**: 入口（友だち追加した各ユーザーの1対1に表示）。

## 12. 認証・権限・データ分離

- LINE Login → `User`（lineUserId 一意）→ `role`/`orgId`。
- PARTNER は自組織（`orgId`）のデータのみ。ADMIN は全件。Supabase **RLS** で行レベル制御、または Next.js のサーバ側ガードで担保。
- 初回ユーザーは `NEEDS_REVIEW`（管理者がロール/所属を承認）。

## 13. 非機能・運用

- ホスティング: Vercel（Next.js）／ Supabase（Postgres＋Auth＋RLS）／ Prisma migrate。
- リポジトリ: `line-portfolio/app/`（Next.js, Prisma `app/prisma/schema.prisma`）。GAS資産は `line-daily-report/` に残置（移植元）。
- 環境変数: `DATABASE_URL` `DIRECT_URL` `LINE_CHANNEL_ID/SECRET` `LINE_CHANNEL_ACCESS_TOKEN` `LIFF_ID` `LINE_GROUP_ID`。
- セキュリティ: 口座/住所/個人名は DB のみ（リポジトリ・クライアントに焼き込まない）。Webhook 署名検証。
- バックアップ: Supabase 自動＋月次エクスポート。

## 14. 段階導入（Phase）

1. **P1 基盤＋自社入力**: Prisma schema・Supabase・LIFF入力（自社）・グループlog投稿・最小マスタ。
2. **P2 パートナー＋管理画面**: ロール/分離・パートナー入力・管理ダッシュボード（集計・要確認）。
3. **P3 請求書**: テンプレ準拠の請求書生成＋PDF＋ステータス管理。
4. **P4 強化**: 単価マスタ自動化・別名学習・経費・単価改定履歴・freeeCSV。

## 15. 既存資産（GAS）の移植マップ

| 既存（`line-daily-report/`） | 移植先（アプリ・TS） |
|---|---|
| `invoice_doc.js`（テンプレ/数式/明細） | 請求書生成サービス（PDF・行計算） |
| `report_validate.js`（4項目判定） | 入力/保存時バリデーション |
| `billing.js`（単価計算・名寄せ・集計） | 集計サービス・RateCard ルックアップ |
| 入力フォーマット知識（LINEログ由来） | LIFF選択肢・初期マスタ・ログ投稿文 |
| `REQUIREMENTS.md`(v1) | 本書 v2 が上位（v1はGASモジュール仕様として残置） |

---

### 確定済みの決定
- スタック: Next.js / Vercel / Supabase / Prisma / LINE(LIFF・Login・Messaging API)。
- 自社日報は LIFF 入力後も bot が出面グループへログ投稿（**維持**）。
- パートナー入力はグループ非投稿・管理者のみ集約閲覧。
- **自社にパートナーを意識させない**（入口分離＋自社面に非表示、合流は管理画面のみ。source は所属orgから自動判定）。
- リポジトリ: 本 `line-portfolio` 内に `app/` を新設（モノレポ）。
- パートナー規模: 当面少数・拡張性込み（org単位マルチテナントで対応）。
- 請求書出力: **xlsx＋CSV**（テンプレデザインで確定）。

### 次に決めたい点（実装中に詰める）
- パートナーのエントリ方式（専用LIFFリンク／パートナー用リッチメニュー）と初回承認フロー。
- Supabase RLS をどこまで効かせるか（最低限はアプリ層ガードで担保）。

---

# 改善 要件定義 v3（運用簡素化・単価/請負の一本化・職人の自己追加）

> 確定日 2026-06-28。本番運用フィードバックに基づく改修。v2 を上位仕様としつつ差分を定義。
> 方針: 管理画面の項目を減らす。「変わらない値はマスタに1回／都度変わる値は出面で」。
> 既存データは**過去分維持**（破壊的変更なし・スキーマは追加のみ）。

## v3-1. 現場（Site）→ 自由入力化
- 現場は請求に依存しない（請求は取引先単位）ため、**LIFFは自由入力テキスト**（毎回手入力・誤記許容）。
- マスタ管理の「現場」セクションは**廃止**。
- データ: `Report.siteName`（テキスト）を新設。`Report.siteId`/`Site` は過去分維持のため残置。

## v3-2. 取引先（Client）→ 単価を内包・別名廃止
- 取引先フォームの「別名」を廃止し、「**常用単価（円/人工）**」を入力（取引先を開いて設定）。
- マスタの「単価」セクションは**廃止**（取引先に内包）。
- データ: `Client.unitPrice Int?` を新設。`Client.aliases` は残置（UIから除去・未使用）。`RateCard` は残置。

## v3-3. 契約種別と請求（常用/請負の一本化）
- 出面入力で常用/請負を選択。
  - **常用**: 人工を記録 → 請求「**○月委託料** 数量=人工合計・単価=取引先の常用単価」。
  - **請負**: 出面入力時に**請負金額**を入力（案件ごと1回）→ 請求「**○月委託料** 数量1・金額=請負金額」。
- 品目名は常用・請負とも「○月委託料」（混在月は同名で2行並ぶ）。
- 請負の職人選択は社内記録用（請求額に影響しない）。
- マスタの「請負金額(LumpContract)」セクションは**廃止**。データ: `Report.contractAmount Int?` を新設。`LumpContract` は残置。

## v3-4. 職人（Worker）→ 自己追加・永続・組織別・管理者削除
- LIFF に「**＋職人を追加**」（名前入力→即選択・以後ずっと候補に残る＝DB保存）。
- **自社と協力会社で職人リストを分離**（入力者の所属 org に紐づく＝既存 `Worker.orgId`）。
- 管理者は職人を**削除（無効化）**できる。

## v3-5. ヘッダー（メニュー重複の解消）
- メニューは**1つ・右**に統一。**青いハンバーガーボタン**を採用（右）、従来の「≡」は削除。
- **会社ロゴは無し** → 左はアプリ名「出面管理（＋ページ名）」のテキストのみ（PCサイドバー上部も文字のみ）。

## v3-6. 投稿ルーティング（現状維持）
- 自社(SELF): 既存グループへ**テキスト送信**。協力会社(PARTNER): **送信なし・管理画面保存のみ**。

## v3-7. 管理画面の最終形
- 取引先（＋常用単価）／職人（自社・協力会社別・削除可）／自社情報／組織（自社・協力会社）。
- 廃止セクション: 現場・単価・請負金額。

## v3-8. 移行方針（過去分維持）
- スキーマは**追加のみ**（`Client.unitPrice` / `Report.siteName` / `Report.contractAmount`）。
- `Site`/`RateCard`/`LumpContract`・`Client.aliases` は削除しない（管理UIから外すのみ）。
- 発行済み請求書はスナップショットのため不変。請求集計の常用単価は `Client.unitPrice` を優先し、未設定時は既存 `RateCard` 既定単価へフォールバック。

## v3-9. 段階導入
- **P1**: マスタ削減（別名→単価・現場/単価/請負セクション廃止）＋ヘッダー修正＋スキーマ追加。
- **P2**: LIFF（現場フリー入力・職人の自己追加/組織別・請負金額入力）。
- **P3**: 請求ロジック（常用=人工×`Client.unitPrice`／請負=数量1・`Report.contractAmount`）。

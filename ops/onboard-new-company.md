# 新しい会社を1社ぶん立てる手順（別デプロイ方式）

このアプリは **1デプロイ = 1社**。会社を増やすときは **コードを1行も変えず**、
「別Supabase ＋ 別Vercelプロジェクト（同じリポジトリ）＋ 別LINE」を1セット用意する。

- **共通**: GitHubリポジトリ（＝コード）。1回pushすれば全社のデプロイが更新される。
- **会社ごとに別**: DB / Vercelプロジェクト / LINE公式アカウント / LIFF / env。
- 詳細な各サービスの操作は `app/DEPLOY.md`（1社目を立てた時の原典）を参照。ここは「2社目以降の差分」に絞る。

> 例として `<company>`（例: 鍛冶屋）、`<domain>`（例: `kaji-demen.vercel.app`）と書く。

---

## 前提の考え方

- 新インスタンスの中では、その会社が **自社（SELF）** になる。1社目（足場）のデータは一切入らない。
- 別DBなので **元請けの管理画面から新会社の出面・集計は見えない**（別ログイン・別URL）。横断で見たくなったら将来 tenantId 方式へ移行（今は不要）。
- 所有・管理はすべて **元請け（あなた）** に集約（Vercelチーム / Supabase org / LINE Business の同一アカウント配下）。

---

## 1. Supabase（新規プロジェクト）

1. supabase.com で **新規プロジェクト**（リージョン **東京 `ap-northeast-1`**）。1社目とは別プロジェクト。
2. 接続文字列を控える:
   - `DATABASE_URL` = Transaction pooler（port **6543** / `?pgbouncer=true`）
   - `DIRECT_URL` = Direct（port **5432**）
3. スキーマ適用は **必須の手作業ではない** — Vercelのビルドコマンドが `prisma migrate deploy` を
   含む（§3参照）ため、env登録後の初回デプロイで自動適用される。
   ただし「接続文字列が正しいか」をVercelのビルドより先に確認したいなら、任意で:
   ```bash
   cd app && npx prisma migrate deploy
   ```
   をローカルから新会社の接続文字列に対して実行しておくと、繋がらない場合のエラーが分かりやすい。

## 2. LINE（新規Provider ＋ 2チャネル ＋ LIFF）

LINE Developers Console で、元請けのLINE Business配下に **新規Provider「<company>」** を作る（会社ごとに分離）。

1. **Messaging API チャネル**（bot・グループ投稿・webhook・リッチメニュー）を新規発行:
   - `LINE_CHANNEL_ACCESS_TOKEN`（長期トークン）
   - チャネルシークレット → **`LINE_MESSAGING_CHANNEL_SECRET` に必ずセット**
     （⚠️ 空だと `LINE_CHANNEL_SECRET`＝Loginチャネルのシークレットに fallback してしまい、webhook署名検証が狂う。別チャネルなので必ず明示的に入れる）
   - Webhook URL = `https://<domain>/api/line/webhook`・Webhook利用ON・**応答メッセージOFF**
2. **LINE Login チャネル**（LIFF＋管理画面ログイン）を同じProviderに発行:
   - `LINE_CHANNEL_ID` / `LINE_CHANNEL_SECRET`
   - Callback URL に `https://<domain>/api/auth/line/callback` を登録し、同値を env の `ADMIN_LOGIN_REDIRECT_URL` にも（**完全一致必須**）
   - `LINE_LOGIN_CHANNEL_ID/SECRET` は空でよい（上の LINE_CHANNEL_ID/SECRET に fallback する）
3. **LIFF アプリ**を Login チャネルに追加:
   - Endpoint URL = `https://<domain>/liff`、サイズ = **Full**、スコープ = `openid profile`
   - 発行された **LIFF ID** → `NEXT_PUBLIC_LIFF_ID`
4. **出面グループ**を新規作成 → botを招待 → 最初のイベントの `source.groupId` を控える → `LINE_GROUP_ID`
   （bot診断は `/api/admin/line-diag`。グループ未設定でも入力フロー自体は落ちない）

## 3. Vercel（新規プロジェクト・同じリポジトリ）

1. vercel.com で **新規プロジェクト** を作り、**1社目と同じGitHubリポジトリ**をImport。
   **Root Directory = `app`**（`app/vercel.json` が Build を固定）。
   → これで push 1回が両プロジェクトを同時にデプロイする（＝コードは常に同一）。
   - **リージョンは `app/vercel.json` の `"regions": ["hnd1"]`（東京）で固定済み**。Vercelの
     デフォルトは米国 `iad1` で、そのままだと **日本のユーザー → 米国で実行 → 東京のSupabaseへ
     クエリ** と太平洋を往復し、DBを触る画面が体感で2〜3倍重くなる（2026-08-07に鍛冶屋で実際に発生）。
     ダッシュボードの Settings → Functions を触る必要はないが、デプロイ後に
     `curl -sI https://<domain>/admin | grep x-vercel-id` が `kix1::hnd1::…` になっているか確認する
     （`iad1` が出たら効いていない）。
2. Environment Variables に下記を登録（`NEXT_PUBLIC_` 以外は Secret）:
   ```
   DATABASE_URL, DIRECT_URL
   LINE_CHANNEL_ID, LINE_CHANNEL_SECRET            # Loginチャネル
   LINE_CHANNEL_ACCESS_TOKEN                        # Messagingチャネル
   LINE_MESSAGING_CHANNEL_SECRET                    # Messagingチャネル（必ずセット）
   LINE_GROUP_ID
   NEXT_PUBLIC_LIFF_ID
   ADMIN_LINE_USER_IDS                              # 初期ADMINのlineUserId（カンマ区切り）
   SESSION_SECRET                                   # ★この会社固有のランダム値（openssl rand -hex 32）
   ADMIN_LOGIN_REDIRECT_URL                         # https://<domain>/api/auth/line/callback
   CRON_SECRET                                      # 入金リマインドcron用
   ```
   - ⚠️ `SESSION_SECRET` は **1社目と絶対に使い回さない**（会社ごとに別のランダム値）。
3. Deploy → 発行された `<domain>`（`<project>.vercel.app`）を、§2 の Webhook / LIFF Endpoint / Callback URL に反映（先にデプロイしてドメイン確定 → LINE側URLを埋める → 必要なら再デプロイ）。

## 4. 初期セットアップ（デプロイ後）

1. **初期ADMIN**: `ADMIN_LINE_USER_IDS` に入れた本人が **LIFFを一度開く** → role=ADMIN・approved で自動登録 → `/admin` からログイン可能に。
2. **自社情報の命名**: `/admin/masters` で自動作成された自社(SELF)組織を「<company>」に、`InvoiceSetting`（発行元）を必要なら記入（請求書を使わないなら後回し可）。
3. **マスタ**: 取引先(Client)・単価(RateCard)・職人(Worker) を入力。
4. **リッチメニュー**（自社入力の入口）:
   ```bash
   cd app
   LINE_CHANNEL_ACCESS_TOKEN=xxxxx \
   LIFF_URL="https://liff.line.me/<LIFF_ID>" \
   RICHMENU_IMAGE=./richmenu.png \
   npx tsx scripts/setup-richmenu.ts
   ```
5. **疎通テスト**: 自分のLINEで 出面入力 → 自社グループに投稿されるか確認。

---

## 継続運用の注意（複数DBになる以上ずっと効く）

- **マイグレーションは手動不要・Vercelのビルドが自動で流す**。
  `app/vercel.json` の buildCommand が `prisma generate && prisma migrate deploy && next build` に
  固定されているため、**pushして各社のVercelがビルドするたびに、そのプロジェクトのenv（DB接続先）へ
  自動でマイグレーションが適用**される。会社ごとに手動で `migrate deploy` を打つ必要はない。
  - ⚠️ 裏を返すと、**新規Vercelプロジェクトは `DATABASE_URL`/`DIRECT_URL` が有効な接続文字列に
    なっているまで、初回ビルドが `migrate deploy` の時点で必ず失敗する**。
    順序は「Supabase作成 → Vercelにenv登録 → Deploy」を守る（先にVercelだけ作ってドメインを
    確保したい場合、env未設定の初回ビルドは失敗して当然と割り切り、env登録後に Redeploy する）。
- 秘匿値（トークン・シークレット・接続文字列）は各Vercelプロジェクトの env にだけ。コード/リポジトリに焼かない。
- 会社ごとに Webhook/LIFF/Callback の URL がそのドメインを指しているか、増設のたびに確認。

---

## チェックリスト（1社ぶん）

- [ ] Supabase 新規プロジェクト（東京）＋ `DATABASE_URL`/`DIRECT_URL`
- [ ] （任意）接続確認: ローカルから `prisma migrate deploy` — 本番はVercelビルドが自動で流す
- [ ] LINE 新規Provider作成
- [ ] Messaging APIチャネル発行 → `LINE_CHANNEL_ACCESS_TOKEN` ＋ `LINE_MESSAGING_CHANNEL_SECRET`（明示）
- [ ] Login チャネル発行 → `LINE_CHANNEL_ID`/`SECRET` ＋ Callback URL 登録
- [ ] LIFFアプリ発行 → `NEXT_PUBLIC_LIFF_ID`（Endpoint=`/liff`）
- [ ] 出面グループ作成＋bot招待 → `LINE_GROUP_ID`
- [ ] Vercel 新規プロジェクト（同リポジトリ・Root=`app`）＋ env 全登録（`SESSION_SECRET`は固有）
- [ ] Deploy → ドメインを Webhook/LIFF/Callback に反映
- [ ] `x-vercel-id` が `hnd1`（東京）か確認 — `iad1` なら関数が米国で動いていて重い
- [ ] 初期ADMIN が LIFF を1回開く → `/admin` ログイン確認
- [ ] 自社(SELF)組織を社名に変更＋マスタ入力
- [ ] リッチメニュー適用
- [ ] 出面→グループ投稿の1往復テスト

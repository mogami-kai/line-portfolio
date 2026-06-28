// ============================================================
// /admin/masters — マスタ管理（Server Component ＋ Server Actions）
//
//   ガード: getAdminContext()（無ければログイン画面へ）＋ middleware。
//   セクション（タブ風アンカー）:
//     - 取引先（Client）   … 追加 / 編集（名・敬称・住所・別名・有効）
//     - 現場（Site）       … 取引先に紐づく現場の追加 / 削除
//     - 単価（RateCard）   … 取引先×現場×種別×単価 の追加 / 削除
//     - 職人（Worker）     … org スコープの追加 / 編集
//     - 組織（Organization）… 自社/パートナーの追加 / 編集
//     - 自社情報（InvoiceSetting）… 発行元 / 振込先 / 税率
//     - 請負金額（LumpContract）… 取引先×月の一式金額
//   入力はすべて zod 検証済みの Server Action 経由（_actions.ts）。
//   モバイルファースト（globals.css のクラスを流用）。
// ============================================================

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db.js";
import { getAdminContext } from "@/lib/auth.js";
import { currentYearMonth } from "@/lib/aggregate.js";
import { HelpToggle } from "../_help.js";
import {
  createClientAction,
  updateClientAction,
  createSiteAction,
  deleteSiteAction,
  createRateAction,
  deleteRateAction,
  createWorkerAction,
  updateWorkerAction,
  createOrganizationAction,
  updateOrganizationAction,
  saveInvoiceSettingAction,
  createLumpContractAction,
  setLumpContractStatusAction,
} from "../_actions.js";

export const dynamic = "force-dynamic";

const yen = (n: number) => "¥" + Math.round(n).toLocaleString("ja-JP");
const contractLabel = (t: string) => (t === "UKEOI" ? "請負" : "常用");

export default async function MastersPage() {
  const admin = await getAdminContext();
  if (!admin) redirect("/admin?error=login");

  const [
    clients,
    sites,
    rates,
    workers,
    orgs,
    setting,
    lumps,
    pendingUsers,
    tempSiteCount,
  ] = await Promise.all([
      prisma.client.findMany({ orderBy: { name: "asc" } }),
      prisma.site.findMany({
        orderBy: { name: "asc" },
        include: { client: { select: { name: true } } },
      }),
      prisma.rateCard.findMany({
        orderBy: { effectiveFrom: "desc" },
        include: {
          client: { select: { name: true } },
          site: { select: { name: true } },
        },
      }),
      prisma.worker.findMany({
        orderBy: { name: "asc" },
        include: { org: { select: { name: true } } },
      }),
      prisma.organization.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.invoiceSetting.findFirst(),
      prisma.lumpContract.findMany({
        orderBy: [{ yearMonth: "desc" }, { createdAt: "desc" }],
        include: { client: { select: { name: true } } },
      }),
      prisma.user.count({ where: { approved: false, status: "ACTIVE" } }),
      prisma.site.count({ where: { isTemporary: true, isActive: true } }),
    ]);

  const ym = currentYearMonth();

  // 初期設定チェックリスト（未完了に「次にやる」を出す）。
  const checklist: {
    key: string;
    label: string;
    href: string;
    done: boolean;
    optional?: boolean;
  }[] = [
    {
      key: "setting",
      label: "自社情報を登録",
      href: "#setting",
      done: !!setting?.issuerName?.trim(),
    },
    {
      key: "clients",
      label: "取引先を登録",
      href: "#clients",
      done: clients.some((c) => c.active),
    },
    {
      key: "workers",
      label: "職人を登録",
      href: "#workers",
      done: workers.some((w) => w.active),
    },
    { key: "rates", label: "取引先ごとに単価を登録", href: "#clients", done: clients.some((c) => c.unitPrice != null) },
    {
      key: "orgs",
      label: "協力会社を追加（任意）",
      href: "#orgs",
      done: orgs.some(
        (o) => o.kind === "PARTNER" && o.name !== "未割当（承認待ち）",
      ),
      optional: true,
    },
  ];
  const requiredItems = checklist.filter((c) => !c.optional);
  const doneCount = requiredItems.filter((c) => c.done).length;
  const nextItem = checklist.find((c) => !c.done && !c.optional);

  // セクションナビ。
  const navItems = [
    { href: "#setting", label: "自社情報" },
    { href: "#clients", label: "取引先" },
    { href: "#workers", label: "職人" },
    { href: "#orgs", label: "自社/協力会社" },
  ];

  return (
    <main className="container admin-narrow">
      <div className="page-head">
        <h1 className="page-title">マスタ管理</h1>
        <HelpToggle />
      </div>

      <p className="page-sub">
        出面入力の「選択肢」と、請求の「単価」をここで登録します。
      </p>

      {/* ❓ヘルプ ON のとき：最初にやること（順番） */}
      <div className="help-bubble">
        <b>はじめての設定は、この順番でOK。</b>
        <br />① <b>取引先</b>（仕事をもらう相手・請求先。<b>常用単価</b>もここで設定）→ ②{" "}
        <b>職人</b>（自社のメンバー。職人はLIFFからも追加できます）。
        <br />③ <b>自社情報</b>（請求書に印字）は請求書を出す前に一度だけ。
        <br />※ 現場は出面入力（LIFF）で自由入力。請負金額も出面入力で「請負」を選んだ時に入れます。
      </div>

      {/* 初期設定チェックリスト（上から順に埋めれば運用開始できる） */}
      <div className="card setup-card">
        <div className="setup-head">
          <b>初期設定</b>
          <span className="muted">
            {doneCount}/{requiredItems.length} 完了
          </span>
        </div>
        <div className="setup-list">
          {checklist.map((c) => (
            <a
              key={c.key}
              href={c.href}
              className={`setup-item ${c.done ? "is-done" : ""}`}
            >
              <span className="setup-check" aria-hidden>
                {c.done ? (
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="9" />
                  </svg>
                )}
              </span>
              <span className="setup-label">{c.label}</span>
              {!c.done && (
                <span className="setup-cta">{c.optional ? "追加" : "次にやる →"}</span>
              )}
            </a>
          ))}
        </div>
        <p className="muted setup-next">
          {nextItem
            ? `まずは「${nextItem.label.replace("を登録", "")}」から。上から順でOKです。`
            : "必須の初期設定は完了しています。あとは運用するだけ。"}
        </p>
        {(pendingUsers > 0 || tempSiteCount > 0) && (
          <div className="setup-alerts">
            {pendingUsers > 0 && (
              <a href="/admin/users" className="badge badge--review">
                承認待ち {pendingUsers}人
              </a>
            )}
            {tempSiteCount > 0 && (
              <a href="#sites" className="badge badge--review">
                要確認スポット現場 {tempSiteCount}件
              </a>
            )}
          </div>
        )}
      </div>

      {/* セクションナビ */}
      <div className="chip-wrap" style={{ marginBottom: 12 }}>
        {navItems.map((n) => (
          <a key={n.href} href={n.href} className="chip">
            {n.label}
          </a>
        ))}
      </div>

      {/* 用語の整理（「自社」の三重混在を解消） */}
      <div className="help-bubble">
        <b>用語の整理（ここが分かれば迷いません）</b>
        <br />・<b>自社情報</b>＝請求書に印字するあなたの会社情報（名前・住所・振込先）。
        <br />・<b>取引先</b>＝請求先の会社。<b>現場</b>＝内部管理用の作業場所（請求書には出ません）。
        <br />・<b>自社入力</b>（SELF組織）＝出面が自社LINEグループに投稿される入力元。
        <br />・<b>協力会社</b>（PARTNER組織）＝外部の入力元（グループには投稿されません）。
      </div>

      {/* ───────── 取引先 ───────── */}
      <div className="section-head" id="clients">
        <h2 className="section-title">取引先（Client）</h2>
      </div>
      <div className="help-bubble">
        <b>仕事をもらう相手＝請求先。</b>{" "}
        例：辻濱工業、恵興業 など。住所を入れておくと請求書に出ます。職人がLIFFで選ぶ一覧にもなります。
      </div>

      <details className="card">
        <summary className="disclosure-btn" style={{ padding: 0 }}>
          ＋ 取引先を追加
        </summary>
        <form action={createClientAction} style={{ marginTop: 12 }}>
          <div className="field">
            <label className="label">取引先名</label>
            <input className="input" name="name" required placeholder="例: ダミー商事" />
          </div>
          <div className="field">
            <label className="label">敬称</label>
            <select className="select" name="honorific" defaultValue="御中">
              <option value="御中">御中</option>
              <option value="様">様</option>
            </select>
          </div>
          <div className="field">
            <label className="label">住所（任意）</label>
            <input className="input" name="address" placeholder="例: ダミー県ダミー市1-2-3" />
          </div>
          <div className="field">
            <label className="label">常用単価（円 / 人工・任意）</label>
            <input className="input input--num" name="unitPrice" type="number" min={0} step={100} inputMode="numeric" placeholder="例: 22000" />
          </div>
          <button className="btn btn--primary" type="submit">追加</button>
        </form>
      </details>

      <div className="list">
        {clients.length === 0 && <p className="muted">取引先がありません。</p>}
        {clients.map((c) => (
          <details className="card" key={c.id}>
            <summary className="list-title" style={{ cursor: "pointer" }}>
              {c.name}
              {!c.active && (
                <span className="badge" style={{ marginLeft: 6 }}>無効</span>
              )}
            </summary>
            <form action={updateClientAction} style={{ marginTop: 12 }}>
              <input type="hidden" name="id" value={c.id} />
              <div className="field">
                <label className="label">取引先名</label>
                <input className="input" name="name" defaultValue={c.name} required />
              </div>
              <div className="field">
                <label className="label">敬称</label>
                <select className="select" name="honorific" defaultValue={c.honorific}>
                  <option value="御中">御中</option>
                  <option value="様">様</option>
                </select>
              </div>
              <div className="field">
                <label className="label">住所</label>
                <input className="input" name="address" defaultValue={c.address ?? ""} />
              </div>
              <div className="field">
                <label className="label">常用単価（円 / 人工）</label>
                <input className="input input--num" name="unitPrice" type="number" min={0} step={100} inputMode="numeric" defaultValue={c.unitPrice ?? ""} placeholder="例: 22000" />
              </div>
              <label className="inline-row" style={{ gap: 8 }}>
                <input type="checkbox" name="active" defaultChecked={c.active} />
                <span>有効</span>
              </label>
              <div style={{ marginTop: 10 }}>
                <button className="btn btn--ghost" type="submit">保存</button>
              </div>
            </form>
          </details>
        ))}
      </div>

      {/* ───────── 職人 ───────── */}
      <div className="section-head" id="workers">
        <h2 className="section-title">職人（Worker）</h2>
      </div>
      <div className="help-bubble">
        <b>出面に出すメンバー。</b>{" "}
        自社の職人（後藤・齋・金子…）を登録。LIFFの入力でタップして選ぶ名前になります。所属組織は自社（SELF）を選びます。
      </div>
      <details className="card">
        <summary className="disclosure-btn" style={{ padding: 0 }}>＋ 職人を追加</summary>
        <form action={createWorkerAction} style={{ marginTop: 12 }}>
          <div className="field">
            <label className="label">所属組織</label>
            <select className="select" name="orgId" required defaultValue="">
              <option value="" disabled>選択してください</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}（{o.kind === "SELF" ? "自社" : "協力会社"}）
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label">職人名</label>
            <input className="input" name="name" required placeholder="例: ダミー太郎" />
          </div>
          <div className="field">
            <label className="label">別名（任意）</label>
            <input className="input" name="aliases" placeholder="例: だみー太郎" />
          </div>
          <button className="btn btn--primary" type="submit">追加</button>
        </form>
      </details>
      <div className="list">
        {workers.length === 0 && <p className="muted">職人がいません。</p>}
        {workers.map((w) => (
          <details className="card" key={w.id}>
            <summary className="list-title" style={{ cursor: "pointer" }}>
              {w.name}
              <span className="muted" style={{ marginLeft: 8 }}>{w.org.name}</span>
              {!w.active && <span className="badge" style={{ marginLeft: 6 }}>無効</span>}
            </summary>
            <form action={updateWorkerAction} style={{ marginTop: 12 }}>
              <input type="hidden" name="id" value={w.id} />
              <div className="field">
                <label className="label">職人名</label>
                <input className="input" name="name" defaultValue={w.name} required />
              </div>
              <div className="field">
                <label className="label">別名</label>
                <input className="input" name="aliases" defaultValue={w.aliases.join(", ")} />
              </div>
              <label className="inline-row" style={{ gap: 8 }}>
                <input type="checkbox" name="active" defaultChecked={w.active} />
                <span>有効</span>
              </label>
              <div style={{ marginTop: 10 }}>
                <button className="btn btn--ghost" type="submit">保存</button>
              </div>
            </form>
          </details>
        ))}
      </div>

      {/* ───────── 組織 ───────── */}
      <div className="section-head" id="orgs">
        <h2 className="section-title">組織（Organization）</h2>
      </div>
      <div className="help-bubble">
        <b>自社か、協力会社か。</b>{" "}
        <b>SELF＝自分の会社</b>（出面が出面グループに自動投稿される）。
        <b>PARTNER＝協力会社</b>（管理画面の集計だけに入り、グループには出ません）。普段は自社が1つあればOK。
      </div>
      <p className="muted" style={{ marginTop: -4, marginBottom: 10 }}>
        ※ 協力会社の追加＝ここに 1 件足すだけ。ユーザー承認でその協力会社に割り当てます。
      </p>
      <details className="card">
        <summary className="disclosure-btn" style={{ padding: 0 }}>＋ 組織を追加</summary>
        <form action={createOrganizationAction} style={{ marginTop: 12 }}>
          <div className="field">
            <label className="label">組織名</label>
            <input className="input" name="name" required placeholder="例: ダミー協力 A社" />
          </div>
          <div className="field">
            <label className="label">種別</label>
            <select className="select" name="kind" defaultValue="PARTNER">
              <option value="PARTNER">協力会社</option>
              <option value="SELF">自社</option>
            </select>
          </div>
          <button className="btn btn--primary" type="submit">追加</button>
        </form>
      </details>
      <div className="list">
        {orgs.map((o) => (
          <details className="card" key={o.id}>
            <summary className="list-title" style={{ cursor: "pointer" }}>
              {o.name}
              <span className={`badge ${o.kind === "SELF" ? "badge--self" : "badge--partner"}`} style={{ marginLeft: 6 }}>
                {o.kind === "SELF" ? "自社" : "協力会社"}
              </span>
              {!o.active && <span className="badge" style={{ marginLeft: 6 }}>無効</span>}
            </summary>
            <form action={updateOrganizationAction} style={{ marginTop: 12 }}>
              <input type="hidden" name="id" value={o.id} />
              <div className="field">
                <label className="label">組織名</label>
                <input className="input" name="name" defaultValue={o.name} required />
              </div>
              <label className="inline-row" style={{ gap: 8 }}>
                <input type="checkbox" name="active" defaultChecked={o.active} />
                <span>有効</span>
              </label>
              <p className="hint">※ 種別（SELF/PARTNER）は不可逆運用のため変更不可。</p>
              <div style={{ marginTop: 10 }}>
                <button className="btn btn--ghost" type="submit">保存</button>
              </div>
            </form>
          </details>
        ))}
      </div>

      {/* ───────── 自社情報 ───────── */}
      <div className="section-head" id="setting">
        <h2 className="section-title">自社情報（請求書の差出人）</h2>
      </div>
      <div className="card">
        <form action={saveInvoiceSettingAction}>
          <div className="field">
            <label className="label">会社名</label>
            <input className="input" name="issuerName" required defaultValue={setting?.issuerName ?? ""} placeholder="例: ダミー工務店" />
          </div>
          <div className="field">
            <label className="label">住所</label>
            <input className="input" name="address" defaultValue={setting?.address ?? ""} />
          </div>
          <div className="inline-row" style={{ gap: 10 }}>
            <div className="field" style={{ flex: 1 }}>
              <label className="label">TEL</label>
              <input className="input" name="tel" defaultValue={setting?.tel ?? ""} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label className="label">Email</label>
              <input className="input" name="email" defaultValue={setting?.email ?? ""} />
            </div>
          </div>
          <div className="field">
            <label className="label">登録番号（インボイス T…）</label>
            <input className="input" name="regNumber" defaultValue={setting?.regNumber ?? ""} placeholder="T0000000000000" />
          </div>
          <div className="field">
            <label className="label">振込先</label>
            <input className="input" name="bankInfo" defaultValue={setting?.bankInfo ?? ""} placeholder="例: ダミー銀行 本店 普通 0000000" />
          </div>
          <div className="inline-row" style={{ gap: 10 }}>
            <div className="field" style={{ flex: 1 }}>
              <label className="label">税率（%）</label>
              <input
                className="input input--num"
                name="taxRatePct"
                type="number"
                min={0}
                max={100}
                step={1}
                defaultValue={Math.round((setting?.taxRate ?? 0.1) * 100)}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label className="label">担当者</label>
              <input className="input" name="contactName" defaultValue={setting?.contactName ?? ""} />
            </div>
          </div>
          <button className="btn btn--primary" type="submit">保存</button>
        </form>
      </div>

      <p className="muted" style={{ marginTop: 20 }}>
        ※ 例・初期データはすべてダミーです。実名・住所・口座はこの管理画面（DB）にのみ入力してください。
      </p>
    </main>
  );
}

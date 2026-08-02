// ============================================================
// /admin/check — 月次データチェック（重複の検出と掃除）
//
//   集計のずれの2大原因を、月単位で洗い出してその場で直すための画面。
//     A) 同日×同取引先×同現場の出面が2件以上 …「二重登録の疑い」
//        （LINE 上限で投稿できなかった期間の後日まとめ入力などで発生）
//     B) 同じ職人が同日に複数の出面に登場 … 現場名の表記揺れで A に
//        引っかからない二重登録を拾う網
//   各カードから既存の編集モーダル・削除（confirm 付き）をそのまま使う。
//
//   前提の周知もここで行う:
//     ・LINE の送信取り消し/削除はアプリのデータには影響しない
//     ・LINE 投稿に失敗しても出面は保存済み（postedToGroup=false になるだけ）
//
//   ガード: getAdminContext()。スコープ管理者は自組織のみ（scopeWhere）。
// ============================================================

import { prisma } from "@/lib/db.js";
import { getAdminContext, adminScopeOrgId } from "@/lib/auth.js";
import { currentYearMonth, monthRange } from "@/lib/aggregate.js";
import { EditReportButton } from "../_editReport.js";
import { ConfirmDeleteButton } from "../_confirmDelete.js";
import { deleteReportAction } from "../_actions.js";

export const dynamic = "force-dynamic";

const ymStr = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const WEEKDAY_JP = ["日", "月", "火", "水", "木", "金", "土"] as const;
/** 出面日（UTC 0時保存）を "M/D(曜)" で。前日/翌日にズレないよう UTC で読む。 */
const mdW = (d: Date) =>
  `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAY_JP[d.getUTCDay()]})`;
/** 入力日時（createdAt）を JST の "M/D HH:mm" で表示。 */
const jstDateTime = (d: Date) =>
  d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

interface CheckReport {
  id: string;
  workDate: Date;
  createdAt: Date;
  status: "CONFIRMED" | "NEEDS_REVIEW";
  postedToGroup: boolean;
  clientName: string;
  siteLabel: string;
  orgKind: "SELF" | "PARTNER";
  orgName: string;
  creatorName: string;
  /** 出面日から入力までの経過日数（2日以上＝後日入力の疑い）。 */
  lagDays: number;
  names: string;
  manDays: number;
  otHours: number;
  workerIds: string[];
}

/** 重複グループのキー: 同日×同取引先×同現場（現場名は trim 一致）。 */
const dupKey = (r: CheckReport) =>
  `${r.workDate.toISOString().slice(0, 10)}|${r.clientName}|${r.siteLabel}`;

function ReportCard({ r }: { r: CheckReport }) {
  return (
    <div className="review-card">
      <div className="review-body">
        <div className="review-title">
          <span className="review-date">{mdW(r.workDate)}</span>
          {r.clientName}
          {r.orgKind === "PARTNER" && (
            <span className="badge badge--partner">協力会社</span>
          )}
          {r.status === "NEEDS_REVIEW" && (
            <span className="badge badge--review">要確認（集計対象外）</span>
          )}
          {r.lagDays >= 2 && (
            <span className="badge badge--review">後日入力 +{r.lagDays}日</span>
          )}
        </div>
        <div className="review-meta">{r.siteLabel || "(現場未設定)"}</div>
        {r.names && <div className="review-names">{r.names}</div>}
        <div className="review-figs">
          <span>
            人工 <b>{r.manDays}</b>
          </span>
          {r.otHours > 0 && (
            <span>
              残業 <b>{r.otHours}</b>h
            </span>
          )}
          <span className="muted">
            入力: {r.creatorName}・{jstDateTime(r.createdAt)}
            {r.postedToGroup ? "・LINE投稿済" : "・LINE未投稿"}
          </span>
        </div>
      </div>
      <div className="review-actions">
        <EditReportButton reportId={r.id} variant="review" />
        <ConfirmDeleteButton
          action={deleteReportAction}
          id={r.id}
          confirmText={`${mdW(r.workDate)} ${r.clientName} ${
            r.siteLabel || "(現場未設定)"
          } の出面を削除します。集計からも消えます。よろしいですか？`}
        />
      </div>
    </div>
  );
}

export default async function CheckPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string }>;
}) {
  const sp = await searchParams;
  const admin = await getAdminContext();
  if (!admin) {
    // 未ログインはホームのログイン画面へ（ここでは画面を持たない）。
    return (
      <main className="container container--admin">
        <p>
          管理者ログインが必要です。<a href="/admin">ホームからログイン</a>
          してください。
        </p>
      </main>
    );
  }

  const ym = sp.ym && /^\d{4}-\d{2}$/.test(sp.ym) ? sp.ym : currentYearMonth();
  const { from, to } = monthRange(ym);
  const scopeOrgId = adminScopeOrgId(admin);
  const scopeWhere = scopeOrgId ? { orgId: scopeOrgId } : {};

  const raw = await prisma.report.findMany({
    where: { workDate: { gte: from, lt: to }, ...scopeWhere },
    orderBy: [{ workDate: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      workDate: true,
      createdAt: true,
      status: true,
      postedToGroup: true,
      siteName: true,
      createdById: true,
      client: { select: { name: true } },
      site: { select: { name: true } },
      org: { select: { name: true, kind: true } },
      entries: {
        select: {
          manDays: true,
          otHours: true,
          worker: { select: { id: true, name: true } },
        },
      },
    },
  });

  // 入力者名（Report.createdById は素の String なのでまとめて引く）。
  const creatorIds = Array.from(new Set(raw.map((r) => r.createdById)));
  const creators = creatorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: creatorIds } },
        select: { id: true, displayName: true },
      })
    : [];
  const creatorById = new Map(creators.map((u) => [u.id, u.displayName]));

  const reports: CheckReport[] = raw.map((r) => ({
    id: r.id,
    workDate: r.workDate,
    createdAt: r.createdAt,
    status: r.status,
    postedToGroup: r.postedToGroup,
    clientName: r.client.name,
    siteLabel: (r.siteName || r.site?.name || "").trim(),
    orgKind: r.org.kind,
    orgName: r.org.name,
    creatorName: creatorById.get(r.createdById) ?? "(不明)",
    lagDays: Math.floor(
      (r.createdAt.getTime() - r.workDate.getTime()) / 86_400_000,
    ),
    names: r.entries
      .map((e) => e.worker?.name)
      .filter(Boolean)
      .join("　"),
    manDays: r.entries.reduce((a, e) => a + Number(e.manDays || 0), 0),
    otHours: r.entries.reduce((a, e) => a + Number(e.otHours || 0), 0),
    workerIds: r.entries.map((e) => e.worker?.id).filter((v): v is string => Boolean(v)),
  }));

  // ── A) 二重登録の疑い: 同日×同取引先×同現場で2件以上 ──
  const byDup = new Map<string, CheckReport[]>();
  for (const r of reports) {
    const k = dupKey(r);
    byDup.set(k, [...(byDup.get(k) ?? []), r]);
  }
  const dupGroups = Array.from(byDup.values()).filter((g) => g.length >= 2);
  const dupGroupKeys = new Set(dupGroups.map((g) => dupKey(g[0])));

  // 「重複が全部二重登録だった場合」の余剰人工の目安（各グループで最大の1件を残す想定）。
  const excessManDays = dupGroups.reduce((a, g) => {
    const total = g.reduce((s, r) => s + r.manDays, 0);
    const keep = Math.max(...g.map((r) => r.manDays));
    return a + (total - keep);
  }, 0);

  // ── B) 同一職人が同日に複数の出面に登場（表記揺れで A に出ない二重の網）──
  //   その職人×日の出面が全部「同じ A グループ」に属する場合は A で見えるので省く。
  const workerNameById = new Map<string, string>();
  for (const r of raw) {
    for (const e of r.entries) {
      if (e.worker) workerNameById.set(e.worker.id, e.worker.name);
    }
  }
  const byWorkerDay = new Map<string, { workerId: string; date: Date; reports: CheckReport[] }>();
  for (const r of reports) {
    const dateStr = r.workDate.toISOString().slice(0, 10);
    for (const workerId of r.workerIds) {
      const k = `${dateStr}|${workerId}`;
      const cur = byWorkerDay.get(k);
      if (cur) {
        if (!cur.reports.some((x) => x.id === r.id)) cur.reports.push(r);
      } else {
        byWorkerDay.set(k, { workerId, date: r.workDate, reports: [r] });
      }
    }
  }
  const workerDayDups = Array.from(byWorkerDay.values())
    .filter((v) => v.reports.length >= 2)
    .filter((v) => {
      const keys = new Set(v.reports.map(dupKey));
      // 全件が同一の A グループ → A の一覧で対応できるため省略。
      return !(keys.size === 1 && dupGroupKeys.has(dupKey(v.reports[0])));
    })
    .map((v) => ({ ...v, workerName: workerNameById.get(v.workerId) ?? "(不明)" }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  // 月ナビ。
  const prev = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  const isCurrentMonth = ym === currentYearMonth();

  return (
    <main className="container container--admin">
      <div className="page-head">
        <h1 className="page-title">データチェック</h1>
      </div>

      {/* 月スイッチャー（ホームと同じ操作感） */}
      <div className="month-switch">
        <a className="month-nav" href={`/admin/check?ym=${ymStr(prev)}`} aria-label="前月">
          ◀
        </a>
        <span className="ym">
          {ym}
          {isCurrentMonth && <span className="ym-now">今月</span>}
        </span>
        <a className="month-nav" href={`/admin/check?ym=${ymStr(next)}`} aria-label="翌月">
          ▶
        </a>
      </div>

      {/* 前提の周知（集計ずれの2大原因） */}
      <div className="notice" style={{ marginBottom: 16 }}>
        <p style={{ margin: 0 }}>
          <b>LINE の送信取り消し・削除では、アプリの出面は消えません。</b>
          出面を消すときは、この画面か編集画面の「削除」を使ってください。
        </p>
        <p style={{ margin: "6px 0 0" }}>
          また、LINE の通数上限などで<b>グループ投稿に失敗しても出面は保存済み</b>です
          （ホームの「未投稿」から再投稿できます）。後からもう一度入力すると二重登録に
          なるので、下の一覧で重複を確認して不要な方を削除してください。
        </p>
      </div>

      {/* サマリ */}
      <section className="block">
        <div className="section-head">
          <h2 className="section-title">この月の状態</h2>
        </div>
        <p style={{ margin: 0 }}>
          出面 <b>{reports.length}</b> 件 ／ 二重登録の疑い{" "}
          <b>{dupGroups.length}</b> 組（
          全て二重だった場合の余剰は約 <b>{excessManDays}</b> 人工）／
          同一職人の同日重複 <b>{workerDayDups.length}</b> 件
        </p>
        <p className="muted" style={{ margin: "6px 0 0" }}>
          削除後は「集計」（
          <a href={`/admin/aggregate?ym=${ym}`}>{ym} の集計を見る</a>
          ）で数字が合っているか確認してください。
        </p>
      </section>

      {/* A) 二重登録の疑い */}
      <section className="block">
        <div className="section-head">
          <h2 className="section-title">
            二重登録の疑い（同日・同取引先・同現場）{" "}
            {dupGroups.length > 0 && (
              <span className="badge badge--review">{dupGroups.length}組</span>
            )}
          </h2>
        </div>
        {dupGroups.length === 0 ? (
          <div className="empty-ok">重複の疑いはありません。</div>
        ) : (
          dupGroups.map((g) => (
            <div key={dupKey(g[0])} style={{ marginBottom: 16 }}>
              <div className="review-meta" style={{ marginBottom: 6 }}>
                {mdW(g[0].workDate)} {g[0].clientName}{" "}
                {g[0].siteLabel || "(現場未設定)"} — {g.length}件（合計{" "}
                {g.reduce((a, r) => a + r.manDays, 0)}人工）。
                入力日時を見比べて、残す1件以外を削除してください。
              </div>
              <div className="review-list">
                {g.map((r) => (
                  <ReportCard key={r.id} r={r} />
                ))}
              </div>
            </div>
          ))
        )}
      </section>

      {/* B) 同一職人の同日重複（現場名の表記揺れ対策の網） */}
      <section className="block">
        <div className="section-head">
          <h2 className="section-title">
            同一職人が同日に複数の出面{" "}
            {workerDayDups.length > 0 && (
              <span className="badge badge--review">{workerDayDups.length}件</span>
            )}
          </h2>
        </div>
        {workerDayDups.length === 0 ? (
          <div className="empty-ok">該当はありません。</div>
        ) : (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              応援などで正しい場合もあります。現場名の書き方だけ違う二重登録が
              紛れていないか確認してください。
            </p>
            {workerDayDups.map((v) => (
              <div key={`${v.date.toISOString()}|${v.workerId}`} style={{ marginBottom: 16 }}>
                <div className="review-meta" style={{ marginBottom: 6 }}>
                  {mdW(v.date)} {v.workerName} — {v.reports.length}件の出面に登場
                </div>
                <div className="review-list">
                  {v.reports.map((r) => (
                    <ReportCard key={`${v.workerId}-${r.id}`} r={r} />
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
      </section>
    </main>
  );
}

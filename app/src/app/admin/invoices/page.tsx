// ============================================================
// /admin/invoices — 請求書 一覧 / 生成（Server Component ＋ Server Action）
//   モバイルファースト。サーバ側ロジック（ガード・集計・生成）は従来どおり。
//
//   ガード: getAdminContext()。
//   - 月選択（?ym=YYYY-MM、既定=当月）＋ 月スイッチャー。
//   - その月に出面のある取引先を一覧し、各取引先の概算（@/lib/invoice 経由）を表示。
//   - 「請求書を作成 / 再作成」（Server Action generateInvoiceAction）で
//     Invoice + InvoiceLine をスナップショット保存。
//   - 既存 Invoice には CSV / xlsx ダウンロードリンク（/api/invoices/[id]/export）。
// ============================================================

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db.js";
import { getAdminContext } from "@/lib/auth.js";
import { GenerateInvoiceButton } from "./_generateButton.js";
import { InvoiceTable, type InvoiceTableRow } from "./_invoiceTable.js";
import {
  currentYearMonth,
  loadMonthRows,
  monthRange,
} from "@/lib/aggregate.js";
import {
  buildClientInvoiceLines,
  clientsWithDefaultRate,
  getMonthClientDetails,
} from "@/lib/invoiceService.js";
import { summarize, type InvoiceLine } from "@/lib/invoice.js";

export const dynamic = "force-dynamic";

const yen = (n: number) => "¥" + Math.round(n).toLocaleString("ja-JP");
const ymStr = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/** 内訳の小表（現場別/職人別/日別）。確認用。 */
function BreakdownTable({
  title,
  rows,
}: {
  title: string;
  rows: { name: string; manDays: number; otHours: number }[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="bd-block">
      <div className="bd-title">{title}</div>
      <table className="mini-table">
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td>{r.name}</td>
              <td className="num">{r.manDays} 人工</td>
              <td className="num">{r.otHours ? `残 ${r.otHours}h` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// 型: summaries の 1 要素（プレビュー明細つき）。
type ClientSummary = {
  clientId: string;
  name: string;
  lines: InvoiceLine[];
  total: number;
  subtotal: number;
  exempt: number;
  rateMissing: boolean;
};
type ClientDetail = {
  manDays: number;
  otHours: number;
  needsReview: number;
  bySite: { name: string; manDays: number; otHours: number }[];
  byWorker: { name: string; manDays: number; otHours: number }[];
  byDay: { name: string; manDays: number; otHours: number }[];
};
type ExistingInvoice = { id: string; invoiceNo: string; status: string };

// プレビュー明細（外向き・現場名は出ない）。PC テーブルの展開行 / スマホカード共用。
function PreviewBlock({ lines }: { lines: InvoiceLine[] }) {
  return (
    <>
      {lines.length === 0 ? (
        <p className="muted">明細がありません（単価・出面を確認）。</p>
      ) : (
        <table className="mini-table">
          <thead>
            <tr>
              <th>品目</th>
              <th className="num">数量</th>
              <th className="num">単価</th>
              <th className="num">金額</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.sortNo}>
                <td>{l.itemName}</td>
                <td className="num">
                  {l.qty}
                  {l.unitLabel}
                </td>
                <td className="num">{yen(l.unitPrice)}</td>
                <td className="num">{yen(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// 既存 Invoice の番号＋再ダウンロード。PC テーブルの操作セル / スマホカード共用。
function InvoiceMeta({ iv }: { iv: ExistingInvoice }) {
  return (
    <div className="inv-no-line">
      請求書番号 <strong>{iv.invoiceNo}</strong>
      <a
        href={`/api/invoices/${iv.id}/export?format=xlsx`}
        className="btn btn--ghost btn--sm"
        style={{ marginLeft: 8 }}
      >
        xlsx 再ダウンロード
      </a>
    </div>
  );
}


export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string; error?: string }>;
}) {
  const admin = await getAdminContext();
  if (!admin) {
    // middleware で保護済みだが、念のためログイン画面へ集約。
    redirect("/admin?error=login");
  }

  const sp = await searchParams;
  const ym = sp.ym && /^\d{4}-\d{2}$/.test(sp.ym) ? sp.ym : currentYearMonth();
  const { from, to } = monthRange(ym);

  const setting = await prisma.invoiceSetting.findFirst();
  const taxRate = setting?.taxRate ?? 0.1;

  // 当月の請求候補となる取引先 = 次の和集合（漏れ防止）:
  //   ・確定済み出面がある取引先（loadMonthRows）
  //   ・要確認も含め何らかの出面がある取引先（getMonthClientDetails）
  //   ・有効な請負契約(LumpContract)がある取引先
  //   ・既に請求書がある取引先
  // これで「請負契約だけ」「既存請求書だけ」「要確認だけ」の取引先も漏れず出る。
  const [rows, existingInvoices, lumps, details] = await Promise.all([
    loadMonthRows(ym),
    prisma.invoice.findMany({
      where: { yearMonth: ym },
      select: { id: true, clientId: true, invoiceNo: true, status: true },
    }),
    prisma.lumpContract.findMany({
      where: { yearMonth: ym, status: "ACTIVE" },
      select: { clientId: true },
    }),
    getMonthClientDetails(ym),
  ]);
  const invoiceByClient = new Map(
    existingInvoices.map((iv) => [iv.clientId, iv]),
  );

  // 候補 clientId の和集合 → 名前をまとめ取りして id→name の Map に。
  const candidateIds = new Set<string>();
  for (const r of rows) candidateIds.add(r.clientId);
  for (const id of details.keys()) candidateIds.add(id);
  for (const iv of existingInvoices) candidateIds.add(iv.clientId);
  for (const l of lumps) candidateIds.add(l.clientId);
  const clientRecords = await prisma.client.findMany({
    where: { id: { in: Array.from(candidateIds) } },
    select: { id: true, name: true },
  });
  const clientMap = new Map(clientRecords.map((c) => [c.id, c.name]));

  // 既定単価が登録済みの取引先（未登録＝委託料/残業が0円になる→警告表示用）。
  const ratedClients = await clientsWithDefaultRate(
    Array.from(clientMap.keys()),
    to,
  );

  // 各取引先の概算合計（税込）。exempt＝立替（対象外）ぶん。lines＝プレビュー用の外向き明細。
  const summaries = await Promise.all(
    Array.from(clientMap.entries()).map(async ([clientId, name]) => {
      const lines = await buildClientInvoiceLines(clientId, ym, taxRate);
      const s = summarize(lines, taxRate);
      // 人工（委託料・現場行）や残業代は単価に依存する＝単価未設定だと¥0請求になる。
      // 新フォーマットでは品目名が「○月委託料（日勤）」「現場名」「残業代」等になるため、
      // 単位ラベル（人工/時間）で労務行を判定する（請負＝式・立替は対象外）。
      const hasLabor = lines.some(
        (l) => l.unitLabel === "人工" || l.unitLabel === "時間",
      );
      return {
        clientId,
        name,
        lines,
        total: s.total,
        subtotal: s.subtotal,
        exempt: s.exempt,
        rateMissing: hasLabor && !ratedClients.has(clientId),
      };
    }),
  );
  summaries.sort((a, b) => a.name.localeCompare(b.name, "ja"));

  const anyRateMissing = summaries.some((s) => s.rateMissing);

  // 月ナビ。
  const prev = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));

  // PC（≥1024px）一覧テーブル用の行データ。展開行・操作セルの中身は
  // サーバ側で組み立て、クライアント側 InvoiceTable へ ReactNode として渡す。
  const invoiceRows: InvoiceTableRow[] = summaries.map((s: ClientSummary) => {
    const iv = invoiceByClient.get(s.clientId);
    const d: ClientDetail | undefined = details.get(s.clientId);
    return {
      clientId: s.clientId,
      name: s.name,
      status: iv ? iv.status : null,
      manDays: d?.manDays ?? 0,
      otHours: d?.otHours ?? 0,
      needsReview: d?.needsReview ?? 0,
      total: s.total,
      exempt: s.exempt,
      rateMissing: s.rateMissing,
      detail: (
        <>
          <div className="inv-detail-block">
            <div className="inv-detail-h">プレビュー（請求書の明細）</div>
            <PreviewBlock lines={s.lines} />
          </div>
          {d && (d.bySite.length > 0 || d.byWorker.length > 0) && (
            <div className="inv-detail-block">
              <div className="inv-detail-h">内訳（現場別・職人別・日別）</div>
              <BreakdownTable title="現場別" rows={d.bySite} />
              <BreakdownTable title="職人別" rows={d.byWorker} />
              <BreakdownTable title="日別" rows={d.byDay} />
            </div>
          )}
        </>
      ),
      actions: (
        <>
          {iv && <InvoiceMeta iv={iv} />}
          <GenerateInvoiceButton clientId={s.clientId} ym={ym} />
        </>
      ),
    };
  });

  return (
    <main className="container admin-narrow">
      <div className="page-head">
        <h1 className="page-title">請求書</h1>
      </div>

      {/* ステップ（迷わない導線） */}
      <ol className="steps">
        <li className="step is-on">
          <span className="step-n">1</span>月を選択
        </li>
        <li className="step">
          <span className="step-n">2</span>取引先を確認
        </li>
        <li className="step">
          <span className="step-n">3</span>プレビュー
        </li>
        <li className="step">
          <span className="step-n">4</span>発行 / 出力
        </li>
      </ol>

      {sp.error === "generate" && (
        <div className="notice notice--error" style={{ marginBottom: 12 }}>
          請求書の作成に失敗しました。お手数ですが、もう一度お試しください。
        </div>
      )}
      {anyRateMissing && (
        <div className="notice notice--warn" style={{ marginBottom: 12 }}>
          単価が未設定の取引先があります。<a href="/admin/masters">設定</a>から確認してください。
        </div>
      )}

      {/* 月スイッチャー */}
      <div className="month-switch">
        <a
          className="month-nav"
          href={`/admin/invoices?ym=${ymStr(prev)}`}
          aria-label="前月"
        >
          ◀
        </a>
        <span className="ym">{ym}</span>
        <a
          className="month-nav"
          href={`/admin/invoices?ym=${ymStr(next)}`}
          aria-label="翌月"
        >
          ▶
        </a>
      </div>

      {summaries.length === 0 ? (
        <p className="muted">この月に出面データのある取引先はありません。</p>
      ) : (
        <>
          {/* PC（≥1024px）: 一覧テーブル。各行から「詳細」で展開。 */}
          <InvoiceTable rows={invoiceRows} />

          {/* スマホ（<1024px）: 既存のカード表示を維持。 */}
          <div className="inv-cards">
            {summaries.map((s) => {
              const iv = invoiceByClient.get(s.clientId);
              const d = details.get(s.clientId);
              return (
                <div className="card" key={s.clientId}>
                  <div className="list-row" style={{ padding: 0, border: "none" }}>
                    <div className="list-main">
                      <div className="list-title">{s.name}</div>
                      <div className="list-meta">
                        人工 <b>{d?.manDays ?? 0}</b> ・ 残業{" "}
                        <b>{d?.otHours ?? 0}</b>h
                        {d && d.needsReview > 0 && (
                          <span
                            className="badge badge--review"
                            style={{ marginLeft: 6 }}
                          >
                            要確認 {d.needsReview}
                          </span>
                        )}
                      </div>
                      <div className="list-meta">
                        概算（税込）{" "}
                        <strong style={{ color: "var(--ink)" }}>
                          {yen(s.total)}
                        </strong>
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      {iv ? (
                        <span className="badge badge--self">{iv.status}</span>
                      ) : (
                        <span className="badge">未作成</span>
                      )}
                      {s.rateMissing && (
                        <div>
                          <span
                            className="badge badge--review"
                            style={{ marginTop: 4 }}
                          >
                            単価未登録
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* プレビュー（外向き明細・現場名は出ない） */}
                  <details className="acc" style={{ marginTop: 10 }}>
                    <summary>プレビュー（請求書の明細）</summary>
                    <div className="acc-body">
                      <PreviewBlock lines={s.lines} />
                    </div>
                  </details>

                  {/* 内訳を見る（現場別・職人別・日別／確認用） */}
                  {d && (d.bySite.length > 0 || d.byWorker.length > 0) && (
                    <details className="acc">
                      <summary>内訳を見る（現場別・職人別・日別）</summary>
                      <div className="acc-body">
                        <BreakdownTable title="現場別" rows={d.bySite} />
                        <BreakdownTable title="職人別" rows={d.byWorker} />
                        <BreakdownTable title="日別" rows={d.byDay} />
                      </div>
                    </details>
                  )}

                  {iv && <InvoiceMeta iv={iv} />}

                  <GenerateInvoiceButton clientId={s.clientId} ym={ym} />
                </div>
              );
            })}
          </div>
        </>
      )}
    </main>
  );
}

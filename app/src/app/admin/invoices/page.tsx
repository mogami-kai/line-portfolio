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

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db.js";
import { getAdminContext } from "@/lib/auth.js";
import {
  currentYearMonth,
  loadMonthRows,
  monthRange,
} from "@/lib/aggregate.js";
import {
  buildClientInvoiceLines,
  clientsWithDefaultRate,
  generateInvoice,
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

// ── Server Action: 請求書生成/再生成 ──
async function generateInvoiceAction(formData: FormData) {
  "use server";
  const admin = await getAdminContext();
  if (!admin) throw new Error("FORBIDDEN");
  const clientId = String(formData.get("clientId") ?? "");
  const ym = String(formData.get("ym") ?? "");
  if (!clientId || !/^\d{4}-\d{2}$/.test(ym)) throw new Error("BAD_INPUT");
  // 生成失敗（例: 採番衝突の連続）でも画面をクラッシュさせず、エラー表示に集約する。
  let ok = true;
  try {
    await generateInvoice(clientId, ym);
  } catch (e) {
    console.error("[invoices] generateInvoice failed", e);
    ok = false;
  }
  if (!ok) redirect(`/admin/invoices?ym=${ym}&error=generate`);
  revalidatePath("/admin/invoices");
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

  // 当月に出面のある取引先（id, name）を抽出。
  const rows = await loadMonthRows(ym);
  const clientMap = new Map<string, string>();
  for (const r of rows) {
    if (!clientMap.has(r.clientId)) clientMap.set(r.clientId, r.clientName);
  }

  const setting = await prisma.invoiceSetting.findFirst();
  const taxRate = setting?.taxRate ?? 0.1;

  // 既存 Invoice（この月）。
  const existingInvoices = await prisma.invoice.findMany({
    where: { yearMonth: ym },
    select: { id: true, clientId: true, invoiceNo: true, status: true },
  });
  const invoiceByClient = new Map(
    existingInvoices.map((iv) => [iv.clientId, iv]),
  );

  // 既定単価が登録済みの取引先（未登録＝委託料/残業が0円になる→警告表示用）。
  // 内訳（現場別/職人別/日別・要確認件数）も当月1クエリでまとめ取り。
  const [ratedClients, details] = await Promise.all([
    clientsWithDefaultRate(Array.from(clientMap.keys()), to),
    getMonthClientDetails(ym),
  ]);

  // 各取引先の概算合計（税込）。exempt＝立替（対象外）ぶん。lines＝プレビュー用の外向き明細。
  const summaries = await Promise.all(
    Array.from(clientMap.entries()).map(async ([clientId, name]) => {
      const lines = await buildClientInvoiceLines(clientId, ym, taxRate);
      const s = summarize(lines, taxRate);
      const hasLabor = lines.some(
        (l) => l.itemName.endsWith("委託料") || l.itemName === "残業",
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

  const grandTotal = summaries.reduce((a, s) => a + s.total, 0);
  const anyRateMissing = summaries.some((s) => s.rateMissing);

  // 月ナビ。
  const prev = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));

  return (
    <main className="container">
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
          単価が未登録の取引先があります（委託料・残業が ¥0 になります）。{" "}
          <a href="/admin/masters">マスタ管理 → 単価</a> で登録してください。
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

      {/* 当月合計 */}
      <div className="stat-grid">
        <div className="stat stat--accent stat--wide">
          <div className="stat-k">当月 請求 概算合計（税込）</div>
          <div className="stat-v">{yen(grandTotal)}</div>
        </div>
      </div>

      {summaries.length === 0 ? (
        <p className="muted">この月に出面データのある取引先はありません。</p>
      ) : (
        summaries.map((s) => {
          const iv = invoiceByClient.get(s.clientId);
          const d = details.get(s.clientId);
          return (
            <div className="card" key={s.clientId}>
              <div className="list-row" style={{ padding: 0, border: "none" }}>
                <div className="list-main">
                  <div className="list-title">{s.name}</div>
                  <div className="list-meta">
                    人工 <b>{d?.manDays ?? 0}</b> ・ 残業 <b>{d?.otHours ?? 0}</b>h
                    {d && d.needsReview > 0 && (
                      <span className="badge badge--review" style={{ marginLeft: 6 }}>
                        要確認 {d.needsReview}
                      </span>
                    )}
                  </div>
                  <div className="list-meta">
                    概算（税込）{" "}
                    <strong style={{ color: "var(--ink)" }}>
                      {yen(s.total)}
                    </strong>
                    {s.exempt > 0 && (
                      <span className="muted">　うち立替 {yen(s.exempt)}</span>
                    )}
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
                      <span className="badge badge--review" style={{ marginTop: 4 }}>
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
                  {s.lines.length === 0 ? (
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
                        {s.lines.map((l) => (
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
                  <p className="hint">
                    ※ 現場名は外向き請求書に出ません。根拠は下の「内訳を見る」で確認できます。
                  </p>
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

              {iv && (
                <div
                  className="list-meta"
                  style={{ marginTop: 10, marginBottom: 4 }}
                >
                  請求書番号 <strong>{iv.invoiceNo}</strong>
                  <span style={{ margin: "0 10px", color: "var(--line)" }}>
                    |
                  </span>
                  <a href={`/api/invoices/${iv.id}/export?format=xlsx`}>
                    請求書(Excel)
                  </a>
                  <span style={{ margin: "0 8px", color: "var(--ink-3)" }}>
                    /
                  </span>
                  <a href={`/api/invoices/${iv.id}/export?format=csv`}>
                    CSV(会計取込)
                  </a>
                </div>
              )}

              <form action={generateInvoiceAction} style={{ marginTop: 12 }}>
                <input type="hidden" name="clientId" value={s.clientId} />
                <input type="hidden" name="ym" value={ym} />
                <button
                  type="submit"
                  className={`btn ${iv ? "btn--ghost" : "btn--primary"}`}
                >
                  {iv ? "請求書を再作成" : "請求書を作成"}
                </button>
              </form>
            </div>
          );
        })
      )}

      <p className="muted" style={{ marginTop: 16 }}>
        ※ 明細は取引先ごとに「委託料（人工合計 × 単価）＋ 残業（合計時間 × 残業単価）＋
        立替経費」で自動計算。単価は{" "}
        <a href="/admin/masters">マスタ管理 → 単価</a>{" "}
        に入れた取引先の単価を使います（現場は問いません）。請負（UKEOI）金額は{" "}
        <a href="/admin/masters#lumps">マスタ管理 → 請負金額</a>{" "}
        に登録した対象月の契約が「一式」明細として取り込まれます。
      </p>
    </main>
  );
}

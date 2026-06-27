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
  generateInvoice,
} from "@/lib/invoiceService.js";
import { summarize } from "@/lib/invoice.js";

export const dynamic = "force-dynamic";

const yen = (n: number) => "¥" + Math.round(n).toLocaleString("ja-JP");
const ymStr = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

// ── Server Action: 請求書生成/再生成 ──
async function generateInvoiceAction(formData: FormData) {
  "use server";
  const admin = await getAdminContext();
  if (!admin) throw new Error("FORBIDDEN");
  const clientId = String(formData.get("clientId") ?? "");
  const ym = String(formData.get("ym") ?? "");
  if (!clientId || !/^\d{4}-\d{2}$/.test(ym)) throw new Error("BAD_INPUT");
  await generateInvoice(clientId, ym);
  revalidatePath("/admin/invoices");
}

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string }>;
}) {
  const admin = await getAdminContext();
  if (!admin) {
    // middleware で保護済みだが、念のためログイン画面へ集約。
    redirect("/admin?error=login");
  }

  const sp = await searchParams;
  const ym = sp.ym && /^\d{4}-\d{2}$/.test(sp.ym) ? sp.ym : currentYearMonth();

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

  // 各取引先の概算合計（税込）。
  const summaries = await Promise.all(
    Array.from(clientMap.entries()).map(async ([clientId, name]) => {
      const lines = await buildClientInvoiceLines(clientId, ym, taxRate);
      const s = summarize(lines, taxRate);
      return { clientId, name, total: s.total, subtotal: s.subtotal };
    }),
  );
  summaries.sort((a, b) => a.name.localeCompare(b.name, "ja"));

  const grandTotal = summaries.reduce((a, s) => a + s.total, 0);

  // 月ナビ。
  const { from } = monthRange(ym);
  const prev = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));

  return (
    <main className="container">
      <div className="page-head">
        <h1 className="page-title">請求書</h1>
        <a href={`/admin?ym=${ym}`} className="badge">
          ← 集計
        </a>
      </div>

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
          return (
            <div className="card" key={s.clientId}>
              <div className="list-row" style={{ padding: 0, border: "none" }}>
                <div className="list-main">
                  <div className="list-title">{s.name}</div>
                  <div className="list-meta">
                    概算（税込）{" "}
                    <strong style={{ color: "var(--ink)" }}>
                      {yen(s.total)}
                    </strong>
                  </div>
                </div>
                <div>
                  {iv ? (
                    <span className="badge badge--self">{iv.status}</span>
                  ) : (
                    <span className="badge">未作成</span>
                  )}
                </div>
              </div>

              {iv && (
                <div
                  className="list-meta"
                  style={{ marginTop: 10, marginBottom: 4 }}
                >
                  請求書番号 <strong>{iv.invoiceNo}</strong>
                  <span style={{ margin: "0 10px", color: "var(--line)" }}>
                    |
                  </span>
                  <a href={`/api/invoices/${iv.id}/export?format=csv`}>
                    CSV
                  </a>
                  <span style={{ margin: "0 8px", color: "var(--ink-3)" }}>
                    /
                  </span>
                  <a href={`/api/invoices/${iv.id}/export?format=xlsx`}>
                    xlsx
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

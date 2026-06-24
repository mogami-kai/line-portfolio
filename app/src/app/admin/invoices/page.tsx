// ============================================================
// /admin/invoices — 請求書 一覧 / 生成（Server Component ＋ Server Action）
//
//   ガード: getAdminContext()。
//   - 月選択（?ym=YYYY-MM、既定=当月）。
//   - その月に出面のある取引先を一覧し、各取引先の概算（@/lib/invoice 経由）を表示。
//   - 「生成/再生成」ボタン（Server Action generateInvoiceAction）で
//     Invoice + InvoiceLine をスナップショット保存。
//   - 既存 Invoice には CSV / xlsx ダウンロードリンク（/api/invoices/[id]/export）。
// ============================================================

import type { CSSProperties } from "react";
import { revalidatePath } from "next/cache";
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

const wrap: CSSProperties = {
  maxWidth: 980,
  margin: "0 auto",
  padding: 24,
  fontFamily:
    "system-ui, -apple-system, 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif",
  color: "#1a1a1a",
};
const th: CSSProperties = {
  textAlign: "left",
  borderBottom: "2px solid #ddd",
  padding: "6px 10px",
  fontSize: 13,
};
const td: CSSProperties = {
  borderBottom: "1px solid #eee",
  padding: "6px 10px",
  fontSize: 14,
};
const tdNum: CSSProperties = { ...td, textAlign: "right" };

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
    return (
      <main style={wrap}>
        <h1 style={{ fontSize: 20 }}>請求書</h1>
        <p style={{ color: "#b00020" }}>
          管理者が未設定/未承認です（<code>ADMIN_LINE_USER_IDS</code> を設定してください）。
        </p>
      </main>
    );
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

  // 月ナビ。
  const { from } = monthRange(ym);
  const prev = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  const ymStr = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

  return (
    <main style={wrap}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <h1 style={{ fontSize: 20, margin: 0 }}>請求書（{ym}）</h1>
        <nav style={{ fontSize: 14 }}>
          <a href="/admin">← 集計に戻る</a>
        </nav>
      </div>

      <p style={{ fontSize: 14, margin: "8px 0 16px" }}>
        <a href={`/admin/invoices?ym=${ymStr(prev)}`}>← {ymStr(prev)}</a>
        <span style={{ margin: "0 12px", color: "#999" }}>|</span>
        <a href={`/admin/invoices?ym=${ymStr(next)}`}>{ymStr(next)} →</a>
      </p>

      {summaries.length === 0 ? (
        <p style={{ color: "#888" }}>この月に出面データのある取引先はありません。</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={th}>取引先</th>
              <th style={{ ...th, textAlign: "right" }}>概算（税込）</th>
              <th style={th}>請求書</th>
              <th style={th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {summaries.map((s) => {
              const iv = invoiceByClient.get(s.clientId);
              return (
                <tr key={s.clientId}>
                  <td style={td}>{s.name}</td>
                  <td style={tdNum}>{yen(s.total)}</td>
                  <td style={td}>
                    {iv ? (
                      <>
                        <span style={{ fontWeight: 600 }}>{iv.invoiceNo}</span>{" "}
                        <span style={{ color: "#999", fontSize: 12 }}>
                          ({iv.status})
                        </span>
                        <div style={{ marginTop: 4, fontSize: 13 }}>
                          <a href={`/api/invoices/${iv.id}/export?format=csv`}>
                            CSV
                          </a>
                          <span style={{ margin: "0 8px", color: "#ccc" }}>/</span>
                          <a href={`/api/invoices/${iv.id}/export?format=xlsx`}>
                            xlsx
                          </a>
                        </div>
                      </>
                    ) : (
                      <span style={{ color: "#999" }}>未生成</span>
                    )}
                  </td>
                  <td style={td}>
                    <form action={generateInvoiceAction}>
                      <input type="hidden" name="clientId" value={s.clientId} />
                      <input type="hidden" name="ym" value={ym} />
                      <button type="submit">{iv ? "再生成" : "生成"}</button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p style={{ color: "#888", fontSize: 12, marginTop: 16 }}>
        ※ 概算・明細は RateCard（取引先×現場×種別）から算出。請負（UKEOI）金額は
        マスタに持たないため本フェーズでは 0 とし、必要に応じ管理者が後入力します。
      </p>
    </main>
  );
}

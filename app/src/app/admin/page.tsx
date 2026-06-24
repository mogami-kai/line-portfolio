// ============================================================
// /admin — 管理ダッシュボード（Server Component）
//
//   ガード: getAdminContext()（ADMIN 設定済みか）。未設定/未承認なら案内表示。
//   表示:
//     - 当月の取引先別集計（人工合計 / 残業合計 / 概算金額）
//        ・自社（SELF）と パートナー（PARTNER）を分けて表示
//     - NEEDS_REVIEW（要確認）レポート一覧
//   集計は @/lib/aggregate（内部で @/lib/calc・@/lib/invoice を再利用）。
// ============================================================

import type { CSSProperties } from "react";
import { prisma } from "@/lib/db.js";
import { getAdminContext } from "@/lib/auth.js";
import {
  currentYearMonth,
  loadMonthRows,
  summarizeByClient,
  type ClientMonthSummary,
} from "@/lib/aggregate.js";

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

function SummaryTable({
  title,
  rows,
}: {
  title: string;
  rows: ClientMonthSummary[];
}) {
  const totalMd = rows.reduce((a, r) => a + r.manDays, 0);
  const totalOt = rows.reduce((a, r) => a + r.otHours, 0);
  const totalAmt = rows.reduce((a, r) => a + r.estimatedAmount, 0);
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>{title}</h2>
      {rows.length === 0 ? (
        <p style={{ color: "#888", fontSize: 14 }}>データなし</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={th}>取引先</th>
              <th style={{ ...th, textAlign: "right" }}>人工合計</th>
              <th style={{ ...th, textAlign: "right" }}>残業合計(h)</th>
              <th style={{ ...th, textAlign: "right" }}>概算金額(税抜)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.clientName}>
                <td style={td}>{r.clientName}</td>
                <td style={tdNum}>{r.manDays}</td>
                <td style={tdNum}>{r.otHours}</td>
                <td style={tdNum}>{yen(r.estimatedAmount)}</td>
              </tr>
            ))}
            <tr>
              <td style={{ ...td, fontWeight: 700 }}>合計</td>
              <td style={{ ...tdNum, fontWeight: 700 }}>{totalMd}</td>
              <td style={{ ...tdNum, fontWeight: 700 }}>{totalOt}</td>
              <td style={{ ...tdNum, fontWeight: 700 }}>{yen(totalAmt)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}

export default async function AdminPage() {
  const admin = await getAdminContext();
  if (!admin) {
    return (
      <main style={wrap}>
        <h1 style={{ fontSize: 20 }}>管理ダッシュボード</h1>
        <p style={{ color: "#b00020" }}>
          管理者が未設定、または未承認です。環境変数{" "}
          <code>ADMIN_LINE_USER_IDS</code>{" "}
          に管理者の LINE userId を設定し、その管理者が一度 LIFF
          を開いてユーザー登録（自動で role=ADMIN・承認済み）されると表示されます。
        </p>
      </main>
    );
  }

  const ym = currentYearMonth();

  // 自社 / パートナー を分けて集計。
  const [selfRows, partnerRows, needsReview] = await Promise.all([
    loadMonthRows(ym, { source: "SELF" }),
    loadMonthRows(ym, { source: "PARTNER" }),
    prisma.report.findMany({
      where: { status: "NEEDS_REVIEW" },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        client: { select: { name: true } },
        site: { select: { name: true } },
        org: { select: { name: true, kind: true } },
        entries: { select: { manDays: true, otHours: true } },
      },
    }),
  ]);

  const [selfSummary, partnerSummary] = await Promise.all([
    summarizeByClient(ym, selfRows),
    summarizeByClient(ym, partnerRows),
  ]);

  return (
    <main style={wrap}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <h1 style={{ fontSize: 20, margin: 0 }}>管理ダッシュボード</h1>
        <nav style={{ fontSize: 14 }}>
          <a href="/admin/invoices">請求書 →</a>
        </nav>
      </div>
      <p style={{ color: "#666", fontSize: 13 }}>
        対象月: {ym}（ようこそ {admin.user.displayName} さん）
      </p>

      <SummaryTable title={`自社（SELF）— ${ym}`} rows={selfSummary} />
      <SummaryTable title={`パートナー（PARTNER）— ${ym}`} rows={partnerSummary} />

      {/* 要確認キュー */}
      <section>
        <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>
          要確認（NEEDS_REVIEW）{needsReview.length > 0 && `（${needsReview.length}件）`}
        </h2>
        {needsReview.length === 0 ? (
          <p style={{ color: "#888", fontSize: 14 }}>要確認のレポートはありません。</p>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={th}>日付</th>
                <th style={th}>取引先</th>
                <th style={th}>現場</th>
                <th style={th}>組織</th>
                <th style={{ ...th, textAlign: "right" }}>人工</th>
                <th style={{ ...th, textAlign: "right" }}>残業(h)</th>
              </tr>
            </thead>
            <tbody>
              {needsReview.map((r) => {
                const md = r.entries.reduce((a, e) => a + Number(e.manDays || 0), 0);
                const ot = r.entries.reduce((a, e) => a + Number(e.otHours || 0), 0);
                const d = r.workDate;
                const ds = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
                return (
                  <tr key={r.id}>
                    <td style={td}>{ds}</td>
                    <td style={td}>{r.client.name}</td>
                    <td style={td}>{r.site?.name ?? "(現場未設定)"}</td>
                    <td style={td}>
                      {r.org.name}
                      <span style={{ color: "#999", fontSize: 12 }}> ({r.org.kind})</span>
                    </td>
                    <td style={tdNum}>{md}</td>
                    <td style={tdNum}>{ot}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

// ============================================================
// summarizeMonthProfit の DB クエリ条件を検証する（prisma をモック）。
//   自社のみの閲覧範囲（許可された自社管理者）では協力会社のデータを一切読まないこと、
//   全社（ADMIN）では協力会社も集計に入ることを固める。
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const reportFindMany = vi.fn();
const expenseFindMany = vi.fn();
vi.mock("./db.js", () => ({
  prisma: {
    report: { findMany: (...a: unknown[]) => reportFindMany(...a) },
    expense: { findMany: (...a: unknown[]) => expenseFindMany(...a) },
    lumpContract: { findMany: async () => [] },
    otherExpense: {
      findMany: async () => [{ id: "o1", name: "車両リース", amount: 10000 }],
    },
    invoiceSetting: { findFirst: async () => null },
    client: { findMany: async () => [] },
    rateCard: { findMany: async () => [] },
  },
}));

const { summarizeMonthProfit } = await import("./profit.js");

beforeEach(() => {
  reportFindMany.mockReset();
  expenseFindMany.mockReset();
  reportFindMany.mockResolvedValue([]);
  expenseFindMany.mockResolvedValue([]);
});

/** report.findMany に渡った where.source を全部集める（"SELF" / {in:[...]}）。 */
function sourcesQueried(): unknown[] {
  return reportFindMany.mock.calls.map((c) => c[0].where.source);
}

describe("summarizeMonthProfit — 閲覧範囲", () => {
  it("自社のみ: 協力会社の出面・経費・職人を読まない", async () => {
    const { profit, partnerWorkers } = await summarizeMonthProfit("2026-09", "SELF");
    for (const s of sourcesQueried()) {
      expect(JSON.stringify(s)).not.toContain("PARTNER");
    }
    const expWhere = expenseFindMany.mock.calls[0][0].where;
    expect(JSON.stringify(expWhere)).not.toContain("PARTNER");
    expect(profit.partner).toBeNull();
    expect(partnerWorkers).toEqual([]);
  });

  it("全社: 協力会社も売上・職人の集計に入る", async () => {
    const { profit } = await summarizeMonthProfit("2026-09", "ALL");
    const all = JSON.stringify(sourcesQueried());
    expect(all).toContain("PARTNER");
    expect(profit.partner).not.toBeNull();
  });

  it("未確定・無効組織の出面は対象外（請求書・集計と同じ条件）", async () => {
    await summarizeMonthProfit("2026-09", "ALL");
    // 粗利の売上クエリ（source: { in: [...] }）の条件。
    const salesCall = reportFindMany.mock.calls.find(
      (c) => typeof c[0].where.source === "object",
    );
    expect(salesCall?.[0].where.status).toBe("CONFIRMED");
    expect(salesCall?.[0].where.org).toEqual({ active: true });
  });

  it("設定が無ければ 大和・20% で分け、その他経費を引く", async () => {
    const { profit } = await summarizeMonthProfit("2026-09", "SELF");
    expect(profit.shareName).toBe("大和");
    expect(profit.shareRate).toBe(0.2);
    expect(profit.otherTotal).toBe(10000);
    expect(profit.remaining).toBe(-10000);
  });
});

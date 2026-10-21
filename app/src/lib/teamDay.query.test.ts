// ============================================================
// みんなの出面（loadTeamDay）のテスト（prisma をモック）。
//   ★ 見える範囲は自分の所属組織のみ（出面・職人・入力者の名前すべて orgId で絞る）。
//     自社の人に協力会社の出面を、協力会社の人に自社の出面を出さない不変条件を固める。
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const reportFindMany = vi.fn();
const workerFindMany = vi.fn();
const userFindMany = vi.fn();

vi.mock("./db.js", () => ({
  prisma: {
    report: { findMany: (...a: unknown[]) => reportFindMany(...a) },
    worker: { findMany: (...a: unknown[]) => workerFindMany(...a) },
    user: { findMany: (...a: unknown[]) => userFindMany(...a) },
    invoiceSetting: { findFirst: async () => null }, // 後日入力は既定 2日
  },
}));

const { loadTeamDay } = await import("./teamDay.js");

const report = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  workDate: new Date("2026-10-20T00:00:00.000Z"),
  createdAt: new Date("2026-10-20T09:05:00.000Z"), // JST 10/20 18:05
  createdById: "u-tanaka",
  status: "CONFIRMED",
  siteName: "みなとみらい",
  deleteRequestedAt: null,
  client: { name: "辻濱興業" },
  site: null,
  entries: [
    { shift: "DAY", otHours: 0, worker: { id: "w-yamada", name: "山田" } },
    { shift: "NIGHT", otHours: 2, worker: { id: "w-sato", name: "佐藤" } },
  ],
  ...over,
});

beforeEach(() => {
  reportFindMany.mockReset();
  workerFindMany.mockReset();
  userFindMany.mockReset();
  reportFindMany.mockResolvedValue([report()]);
  workerFindMany.mockResolvedValue([
    { id: "w-sato", name: "佐藤" },
    { id: "w-suzuki", name: "鈴木" },
    { id: "w-yamada", name: "山田" },
  ]);
  userFindMany.mockResolvedValue([{ id: "u-tanaka", displayName: "田中" }]);
});

describe("loadTeamDay — 見える範囲", () => {
  it("出面・職人・入力者の名前をすべて自分の所属組織で絞る", async () => {
    await loadTeamDay("org-self", "2026-10-20");
    expect(reportFindMany.mock.calls[0][0].where).toEqual({
      orgId: "org-self",
      workDate: new Date("2026-10-20T00:00:00.000Z"),
    });
    expect(workerFindMany.mock.calls[0][0].where).toEqual({
      orgId: "org-self",
      active: true,
    });
    expect(userFindMany.mock.calls[0][0].where).toEqual({
      id: { in: ["u-tanaka"] },
      orgId: "org-self",
    });
  });

  it("別の組織の人が入力した出面（全社管理者の代理登録など）は「管理者」と出す", async () => {
    reportFindMany.mockResolvedValue([report({ createdById: "u-other-org" })]);
    userFindMany.mockResolvedValue([]);
    const day = await loadTeamDay("org-p", "2026-10-20");
    expect(day.reports[0].inputBy).toBe("管理者");
  });

  it("金額・経費は返さない", async () => {
    const day = await loadTeamDay("org-self", "2026-10-20");
    const sel = reportFindMany.mock.calls[0][0].select;
    expect(sel.expenses).toBeUndefined();
    expect(sel.contractAmount).toBeUndefined();
    expect(JSON.stringify(day)).not.toMatch(/amount/);
  });
});

describe("loadTeamDay — 中身", () => {
  it("職人の表記・入力者・入力時刻（JST）", async () => {
    const day = await loadTeamDay("org-self", "2026-10-20");
    expect(day.reports[0]).toMatchObject({
      clientName: "辻濱興業",
      siteName: "みなとみらい",
      workers: "山田　佐藤（夜勤・残2h）",
      count: 2,
      inputBy: "田中",
      enteredAt: "10/20 18:05",
      lateDays: null,
      review: false,
      deleteRequested: false,
    });
    expect(day.workerCount).toBe(2);
  });

  it("その日の出面に名前がない職人を名前順で返す", async () => {
    const day = await loadTeamDay("org-self", "2026-10-20");
    expect(day.missing).toEqual(["鈴木"]);
  });

  it("後日入力は遅れ日数を返す（既定 2日以上あと）", async () => {
    reportFindMany.mockResolvedValue([
      report({
        createdAt: new Date("2026-10-24T01:00:00.000Z"), // JST 10/24 → 4日後
        status: "NEEDS_REVIEW",
      }),
    ]);
    const day = await loadTeamDay("org-self", "2026-10-20");
    expect(day.reports[0].lateDays).toBe(4);
    expect(day.reports[0].review).toBe(true);
  });

  it("出面が無い日は全員が「名前がない」", async () => {
    reportFindMany.mockResolvedValue([]);
    const day = await loadTeamDay("org-self", "2026-10-20");
    expect(day.reports).toEqual([]);
    expect(day.missing).toEqual(["佐藤", "鈴木", "山田"]);
    expect(userFindMany).not.toHaveBeenCalled();
  });
});

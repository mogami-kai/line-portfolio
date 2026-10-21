// ============================================================
// 出面作成の核（createReportCore）の後日入力判定のテスト（prisma・通知をモック）。
//   ・LIFF の本人入力（checkLate）で、設定日数以上あとの入力は要確認（承認するまで集計に入らない）
//   ・請求書を作成済みの月への入力も要確認
//   ・管理画面からの登録（checkLate なし）は判定しない
//   ・後日入力の通知本文には遅れ日数を渡す
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const reportCreate = vi.fn();
const invoiceFindUnique = vi.fn();
const settingFindFirst = vi.fn();
const notifyText = vi.fn();

vi.mock("next/cache", () => ({ revalidateTag: () => {} }));

vi.mock("./db.js", () => ({
  prisma: {
    client: { findFirst: async () => ({ id: "c1", name: "辻濱興業" }) },
    site: { findFirst: async () => null, update: async () => ({}) },
    worker: { findMany: async () => [{ id: "w1", name: "山田" }] },
    receiptImage: { findMany: async () => [] },
    report: {
      findUnique: async () => null,
      create: (...a: unknown[]) => reportCreate(...a),
      update: async () => ({}),
    },
    invoice: { findUnique: (...a: unknown[]) => invoiceFindUnique(...a) },
    invoiceSetting: { findFirst: (...a: unknown[]) => settingFindFirst(...a) },
    organization: { findUnique: async () => null },
    auditLog: { create: async () => ({}) },
  },
}));

vi.mock("./notify.js", () => ({
  notifyReportToAdmins: async () => ({ recipients: 1 }),
  reportNotifyText: (...a: unknown[]) => notifyText(...a),
}));

const { createReportCore } = await import("./reportCreate.js");

const NOW = new Date("2026-10-21T03:00:00.000Z"); // JST 10/21 12:00

const input = (workDate: string) => ({
  workDate,
  clientId: "c1",
  siteName: "みなとみらい",
  contractType: "JOYO" as const,
  entries: [{ workerId: "w1", shift: "DAY" as const, manDays: 1, otHours: 0 }],
});

const ctx = (over: Record<string, unknown> = {}) => ({
  orgId: "org-self",
  orgKind: "SELF" as const,
  createdById: "u1",
  createdByName: "田中",
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  reportCreate.mockReset();
  invoiceFindUnique.mockReset();
  settingFindFirst.mockReset();
  notifyText.mockReset();
  invoiceFindUnique.mockResolvedValue(null);
  settingFindFirst.mockResolvedValue(null); // 設定未作成 → 既定 2日
  notifyText.mockReturnValue("text");
  reportCreate.mockImplementation(async (args: { data: { status: string; workDate: Date } }) => ({
    id: "r1",
    status: args.data.status,
    workDate: args.data.workDate,
    siteName: "みなとみらい",
    client: { name: "辻濱興業" },
    entries: [],
    expenses: [],
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

const savedStatus = () => reportCreate.mock.calls[0][0].data.status;

describe("createReportCore — 後日入力（LIFF の本人入力）", () => {
  it("当日・翌日の入力はそのまま確定", async () => {
    const r1 = await createReportCore(input("2026-10-21"), ctx({ checkLate: true }));
    expect(r1).toMatchObject({ ok: true, status: "CONFIRMED" });
    reportCreate.mockClear();
    const r2 = await createReportCore(input("2026-10-20"), ctx({ checkLate: true }));
    expect(r2).toMatchObject({ ok: true, status: "CONFIRMED" });
    expect(notifyText.mock.calls[0][1].lateDays).toBeNull();
  });

  it("2日以上あとの入力は要確認にして、本人に理由を返す", async () => {
    const r = await createReportCore(input("2026-10-16"), ctx({ checkLate: true }));
    expect(savedStatus()).toBe("NEEDS_REVIEW");
    expect(r).toMatchObject({ ok: true, status: "NEEDS_REVIEW" });
    if (!r.ok) throw new Error("unreachable");
    expect(r.askback).toContain("後日入力（出面の日付から5日後の入力）");
    expect(r.askback).toContain("集計・請求には入りません");
  });

  it("後日入力の通知には遅れ日数を渡す", async () => {
    await createReportCore(input("2026-10-16"), ctx({ checkLate: true }));
    expect(notifyText.mock.calls[0][1]).toMatchObject({ kind: "created", lateDays: 5 });
  });

  it("設定で「使わない」（null）なら何日前でも確定", async () => {
    settingFindFirst.mockResolvedValue({ lateEntryDays: null });
    const r = await createReportCore(input("2026-09-30"), ctx({ checkLate: true }));
    expect(r).toMatchObject({ ok: true, status: "CONFIRMED" });
  });

  it("設定の日数に従う（1 = 翌日の入力から承認制）", async () => {
    settingFindFirst.mockResolvedValue({ lateEntryDays: 1 });
    const r = await createReportCore(input("2026-10-20"), ctx({ checkLate: true }));
    expect(r).toMatchObject({ ok: true, status: "NEEDS_REVIEW" });
  });

  it("請求書を作成済みの月への入力は、遅れていなくても要確認", async () => {
    invoiceFindUnique.mockResolvedValue({ id: "inv1" });
    const r = await createReportCore(input("2026-10-21"), ctx({ checkLate: true }));
    expect(invoiceFindUnique.mock.calls[0][0].where).toEqual({
      clientId_yearMonth: { clientId: "c1", yearMonth: "2026-10" },
    });
    expect(r).toMatchObject({ ok: true, status: "NEEDS_REVIEW" });
    if (!r.ok) throw new Error("unreachable");
    expect(r.askback).toContain("10月の辻濱興業の請求書は作成済み");
  });
});

describe("createReportCore — 管理画面からの登録", () => {
  it("checkLate なしなら後日入力も請求書作成済みも判定しない", async () => {
    invoiceFindUnique.mockResolvedValue({ id: "inv1" });
    const r = await createReportCore(input("2026-10-01"), ctx());
    expect(r).toMatchObject({ ok: true, status: "CONFIRMED" });
    expect(invoiceFindUnique).not.toHaveBeenCalled();
    expect(settingFindFirst).not.toHaveBeenCalled();
  });
});

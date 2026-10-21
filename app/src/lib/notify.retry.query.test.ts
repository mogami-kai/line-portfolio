// ============================================================
// 未通知の出面の再通知（resendReportNotification / retryUnnotifiedReports）のテスト。
//   prisma と LINE 送信をモックして、
//   ・先に notified を確保してから送る（手動と自動が重なっても二重に送らない）
//   ・失敗したら notified を戻す
//   ・月間上限(429)に当たったら打ち切る
//   ・後日入力（承認待ち）は本文に注意書きが付く
//   を固める。
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const reportFindMany = vi.fn();
const reportUpdateMany = vi.fn();
const auditCreate = vi.fn();
const multicast = vi.fn();

vi.mock("./db.js", () => ({
  prisma: {
    report: {
      findMany: (...a: unknown[]) => reportFindMany(...a),
      updateMany: (...a: unknown[]) => reportUpdateMany(...a),
    },
    invoiceSetting: { findFirst: async () => null }, // 既定（通知先ロール・後日入力 2日）
    user: {
      findMany: async () => [
        {
          id: "admin",
          lineUserId: "U-admin",
          role: "ADMIN",
          orgId: "org-self",
          approved: true,
          status: "ACTIVE",
          notifyReports: true,
          lineFriend: true,
          org: { kind: "SELF" },
        },
      ],
    },
    auditLog: { create: (...a: unknown[]) => auditCreate(...a) },
  },
}));

vi.mock("./line.js", async (orig) => ({
  ...(await orig<typeof import("./line.js")>()),
  multicastToUsers: (...a: unknown[]) => multicast(...a),
}));

const { resendReportNotification, retryUnnotifiedReports } = await import("./notify.js");

const NOW = new Date("2026-10-21T03:00:00.000Z"); // JST 10/21 12:00

const rep = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  orgId: "org-self",
  createdById: "worker-user",
  createdAt: new Date("2026-10-21T02:00:00.000Z"),
  status: "CONFIRMED" as const,
  workDate: new Date("2026-10-21T00:00:00.000Z"),
  contractType: "JOYO" as const,
  contractAmount: null,
  siteName: "みなとみらい",
  client: { name: "辻濱興業" },
  org: { kind: "SELF" as const, name: "自社" },
  entries: [{ shift: "DAY" as const, manDays: 1, otHours: 0, worker: { name: "山田" } }],
  expenses: [],
  ...over,
});

beforeEach(() => {
  reportFindMany.mockReset();
  reportUpdateMany.mockReset();
  auditCreate.mockReset();
  multicast.mockReset();
  reportUpdateMany.mockResolvedValue({ count: 1 });
  multicast.mockResolvedValue(undefined);
  auditCreate.mockResolvedValue({});
});

describe("resendReportNotification — 1件の再通知", () => {
  it("notified を false→true で確保してから送る", async () => {
    const r = await resendReportNotification(rep(), 2);
    expect(r).toEqual({ status: "sent", recipients: 1 });
    expect(reportUpdateMany.mock.calls[0][0]).toEqual({
      where: { id: "r1", notified: false },
      data: { notified: true },
    });
    expect(multicast).toHaveBeenCalledTimes(1);
  });

  it("既に確保済み（通知済み・自動再通知が送信中）なら送らない", async () => {
    reportUpdateMany.mockResolvedValueOnce({ count: 0 });
    const r = await resendReportNotification(rep(), 2);
    expect(r).toEqual({ status: "already" });
    expect(multicast).not.toHaveBeenCalled();
  });

  it("送信に失敗したら notified を false に戻す", async () => {
    multicast.mockRejectedValueOnce(new Error("LINE multicast failed: 500"));
    const r = await resendReportNotification(rep(), 2);
    expect(r.status).toBe("failed");
    expect(reportUpdateMany.mock.calls[1][0]).toEqual({
      where: { id: "r1" },
      data: { notified: false },
    });
  });

  it("後日入力の承認待ちは本文の先頭に注意書きが付く", async () => {
    await resendReportNotification(
      rep({ status: "NEEDS_REVIEW", workDate: new Date("2026-10-16T00:00:00.000Z") }),
      2,
    );
    const text = multicast.mock.calls[0][1] as string;
    expect(text.split("\n")[0]).toBe(
      "⚠後日入力（5日後に入力・承認するまで集計に入りません）",
    );
  });

  it("承認済み（CONFIRMED）の後日入力には注意書きを付けない", async () => {
    await resendReportNotification(
      rep({ workDate: new Date("2026-10-16T00:00:00.000Z") }),
      2,
    );
    expect(multicast.mock.calls[0][1]).not.toContain("後日入力");
  });
});

describe("retryUnnotifiedReports — cron の自動再通知", () => {
  it("作成から5分〜3日の未通知だけを対象にする", async () => {
    reportFindMany.mockResolvedValue([]);
    await retryUnnotifiedReports(NOW);
    const where = reportFindMany.mock.calls[0][0].where;
    expect(where.notified).toBe(false);
    expect(where.createdAt.lte).toEqual(new Date(NOW.getTime() - 5 * 60 * 1000));
    expect(where.createdAt.gte).toEqual(
      new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000),
    );
  });

  it("送れたものは履歴に「自動再通知」として残す", async () => {
    reportFindMany.mockResolvedValue([rep(), rep({ id: "r2" })]);
    const r = await retryUnnotifiedReports(NOW);
    expect(r).toEqual({ tried: 2, sent: 2, failed: 0, quotaExceeded: false });
    expect(auditCreate).toHaveBeenCalledTimes(2);
    expect(auditCreate.mock.calls[0][0].data.actorName).toBe("自動再通知");
  });

  it("月間上限(429)に当たったら残りは送らずに打ち切る", async () => {
    reportFindMany.mockResolvedValue([rep(), rep({ id: "r2" }), rep({ id: "r3" })]);
    multicast.mockRejectedValueOnce(
      new Error('LINE multicast failed: 429 n=1 body={"message":"You have reached your monthly limit."}'),
    );
    const r = await retryUnnotifiedReports(NOW);
    expect(r).toEqual({ tried: 1, sent: 0, failed: 1, quotaExceeded: true });
    expect(multicast).toHaveBeenCalledTimes(1);
  });

  it("上限以外の失敗は次の出面へ進む", async () => {
    reportFindMany.mockResolvedValue([rep(), rep({ id: "r2" })]);
    multicast.mockRejectedValueOnce(new Error("LINE multicast failed: 500"));
    const r = await retryUnnotifiedReports(NOW);
    expect(r).toEqual({ tried: 2, sent: 1, failed: 1, quotaExceeded: false });
  });
});

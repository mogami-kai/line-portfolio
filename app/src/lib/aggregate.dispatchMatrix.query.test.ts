// ============================================================
// summarizeDispatchMatrix の DB クエリ形（where 句・呼び出し回数）を検証する。
//   このリポジトリには Prisma 統合テスト環境（実DB）が無いため、prisma を
//   モックして「summarizeByWorker と同じ条件で絞り込んでいるか」「1クエリで
//   完結しているか（N+1なし）」「取得結果が正しく DispatchMatrixWorker[] に
//   変換されるか」を検証する。buildDispatchMatrix 自体の純粋ロジックは
//   aggregate.test.ts でカバーする。
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const findManyMock = vi.fn();
vi.mock("./db.js", () => ({
  prisma: {
    report: {
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
  },
}));

const { summarizeDispatchMatrix } = await import("./aggregate.js");

beforeEach(() => {
  findManyMock.mockReset();
});

describe("summarizeDispatchMatrix — クエリ条件", () => {
  it("未確定データを除外する条件（status=CONFIRMED）を必ず含む", async () => {
    findManyMock.mockResolvedValue([]);
    await summarizeDispatchMatrix("2026-07");
    const arg = findManyMock.mock.calls[0][0];
    expect(arg.where.status).toBe("CONFIRMED");
  });

  it("無効組織を除外する条件（org.active=true）を必ず含む", async () => {
    findManyMock.mockResolvedValue([]);
    await summarizeDispatchMatrix("2026-07");
    const arg = findManyMock.mock.calls[0][0];
    expect(arg.where.org).toEqual({ active: true });
  });

  it("全社管理者（source指定）は source をそのまま where に渡す", async () => {
    findManyMock.mockResolvedValue([]);
    await summarizeDispatchMatrix("2026-07", { source: "SELF" });
    const arg = findManyMock.mock.calls[0][0];
    expect(arg.where.source).toBe("SELF");
    expect(arg.where.orgId).toBeUndefined();
  });

  it("組織スコープ（orgId指定）は orgId をそのまま where に渡す", async () => {
    findManyMock.mockResolvedValue([]);
    await summarizeDispatchMatrix("2026-07", { orgId: "org-123" });
    const arg = findManyMock.mock.calls[0][0];
    expect(arg.where.orgId).toBe("org-123");
    expect(arg.where.source).toBeUndefined();
  });

  it("職人×日ごとにクエリを発行しない（呼び出しは1回だけ＝N+1なし）", async () => {
    findManyMock.mockResolvedValue([
      {
        workDate: new Date("2026-07-01T00:00:00.000Z"),
        entries: [
          {
            shift: "DAY",
            manDays: 1,
            otHours: 0,
            worker: { id: "w1", name: "山田" },
          },
        ],
      },
      {
        workDate: new Date("2026-07-02T00:00:00.000Z"),
        entries: [
          {
            shift: "NIGHT",
            manDays: 1,
            otHours: 1,
            worker: { id: "w1", name: "山田" },
          },
        ],
      },
    ]);
    const result = await summarizeDispatchMatrix("2026-07");
    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0].workerName).toBe("山田");
    expect(result[0].totals.manDays).toBe(2);
    expect(result[0].totals.dayManDays).toBe(1);
    expect(result[0].totals.nightManDays).toBe(1);
    expect(result[0].totals.otHours).toBe(1);
    expect(result[0].days[0].shifts[0].shift).toBe("DAY"); // 7/1
    expect(result[0].days[1].shifts[0].shift).toBe("NIGHT"); // 7/2
  });

  it("データなし（0件）でも空配列を返す（画面側で空状態メッセージに切替）", async () => {
    findManyMock.mockResolvedValue([]);
    const result = await summarizeDispatchMatrix("2026-07");
    expect(result).toEqual([]);
  });
});

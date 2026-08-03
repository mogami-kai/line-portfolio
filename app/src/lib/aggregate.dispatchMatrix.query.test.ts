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

const { summarizeDispatchMatrix, summarizeByWorker } = await import(
  "./aggregate.js"
);

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
        id: "rep-1",
        workDate: new Date("2026-07-01T00:00:00.000Z"),
        siteName: "みなとみらい",
        site: null,
        client: { name: "辻濱興業" },
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
        id: "rep-2",
        workDate: new Date("2026-07-02T00:00:00.000Z"),
        siteName: null,
        site: { name: "旧現場マスタ名" },
        client: { name: "辻濱興業" },
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

  it("セル編集用に reportId と現場名を載せる（自由入力優先→現場マスタ名）", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "rep-1",
        workDate: new Date("2026-07-01T00:00:00.000Z"),
        siteName: "みなとみらい",
        site: { name: "使われない旧名" },
        client: { name: "辻濱興業" },
        entries: [
          { shift: "DAY", manDays: 1, otHours: 2, worker: { id: "w1", name: "山田" } },
        ],
      },
      {
        id: "rep-2",
        workDate: new Date("2026-07-02T00:00:00.000Z"),
        siteName: null, // 自由入力なし → 現場マスタ名にフォールバック
        site: { name: "旧現場マスタ名" },
        client: { name: "恵興業" },
        entries: [
          { shift: "DAY", manDays: 1, otHours: 0, worker: { id: "w1", name: "山田" } },
        ],
      },
    ]);
    const [w] = await summarizeDispatchMatrix("2026-07");
    expect(w.days[0].refs[0]).toMatchObject({
      reportId: "rep-1",
      clientName: "辻濱興業",
      siteName: "みなとみらい", // 自由入力が優先される
      otHours: 2,
    });
    expect(w.days[1].refs[0]).toMatchObject({
      reportId: "rep-2",
      siteName: "旧現場マスタ名", // siteName が無いときのフォールバック
    });
  });

  it("データなし（0件）でも空配列を返す（画面側で空状態メッセージに切替）", async () => {
    findManyMock.mockResolvedValue([]);
    const result = await summarizeDispatchMatrix("2026-07");
    expect(result).toEqual([]);
  });
});

// ============================================================
// マトリクス右端の合計 ＝ 既存の職人別集計（summarizeByWorker）と一致するか。
//   この一致は「同じ where 句・同じ grouping キー・同じ resolveManDays を使う」
//   という規約に依存している。将来 summarizeByWorker のフィルタや集計が
//   変更されたときに、この回帰テストで乖離を検知する。
// ============================================================
describe("PARITY: summarizeByWorker と summarizeDispatchMatrix の合計一致", () => {
  // 0.75人工・HALF・NIGHT・残業・同日複数出面を含む代表データ。
  const REPORTS = [
    {
      id: "rep-1",
      workDate: new Date("2026-07-01T00:00:00.000Z"),
      siteName: "A現場",
      site: null,
      client: { name: "辻濱興業" },
      entries: [
        { shift: "DAY", manDays: 1, otHours: 1, worker: { id: "w1", name: "山田", unitPrice: null, otUnitPrice: null } },
        { shift: "HALF", manDays: 0.5, otHours: 0, worker: { id: "w2", name: "佐藤", unitPrice: null, otUnitPrice: null } },
      ],
    },
    {
      id: "rep-2",
      workDate: new Date("2026-07-01T00:00:00.000Z"),
      siteName: "B現場",
      site: null,
      client: { name: "恵興業" },
      entries: [
        { shift: "NIGHT", manDays: 1, otHours: 0.5, worker: { id: "w1", name: "山田", unitPrice: null, otUnitPrice: null } },
      ],
    },
    {
      id: "rep-3",
      workDate: new Date("2026-07-15T00:00:00.000Z"),
      siteName: "A現場",
      site: null,
      client: { name: "辻濱興業" },
      entries: [
        { shift: "DAY", manDays: 0.75, otHours: 0, worker: { id: "w1", name: "山田", unitPrice: null, otUnitPrice: null } },
        { shift: "DAY", manDays: 1, otHours: 2, worker: { id: "w2", name: "佐藤", unitPrice: null, otUnitPrice: null } },
        { shift: "DAY", manDays: 1, otHours: 0, worker: { id: "w2", name: "佐藤", unitPrice: null, otUnitPrice: null } },
      ],
    },
  ];

  beforeEach(() => {
    findManyMock.mockResolvedValue(REPORTS);
  });

  it("職人ごとの 人工/日勤/夜勤/半日/残業 が完全に一致する", async () => {
    const byWorker = await summarizeByWorker("2026-07", { source: "SELF" });
    const matrix = await summarizeDispatchMatrix("2026-07", { source: "SELF" });
    const norm = (
      rows: {
        workerId: string | null;
        manDays: number;
        dayManDays: number;
        nightManDays: number;
        halfManDays: number;
        otHours: number;
      }[],
    ) =>
      rows
        .map((r) => ({
          id: r.workerId,
          manDays: r.manDays,
          day: r.dayManDays,
          night: r.nightManDays,
          half: r.halfManDays,
          ot: r.otHours,
        }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    expect(norm(matrix.map((m) => ({ workerId: m.workerId, ...m.totals })))).toEqual(
      norm(byWorker),
    );
  });

  it("全職人の人工総合計が一致する", async () => {
    const byWorker = await summarizeByWorker("2026-07", { source: "SELF" });
    const matrix = await summarizeDispatchMatrix("2026-07", { source: "SELF" });
    expect(matrix.reduce((s, r) => s + r.totals.manDays, 0)).toBe(
      byWorker.reduce((s, r) => s + r.manDays, 0),
    );
  });

  it("where 句が完全に一致する（フィルタ条件の乖離を検知）", async () => {
    await summarizeByWorker("2026-07", { source: "SELF" });
    const whereByWorker = findManyMock.mock.calls[0][0].where;
    findManyMock.mockClear();
    await summarizeDispatchMatrix("2026-07", { source: "SELF" });
    const whereMatrix = findManyMock.mock.calls[0][0].where;
    expect(whereMatrix).toEqual(whereByWorker);
  });

  it("組織スコープ指定でも where 句が一致する", async () => {
    await summarizeByWorker("2026-07", { orgId: "org-9" });
    const whereByWorker = findManyMock.mock.calls[0][0].where;
    findManyMock.mockClear();
    await summarizeDispatchMatrix("2026-07", { orgId: "org-9" });
    expect(findManyMock.mock.calls[0][0].where).toEqual(whereByWorker);
  });
});

// ============================================================
// summarizeByWorker の給料計算（夜勤は人工単価×1.25）を検証する。
//   実DBを持たないため prisma をモックし、Report → entries の shift 内訳が
//   給料（pay）に正しく反映されるかを見る。単価計算そのものの純粋ロジックは
//   calc.test.ts（nightUnit / workerPay）でカバーする。
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

const { summarizeByWorker } = await import("./aggregate.js");

/** 単価つきの職人（給料計算の対象）。 */
const worker = (over: { unitPrice?: number | null; otUnitPrice?: number | null } = {}) => ({
  id: "w1",
  name: "山田",
  unitPrice: over.unitPrice === undefined ? 20000 : over.unitPrice,
  otUnitPrice: over.otUnitPrice === undefined ? null : over.otUnitPrice,
});

beforeEach(() => {
  findManyMock.mockReset();
});

describe("summarizeByWorker — 夜勤単価は人工単価の1.25倍", () => {
  it("日勤・半日は等倍、夜勤は1.25倍で給料に積む", async () => {
    findManyMock.mockResolvedValue([
      {
        siteName: "A現場",
        site: null,
        entries: [
          { shift: "DAY", manDays: 1, otHours: 0, worker: worker() },
          { shift: "HALF", manDays: 0.5, otHours: 0, worker: worker() },
          { shift: "NIGHT", manDays: 2, otHours: 0, worker: worker() },
        ],
      },
    ]);
    const [w] = await summarizeByWorker("2026-07", { source: "SELF" });
    expect(w.manDays).toBe(3.5);
    expect(w.dayManDays).toBe(1);
    expect(w.halfManDays).toBe(0.5);
    expect(w.nightManDays).toBe(2);
    // 夜勤単価 = round(20000 × 1.25) = 25000
    expect(w.nightUnitPrice).toBe(25000);
    // (1 + 0.5) × 20000 ＋ 2 × 25000 = 30000 + 50000
    expect(w.pay).toBe(30000 + 50000);
  });

  it("残業は人工単価÷8×1.25（夜勤割増とは別勘定）で上乗せする", async () => {
    findManyMock.mockResolvedValue([
      {
        siteName: "A現場",
        site: null,
        entries: [
          { shift: "NIGHT", manDays: 1, otHours: 2, worker: worker() },
        ],
      },
    ]);
    const [w] = await summarizeByWorker("2026-07", { source: "SELF" });
    // 夜勤 1 × 25000 ＋ 残業 2h × round(20000/8×1.25)=3125
    expect(w.pay).toBe(25000 + 6250);
  });

  it("夜勤ゼロなら従来どおり 人工×単価（既存データの金額は動かない）", async () => {
    findManyMock.mockResolvedValue([
      {
        siteName: "A現場",
        site: null,
        entries: [
          { shift: "DAY", manDays: 1, otHours: 0, worker: worker() },
          { shift: "DAY", manDays: 0.75, otHours: 0, worker: worker() },
        ],
      },
    ]);
    const [w] = await summarizeByWorker("2026-07", { source: "SELF" });
    expect(w.pay).toBe(Math.round(1.75 * 20000));
  });

  it("人工単価が未設定なら給料は0（画面は「単価未設定」）・夜勤単価も0", async () => {
    findManyMock.mockResolvedValue([
      {
        siteName: "A現場",
        site: null,
        entries: [
          { shift: "NIGHT", manDays: 3, otHours: 1, worker: worker({ unitPrice: null }) },
        ],
      },
    ]);
    const [w] = await summarizeByWorker("2026-07", { source: "SELF" });
    expect(w.unitPrice).toBeNull();
    expect(w.nightUnitPrice).toBe(0);
    expect(w.pay).toBe(0);
  });
});

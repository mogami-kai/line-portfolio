// ============================================================
// 月間出勤マトリクス（daysInMonth / buildDispatchMatrix / formatDispatchCell）
//   DB非依存の純粋関数のみをテスト対象にする（loadMonthRows 等 DB を叩く関数は
//   既存の慣習どおりテスト対象外＝リポジトリに Prisma 統合テストが存在しない）。
// ============================================================

import { describe, it, expect } from "vitest";
import {
  daysInMonth,
  buildDispatchMatrix,
  formatDispatchCell,
  type DispatchMatrixRawEntry,
  type DispatchDayCell,
} from "./aggregate.js";

/** UTC午前0時のReport.workDate相当（既存の保存規約に合わせる）。 */
const wd = (yyyyMmDd: string) => new Date(`${yyyyMmDd}T00:00:00.000Z`);

const entry = (
  overrides: Partial<DispatchMatrixRawEntry> & { workDate: Date },
): DispatchMatrixRawEntry => ({
  workerId: "w1",
  workerName: "山田",
  shift: "DAY",
  manDays: 0,
  otHours: 0,
  ...overrides,
});

describe("daysInMonth", () => {
  it("31日の月", () => {
    expect(daysInMonth("2026-07")).toBe(31);
    expect(daysInMonth("2026-01")).toBe(31);
  });
  it("30日の月", () => {
    expect(daysInMonth("2026-06")).toBe(30);
    expect(daysInMonth("2026-04")).toBe(30);
  });
  it("平年2月（28日）", () => {
    expect(daysInMonth("2026-02")).toBe(28);
  });
  it("うるう年2月（29日）", () => {
    // 2028年はうるう年（4で割り切れ、100で割り切れない）。
    expect(daysInMonth("2028-02")).toBe(29);
  });
  it("12月→年またぎでも正しく31日", () => {
    expect(daysInMonth("2026-12")).toBe(31);
  });
});

describe("buildDispatchMatrix — 月の日数どおりの日数配列を作る", () => {
  it("7月は31日ぶんのセルを持つ", () => {
    const [w] = buildDispatchMatrix("2026-07", [
      entry({ workDate: wd("2026-07-01") }),
    ]);
    expect(w.days).toHaveLength(31);
    expect(w.days[0].day).toBe(1);
    expect(w.days[30].day).toBe(31);
  });
  it("うるう年2月は29日ぶん", () => {
    const [w] = buildDispatchMatrix("2028-02", [
      entry({ workDate: wd("2028-02-01") }),
    ]);
    expect(w.days).toHaveLength(29);
  });
});

describe("buildDispatchMatrix — 勤務区分ごとの人工・表示", () => {
  it("日勤のみ: 1件=1人工、セルは「日」", () => {
    const [w] = buildDispatchMatrix("2026-07", [
      entry({ workDate: wd("2026-07-10"), shift: "DAY" }),
    ]);
    expect(w.totals.manDays).toBe(1);
    expect(w.totals.dayManDays).toBe(1);
    expect(w.totals.nightManDays).toBe(0);
    expect(w.totals.halfManDays).toBe(0);
    expect(formatDispatchCell(w.days[9])).toBe("日");
  });

  it("夜勤のみ: 1件=1人工、セルは「夜」", () => {
    const [w] = buildDispatchMatrix("2026-07", [
      entry({ workDate: wd("2026-07-10"), shift: "NIGHT" }),
    ]);
    expect(w.totals.manDays).toBe(1);
    expect(w.totals.nightManDays).toBe(1);
    expect(formatDispatchCell(w.days[9])).toBe("夜");
  });

  it("半日のみ: 0.5人工、セルは「半」（0.5を1へ丸めない）", () => {
    const [w] = buildDispatchMatrix("2026-07", [
      entry({ workDate: wd("2026-07-10"), shift: "HALF" }),
    ]);
    expect(w.totals.manDays).toBe(0.5);
    expect(w.totals.halfManDays).toBe(0.5);
    expect(formatDispatchCell(w.days[9])).toBe("半");
  });

  it("同日の日勤＋夜勤: セルは「日+夜」、人工は日1+夜1=2", () => {
    const [w] = buildDispatchMatrix("2026-07", [
      entry({ workDate: wd("2026-07-10"), shift: "DAY" }),
      entry({ workDate: wd("2026-07-10"), shift: "NIGHT" }),
    ]);
    expect(formatDispatchCell(w.days[9])).toBe("日+夜");
    expect(w.totals.manDays).toBe(2);
    expect(w.totals.dayManDays).toBe(1);
    expect(w.totals.nightManDays).toBe(1);
  });

  it("日勤＋半日: セルは「日+半」", () => {
    const [w] = buildDispatchMatrix("2026-07", [
      entry({ workDate: wd("2026-07-10"), shift: "DAY" }),
      entry({ workDate: wd("2026-07-10"), shift: "HALF" }),
    ]);
    expect(formatDispatchCell(w.days[9])).toBe("日+半");
  });

  it("同日の複数出面（同区分3件）: 「日×3」・人工は件数分積み上げ", () => {
    const [w] = buildDispatchMatrix("2026-07", [
      entry({ workDate: wd("2026-07-10"), shift: "DAY" }),
      entry({ workDate: wd("2026-07-10"), shift: "DAY" }),
      entry({ workDate: wd("2026-07-10"), shift: "DAY" }),
    ]);
    expect(formatDispatchCell(w.days[9])).toBe("日×3");
    expect(w.totals.manDays).toBe(3);
  });

  it("出勤なしの日は「－」", () => {
    const [w] = buildDispatchMatrix("2026-07", [
      entry({ workDate: wd("2026-07-10"), shift: "DAY" }),
    ]);
    expect(formatDispatchCell(w.days[0])).toBe("－"); // 7/1
    expect(w.days[0].shifts).toHaveLength(0);
  });

  it("残業時間は小数のまま合算する（丸めない）", () => {
    const [w] = buildDispatchMatrix("2026-07", [
      entry({ workDate: wd("2026-07-10"), shift: "DAY", otHours: 1.5 }),
      entry({ workDate: wd("2026-07-11"), shift: "DAY", otHours: 0.75 }),
    ]);
    expect(w.totals.otHours).toBe(2.25);
  });

  it("manDays 保存値を優先する（resolveManDaysの規約どおり0.75も尊重）", () => {
    const [w] = buildDispatchMatrix("2026-07", [
      entry({ workDate: wd("2026-07-10"), shift: "DAY", manDays: 0.75 }),
    ]);
    // セル表示は件数ベースで「日」のまま、合計人工だけ0.75を反映する。
    expect(formatDispatchCell(w.days[9])).toBe("日");
    expect(w.totals.manDays).toBe(0.75);
    expect(w.totals.dayManDays).toBe(0.75);
  });
});

describe("buildDispatchMatrix — 職人の分離・並び順", () => {
  it("職人ごとに行を分ける（workerId基準）", () => {
    const workers = buildDispatchMatrix("2026-07", [
      entry({ workerId: "w1", workerName: "山田", workDate: wd("2026-07-01") }),
      entry({ workerId: "w2", workerName: "佐藤", workDate: wd("2026-07-01") }),
    ]);
    expect(workers).toHaveLength(2);
    expect(workers.map((w) => w.workerName).sort()).toEqual(["佐藤", "山田"]);
  });

  it("人工合計の降順（同数は氏名の五十音順）で並ぶ", () => {
    const workers = buildDispatchMatrix("2026-07", [
      entry({ workerId: "w1", workerName: "佐藤", workDate: wd("2026-07-01"), shift: "DAY" }),
      entry({ workerId: "w2", workerName: "山田", workDate: wd("2026-07-01"), shift: "DAY" }),
      entry({ workerId: "w2", workerName: "山田", workDate: wd("2026-07-02"), shift: "DAY" }),
    ]);
    // 山田=2人工、佐藤=1人工 → 山田が先。
    expect(workers[0].workerName).toBe("山田");
    expect(workers[1].workerName).toBe("佐藤");
  });
});

describe("buildDispatchMatrix — データなし", () => {
  it("空配列を渡すと職人0件を返す（呼び出し側で空状態メッセージに切り替える）", () => {
    expect(buildDispatchMatrix("2026-07", [])).toEqual([]);
  });
});

describe("buildDispatchMatrix — 長い職人名", () => {
  it("長い名前もそのまま保持する（表示側で折返し。切り詰めない）", () => {
    const longName = "ながいなまえのしょくにんさんですながいです";
    const [w] = buildDispatchMatrix("2026-07", [
      entry({ workerId: "w9", workerName: longName, workDate: wd("2026-07-01") }),
    ]);
    expect(w.workerName).toBe(longName);
  });
});

describe("formatDispatchCell", () => {
  const cell = (
    shifts: DispatchDayCell["shifts"],
  ): DispatchDayCell => ({
    day: 1,
    shifts,
    totalManDays: 0,
    totalOtHours: 0,
  });

  it("空配列は「－」", () => {
    expect(formatDispatchCell(cell([]))).toBe("－");
  });

  it("複数種類は省略せず + でつなぐ", () => {
    expect(
      formatDispatchCell(
        cell([
          { shift: "DAY", count: 1, manDays: 1, otHours: 0 },
          { shift: "NIGHT", count: 2, manDays: 2, otHours: 0 },
          { shift: "HALF", count: 1, manDays: 0.5, otHours: 0 },
        ]),
      ),
    ).toBe("日+夜×2+半");
  });
});

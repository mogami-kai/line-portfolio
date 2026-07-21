import { describe, it, expect } from "vitest";
import { computeDueDate, jstTodayDate } from "./invoiceDates.js";

const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("computeDueDate（支払期限＝翌月の指定日）", () => {
  it("null → 翌月末日", () => {
    expect(iso(computeDueDate("2026-06", null))).toBe("2026-07-31");
    expect(iso(computeDueDate("2026-02", null))).toBe("2026-03-31");
  });

  it("指定日 → 翌月のその日", () => {
    expect(iso(computeDueDate("2026-06", 20))).toBe("2026-07-20");
    expect(iso(computeDueDate("2026-06", 10))).toBe("2026-07-10");
    expect(iso(computeDueDate("2026-06", 25))).toBe("2026-07-25");
  });

  it("12月 → 翌年1月へ繰り上がる", () => {
    expect(iso(computeDueDate("2026-12", null))).toBe("2027-01-31");
    expect(iso(computeDueDate("2026-12", 15))).toBe("2027-01-15");
  });

  it("翌月に存在しない日は末日へ丸める", () => {
    // 翌月=2月（平年）に31日指定 → 28日。
    expect(iso(computeDueDate("2025-01", 31))).toBe("2025-02-28");
    // 閏年の2月 → 29日。
    expect(iso(computeDueDate("2028-01", 31))).toBe("2028-02-29");
  });
});

describe("jstTodayDate（請求日＝当日・JST）", () => {
  it("UTC 深夜でも JST の暦日（＝+9h の日付）を UTC 0時で返す", () => {
    // 2026-07-20 23:00 UTC = 2026-07-21 08:00 JST → 07-21。
    expect(iso(jstTodayDate(new Date("2026-07-20T23:00:00Z")))).toBe(
      "2026-07-21",
    );
    // 2026-07-21 00:30 UTC = 2026-07-21 09:30 JST → 07-21。
    expect(iso(jstTodayDate(new Date("2026-07-21T00:30:00Z")))).toBe(
      "2026-07-21",
    );
  });

  it("常に UTC 午前0時（時刻成分なし）", () => {
    const d = jstTodayDate(new Date("2026-07-21T05:00:00Z"));
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import {
  shiftManDays,
  joyoAmount,
  overtimeAmount,
  entryAmount,
  OT_FACTOR,
  HOURS_PER_DAY,
} from "./calc.js";

describe("constants", () => {
  it("OT_FACTOR=1.25, HOURS_PER_DAY=8", () => {
    expect(OT_FACTOR).toBe(1.25);
    expect(HOURS_PER_DAY).toBe(8);
  });
});

describe("shiftManDays", () => {
  it("DAY=1, HALF=0.5, NIGHT=1（夜勤は1日扱い）", () => {
    expect(shiftManDays("DAY")).toBe(1);
    expect(shiftManDays("HALF")).toBe(0.5);
    expect(shiftManDays("NIGHT")).toBe(1);
  });
});

describe("joyoAmount", () => {
  it("半日: 0.5 × 20000 = 10000", () => {
    expect(joyoAmount(0.5, 20000)).toBe(10000);
  });
  it("1日: 1 × 20000 = 20000", () => {
    expect(joyoAmount(1, 20000)).toBe(20000);
  });
  it("夜勤(1日扱い): shiftManDays(NIGHT) × 20000 = 20000", () => {
    expect(joyoAmount(shiftManDays("NIGHT"), 20000)).toBe(20000);
  });
});

describe("overtimeAmount", () => {
  it("単価5000・残業1h → round(5000/8*1.25)=781", () => {
    expect(overtimeAmount(1, 5000)).toBe(781);
  });
  it("残業0 → 0", () => {
    expect(overtimeAmount(0, 20000)).toBe(0);
  });
  it("単価20000・残業2h → round(20000/8*1.25*2)=6250", () => {
    expect(overtimeAmount(2, 20000)).toBe(6250);
  });
});

describe("entryAmount", () => {
  it("常用＋残業を合算: 1日 20000 ＋ 残業1h(3125)=23125", () => {
    expect(entryAmount({ manDays: 1, otHours: 1, unitPrice: 20000 })).toBe(
      20000 + 3125,
    );
  });
  it("半日のみ・残業なし: 10000", () => {
    expect(entryAmount({ manDays: 0.5, otHours: 0, unitPrice: 20000 })).toBe(
      10000,
    );
  });
});

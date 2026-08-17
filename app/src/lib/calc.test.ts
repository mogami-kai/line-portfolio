import { describe, it, expect } from "vitest";
import {
  shiftManDays,
  joyoAmount,
  overtimeAmount,
  entryAmount,
  nightUnit,
  workerPay,
  OT_FACTOR,
  NIGHT_FACTOR,
  HOURS_PER_DAY,
} from "./calc.js";

describe("constants", () => {
  it("OT_FACTOR=1.25, NIGHT_FACTOR=1.25, HOURS_PER_DAY=8", () => {
    expect(OT_FACTOR).toBe(1.25);
    expect(NIGHT_FACTOR).toBe(1.25);
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

describe("nightUnit（従業員の夜勤単価＝人工単価×1.25）", () => {
  it("20000 → 25000", () => {
    expect(nightUnit(20000)).toBe(25000);
  });
  it("18500 → 23125（割り切れる）", () => {
    expect(nightUnit(18500)).toBe(23125);
  });
  it("端数は四捨五入: 15002×1.25=18752.5 → 18753", () => {
    expect(nightUnit(15002)).toBe(18753);
  });
  it("未設定（0・負・非数）は 0", () => {
    expect(nightUnit(0)).toBe(0);
    expect(nightUnit(-1)).toBe(0);
    expect(nightUnit(NaN)).toBe(0);
  });
});

describe("workerPay（給料概算・夜勤は1.25倍）", () => {
  it("日勤10・夜勤2・単価20000 → 10×20000 + 2×25000 = 250000", () => {
    expect(
      workerPay({
        dayManDays: 10,
        nightManDays: 2,
        otHours: 0,
        unitPrice: 20000,
      }),
    ).toBe(200000 + 50000);
  });

  it("半日は日勤側（1.0倍）で積む: 0.5人工×20000=10000", () => {
    expect(
      workerPay({
        dayManDays: 0.5,
        nightManDays: 0,
        otHours: 0,
        unitPrice: 20000,
      }),
    ).toBe(10000);
  });

  it("残業は人工単価÷8×1.25（夜勤割増とは独立）", () => {
    // 残業単価 = round(20000/8*1.25) = 3125 → 2h = 6250
    expect(
      workerPay({
        dayManDays: 1,
        nightManDays: 1,
        otHours: 2,
        unitPrice: 20000,
      }),
    ).toBe(20000 + 25000 + 6250);
  });

  it("残業単価を明示したらそちらを優先", () => {
    expect(
      workerPay({
        dayManDays: 0,
        nightManDays: 1,
        otHours: 3,
        unitPrice: 20000,
        otUnitPrice: 2000,
      }),
    ).toBe(25000 + 6000);
  });

  it("人工単価が未設定なら 0（画面では「単価未設定」）", () => {
    expect(
      workerPay({ dayManDays: 5, nightManDays: 3, otHours: 4, unitPrice: 0 }),
    ).toBe(0);
  });

  it("夜勤ゼロなら従来どおり 人工×単価", () => {
    expect(
      workerPay({
        dayManDays: 12,
        nightManDays: 0,
        otHours: 0,
        unitPrice: 18000,
      }),
    ).toBe(216000);
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

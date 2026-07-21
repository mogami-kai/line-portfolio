import { describe, it, expect } from "vitest";
import { shouldRunReminder, buildReminderMessage } from "./dueReminder.js";

describe("shouldRunReminder（送信判定）", () => {
  const base = {
    enabled: true,
    reminderHour: 9,
    nowHour: 9,
    lastSentOnIso: null as string | null,
    todayIso: "2026-07-31",
  };

  it("有効・設定時刻以降・未送信 → true", () => {
    expect(shouldRunReminder(base)).toBe(true);
    expect(shouldRunReminder({ ...base, nowHour: 15 })).toBe(true);
  });

  it("無効 → false", () => {
    expect(shouldRunReminder({ ...base, enabled: false })).toBe(false);
  });

  it("設定時刻より前 → false", () => {
    expect(shouldRunReminder({ ...base, nowHour: 8 })).toBe(false);
  });

  it("今日は送信済み → false", () => {
    expect(
      shouldRunReminder({ ...base, lastSentOnIso: "2026-07-31" }),
    ).toBe(false);
  });

  it("送信済みが昨日なら今日は送る → true", () => {
    expect(
      shouldRunReminder({ ...base, lastSentOnIso: "2026-07-30" }),
    ).toBe(true);
  });
});

describe("buildReminderMessage（文面）", () => {
  it("取引先名・金額・合計を含む", () => {
    const msg = buildReminderMessage(new Date("2026-07-31T00:00:00Z"), [
      { clientName: "A建設", honorific: "様", total: 330000 },
      { clientName: "B工業", honorific: "御中", total: 180000 },
    ]);
    expect(msg).toContain("7/31");
    expect(msg).toContain("A建設 様 ¥330,000");
    expect(msg).toContain("B工業 御中 ¥180,000");
    expect(msg).toContain("合計 ¥510,000");
    expect(msg).toContain("入金をご確認ください。");
  });
});

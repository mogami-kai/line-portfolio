import { describe, it, expect } from "vitest";
import {
  buildLateEntryNotice,
  entryLateDays,
  isLateEntry,
} from "./lateEntry.js";

/** 出面の日付（UTC 0時保存の @db.Date と同じ形）。 */
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("entryLateDays — 入力した日(JST) − 出面の日付", () => {
  it("当日の入力は 0", () => {
    // JST 10/21 18:00 = UTC 10/21 09:00
    expect(entryLateDays(day("2026-10-21"), new Date("2026-10-21T09:00:00Z"))).toBe(0);
  });

  it("翌朝の入力は 1（夜勤明けの入力など）", () => {
    expect(entryLateDays(day("2026-10-20"), new Date("2026-10-21T00:30:00Z"))).toBe(1);
  });

  it("JST の日付で数える（UTC ではまだ前日の JST 早朝）", () => {
    // JST 10/22 07:00 = UTC 10/21 22:00 → JST では 10/22 なので 10/20 の出面は 2日後
    expect(entryLateDays(day("2026-10-20"), new Date("2026-10-21T22:00:00Z"))).toBe(2);
  });

  it("月をまたいでも日数で数える", () => {
    expect(entryLateDays(day("2026-09-28"), new Date("2026-10-03T03:00:00Z"))).toBe(5);
  });

  it("未来日の出面は負", () => {
    expect(entryLateDays(day("2026-10-23"), new Date("2026-10-21T03:00:00Z"))).toBe(-2);
  });
});

describe("isLateEntry — しきい値", () => {
  it("既定 2: 当日・翌日はそのまま、2日以上あとは後日入力", () => {
    expect(isLateEntry(0, 2)).toBe(false);
    expect(isLateEntry(1, 2)).toBe(false);
    expect(isLateEntry(2, 2)).toBe(true);
    expect(isLateEntry(10, 2)).toBe(true);
  });

  it("null / 0 は判定しない（使わない）", () => {
    expect(isLateEntry(30, null)).toBe(false);
    expect(isLateEntry(30, undefined)).toBe(false);
    expect(isLateEntry(30, 0)).toBe(false);
  });

  it("未来日は後日入力にならない", () => {
    expect(isLateEntry(-3, 1)).toBe(false);
  });
});

describe("buildLateEntryNotice", () => {
  it("理由が無ければ空文字", () => {
    expect(buildLateEntryNotice([])).toBe("");
  });

  it("理由を箇条書きにして、集計に入らないことを伝える", () => {
    const msg = buildLateEntryNotice(["後日入力（3日後の入力）"]);
    expect(msg).toContain("【管理者の承認待ち】");
    expect(msg).toContain("・後日入力（3日後の入力）");
    expect(msg).toContain("集計・請求には入りません");
  });
});

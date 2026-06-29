import { describe, it, expect } from "vitest";
import { formatReportLog, type ReportLogInput } from "./line.js";

type Shift = "DAY" | "HALF" | "NIGHT";
// テスト用の職人エントリ生成（半日は0.5人工）。
const W = (name: string, shift: Shift = "DAY", otHours = 0) => ({
  shift,
  manDays: shift === "HALF" ? 0.5 : 1,
  otHours,
  worker: { name },
});

describe("formatReportLog（出面グループ投稿フォーマット）", () => {
  it("基本：日付(曜) / 取引先　契約 / 現場 / 職人", () => {
    const r: ReportLogInput = {
      workDate: new Date("2026-06-27T00:00:00.000Z"),
      contractType: "JOYO",
      client: { name: "辻濱興業" },
      site: { name: "東芝" },
      entries: [W("齋"), W("金子")],
    };
    expect(formatReportLog(r)).toBe(
      "6月27日(土)\n辻濱興業　常用\n東芝\n齋　金子",
    );
  });

  it("残業は各人に（残1h）で注記", () => {
    const r: ReportLogInput = {
      workDate: new Date("2026-01-20T00:00:00.000Z"),
      contractType: "JOYO",
      client: { name: "恵興業" },
      site: { name: "追浜造船所" },
      entries: [W("後藤"), W("齋", "DAY", 1), W("金子")],
    };
    expect(formatReportLog(r)).toBe(
      "1月20日(火)\n恵興業　常用\n追浜造船所\n後藤　齋（残1h）　金子",
    );
  });

  it("半日・夜勤の注記＋経費を併記", () => {
    const r: ReportLogInput = {
      workDate: new Date("2026-06-10T00:00:00.000Z"),
      contractType: "JOYO",
      client: { name: "辻濱工業" },
      site: { name: "橋本" },
      entries: [W("後藤"), W("石渡", "HALF"), W("山口", "NIGHT")],
      expenses: [{ kind: "パーキング", amount: 800 }],
    };
    expect(formatReportLog(r)).toBe(
      "6月10日(水)\n辻濱工業　常用\n橋本\n後藤　石渡（半日）　山口（夜勤）\nパーキング800円",
    );
  });

  it("請負・現場未設定", () => {
    const r: ReportLogInput = {
      workDate: new Date("2026-06-12T00:00:00.000Z"),
      contractType: "UKEOI",
      client: { name: "辻濱工業" },
      site: null,
      entries: [W("齋")],
    };
    expect(formatReportLog(r)).toBe(
      "6月12日(金)\n辻濱工業　請負\n(現場未設定)\n齋",
    );
  });

  it("曜日は UTC で読む（workDate=UTC 0時。前日/翌日にずれない）", () => {
    const r: ReportLogInput = {
      workDate: new Date("2026-02-08T00:00:00.000Z"), // 日曜
      contractType: "JOYO",
      client: { name: "MALU" },
      site: { name: "Kアリーナ" },
      entries: [W("石渡", "NIGHT"), W("久保", "NIGHT")],
    };
    expect(formatReportLog(r)).toBe(
      "2月8日(日)\nMALU　常用\nKアリーナ\n石渡（夜勤）　久保（夜勤）",
    );
  });

  it("ローンチ動作確認: 6/29(月) 辻濱興業 常用 綱島 / 斎・山口", () => {
    const r: ReportLogInput = {
      workDate: new Date("2026-06-29T00:00:00.000Z"),
      contractType: "JOYO",
      client: { name: "辻濱興業" },
      site: { name: "綱島" },
      entries: [W("斎"), W("山口")],
    };
    // 自社(SELF)の送信時、この文面が bot から LINE_GROUP_ID のグループへ投稿される。
    expect(formatReportLog(r)).toBe(
      "6月29日(月)\n辻濱興業　常用\n綱島\n斎　山口",
    );
  });
});

import { describe, it, expect } from "vitest";
import {
  normalizeNameKey,
  validateClientField,
  validateDateField,
  validateQtyField,
  validateOtField,
  validateWorkerName,
  validateRow,
  validateReportRows,
  buildAskbackMessage,
} from "./validate.js";

// 基準日 2026-03-15 12:00。すべてダミー名で運用の代表エラーを再現。
const REF = new Date(2026, 2, 15, 12, 0, 0);

// 既知の取引先（ダミー正式名）＋別名解決のスタブ
const CANON = ["MELO", "丸栄工業", "あおぞら設備", "ひかり建設", "なかむら組"];
const ALIAS: Record<string, string> = {
  melo: "MELO",
  丸栄工業: "丸栄工業",
  あおぞら設備: "あおぞら設備",
  ひかり建設: "ひかり建設",
  なかむら組: "なかむら組",
};
const resolve = (raw: string): string =>
  ALIAS[normalizeNameKey(raw)] ||
  (CANON.includes(String(raw).trim()) ? String(raw).trim() : "");

// ============================================================
// 1. 取引先（表記揺れ＝ローマ字 L/R・末尾ゆれ・漢字1字違い 工/興）
// ============================================================
describe("取引先", () => {
  it("正式名・別名は ok / 表記揺れは confirm(候補提示) / 新規は hold", () => {
    expect(validateClientField("MELO", CANON, resolve).status).toBe("ok");
    expect(validateClientField("melo", CANON, resolve).status).toBe("ok");

    const lr = validateClientField("MERO", CANON, resolve); // L/R ゆれ
    expect(lr.status).toBe("confirm");
    expect(lr.suggestion).toBe("MELO");

    const tail = validateClientField("MELL", CANON, resolve); // 末尾ゆれ
    expect(tail.status).toBe("confirm");
    expect(tail.suggestion).toBe("MELO");

    const kanji = validateClientField("丸栄興業", CANON, resolve); // 工 vs 興
    expect(kanji.status).toBe("confirm");
    expect(kanji.suggestion).toBe("丸栄工業");

    expect(validateClientField("知らない会社", CANON, resolve).status).toBe(
      "hold",
    );
    expect(validateClientField("", CANON, resolve).status).toBe("hold");
  });
});

// ============================================================
// 2. 日付（refDate を実際に使うこと）
// ============================================================
describe("日付", () => {
  it("多様な表記を解釈 / 未来日・古すぎ・不正日は confirm or hold", () => {
    expect(validateDateField("3月14日", REF).status).toBe("ok");
    expect(validateDateField("3/14", REF).status).toBe("ok");
    expect(validateDateField("2026/3/14", REF).status).toBe("ok");
    expect(validateDateField("3/10(火)", REF).value).toBe("2026-03-10");

    // 1/8 のつもりで 11/8 → 未来日として confirm
    expect(validateDateField("11月8日", REF).status).toBe("confirm");
    // 未来日
    expect(validateDateField("3月25日", REF).status).toBe("confirm");
    // 存在しない日（2026は閏年でない）
    expect(validateDateField("2月29日", REF).status).toBe("hold");
    // 読み取れない
    expect(validateDateField("きのう", REF).status).toBe("hold");
  });

  it("refDate が実際に使われる（基準日で年を補完・古い日付判定）", () => {
    // 基準日を 2026-12-20 にすると「1月10日」は前年でなく当年=未来日扱い前の範囲外
    const refDec = new Date(2026, 11, 20, 12, 0, 0);
    const r = validateDateField("1月10日", refDec);
    expect(r.value).toBe("2026-01-10");
    // 2026-01-10 は基準(12/20)から見て -344 日 → 古い日付 confirm
    expect(r.status).toBe("confirm");
  });
});

// ============================================================
// 3. 人工 / 4. 残業
// ============================================================
describe("人工", () => {
  it("0.5/0.75/1 は ok / >1 は confirm / 0・非数値は hold", () => {
    expect(validateQtyField(0.5).status).toBe("ok");
    expect(validateQtyField(0.75).status).toBe("ok");
    expect(validateQtyField(1).status).toBe("ok");
    expect(validateQtyField(1.5).status).toBe("confirm");
    expect(validateQtyField(2.5).status).toBe("confirm");
    expect(validateQtyField(0).status).toBe("hold");
    expect(validateQtyField("x").status).toBe("hold");
  });
});

describe("残業", () => {
  it("0〜3h は ok / それ以上は confirm / 負は hold", () => {
    expect(validateOtField(0).status).toBe("ok");
    expect(validateOtField(1).status).toBe("ok");
    expect(validateOtField(3).status).toBe("ok");
    expect(validateOtField(5).status).toBe("confirm");
    expect(validateOtField(10).status).toBe("confirm");
    expect(validateOtField(-1).status).toBe("hold");
  });
});

// ============================================================
// 5. 職人名（スペース抜けでのマーカー食い込み）
// ============================================================
describe("職人名", () => {
  it("マーカー/数字の食い込みを confirm", () => {
    expect(validateWorkerName("職人A").status).toBe("ok");
    expect(validateWorkerName("職人A半日").status).toBe("confirm");
    expect(validateWorkerName("職人A1").status).toBe("confirm");
    expect(validateWorkerName("職人A残業1").status).toBe("confirm");
  });
});

// ============================================================
// 6. 行・レポート総合判定
// ============================================================
describe("行・レポート総合判定", () => {
  const ctx = { canonicals: CANON, resolveClient: resolve, refDate: REF };

  it("全項目正常は ok / 1つでも怪しいと confirm or hold", () => {
    expect(
      validateRow(
        { client: "MELO", date: "3月14日", worker: "職人B", qty: 1, ot: 0 },
        ctx,
      ).status,
    ).toBe("ok");

    expect(
      validateRow(
        { client: "MERO", date: "3月14日", worker: "職人B", qty: 1, ot: 0 },
        ctx,
      ).status,
    ).toBe("confirm");

    expect(
      validateRow(
        { client: "知らない", date: "2月29日", worker: "職人B", qty: 1, ot: 0 },
        ctx,
      ).status,
    ).toBe("hold");
  });

  it("同一現場で同じ職人が重複したら confirm（聞き返し文に重複指摘）", () => {
    const rows = [
      { client: "MELO", site: "現場X", date: "3月14日", worker: "職人A", qty: 1, ot: 0 },
      { client: "MELO", site: "現場X", date: "3月14日", worker: "職人A", qty: 1, ot: 0 },
    ];
    const rep = validateReportRows(rows, ctx);
    expect(rep.status).toBe("confirm");
    expect(/重複/.test(buildAskbackMessage(rep))).toBe(true);
  });

  it("正常レポートは聞き返し空文字（聞かない）", () => {
    const rows = [
      { client: "MELO", site: "現場X", date: "3月14日", worker: "職人B", qty: 1, ot: 0 },
    ];
    const rep = validateReportRows(rows, ctx);
    expect(rep.status).toBe("ok");
    expect(buildAskbackMessage(rep)).toBe("");
  });
});

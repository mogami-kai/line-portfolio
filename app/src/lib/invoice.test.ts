import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  aggregateForInvoice,
  buildClientLines,
  buildInvoiceLines,
  summarize,
  toCSV,
  toXlsx,
  type ClientAgg,
} from "./invoice.js";

describe("aggregateForInvoice", () => {
  it("常用を取引先×現場で合算、請負/立替は取引先に積む", () => {
    const agg = aggregateForInvoice([
      { client: "ダミー商事", site: "現場X", manDays: 1, otHours: 0.5, contractType: "JOYO" },
      { client: "ダミー商事", site: "現場X", manDays: 1, otHours: 0.5, contractType: "JOYO" },
      { client: "ダミー商事", site: "現場Y", manDays: 0.5, otHours: 0, contractType: "JOYO" },
      { client: "ダミー商事", site: "", manDays: 0, otHours: 0, contractType: "UKEOI", lump: 500000 },
      { client: "ダミー商事", site: "", manDays: 0, otHours: 0, contractType: "UKEOI", expense: 8000 },
    ]);
    expect(agg["ダミー商事"].sites["現場X"]).toEqual({ manDays: 2, otHours: 1 });
    expect(agg["ダミー商事"].sites["現場Y"]).toEqual({ manDays: 0.5, otHours: 0 });
    expect(agg["ダミー商事"].lump).toBe(500000);
    expect(agg["ダミー商事"].expense).toBe(8000);
  });
});

// テンプレ準拠の中核ケース（タスク指定）
const AGG: ClientAgg = {
  sites: { 現場X: { manDays: 2, otHours: 1 } },
  lump: 500000,
  expense: 8000,
};
const TAX = 0.1;
const lines = buildInvoiceLines(AGG, { rateFor: () => 20000, taxRate: TAX });

describe("buildInvoiceLines", () => {
  it("常用 amount=40000（2人工×20000）", () => {
    const joyo = lines.find((l) => l.itemName === "現場X 常用");
    expect(joyo).toBeDefined();
    expect(joyo!.qty).toBe(2);
    expect(joyo!.unitLabel).toBe("人工");
    expect(joyo!.unitPrice).toBe(20000);
    expect(joyo!.amount).toBe(40000);
    expect(joyo!.taxRate).toBe(0.1);
  });

  it("残業 line present: unitPrice=round(20000/8*1.25)=3125, amount=3125", () => {
    const ot = lines.find((l) => l.itemName === "現場X 残業");
    expect(ot).toBeDefined();
    expect(ot!.qty).toBe(1);
    expect(ot!.unitLabel).toBe("時間");
    expect(ot!.unitPrice).toBe(3125);
    expect(ot!.amount).toBe(3125);
  });

  it("請負工事一式 500000, 立替経費 taxRate=0", () => {
    const lump = lines.find((l) => l.itemName === "請負工事一式");
    expect(lump).toBeDefined();
    expect(lump!.unitPrice).toBe(500000);
    expect(lump!.amount).toBe(500000);
    expect(lump!.taxRate).toBe(0.1);

    const exp = lines.find((l) => l.itemName.startsWith("立替経費"));
    expect(exp).toBeDefined();
    expect(exp!.amount).toBe(8000);
    expect(exp!.taxRate).toBe(0);
  });

  it("残業なしの現場は残業行を出さない / sortNo は1から連番", () => {
    const noOt = buildInvoiceLines(
      { sites: { 現場Z: { manDays: 1, otHours: 0 } }, lump: 0, expense: 0 },
      { rateFor: () => 18000, taxRate: TAX },
    );
    expect(noOt).toHaveLength(1);
    expect(noOt[0].sortNo).toBe(1);
    expect(lines.map((l) => l.sortNo)).toEqual([1, 2, 3, 4]);
  });

  it("単価未設定（rateFor→null）は unitPrice=0・amount=0", () => {
    const noRate = buildInvoiceLines(
      { sites: { 現場W: { manDays: 1, otHours: 0 } }, lump: 0, expense: 0 },
      { rateFor: () => null, taxRate: TAX },
    );
    expect(noRate[0].unitPrice).toBe(0);
    expect(noRate[0].amount).toBe(0);
  });

  it("lumpItems があれば案件ごとに「{name} 一式」を個別出力（集約lumpは無視）", () => {
    const withLumps = buildInvoiceLines(
      {
        sites: {},
        lump: 999999, // lumpItems があるので無視される
        expense: 0,
        lumpItems: [
          { name: "ダミー改修A", amount: 300000 },
          { name: "ダミー新築B", amount: 450000 },
          { name: "金額ゼロは出さない", amount: 0 },
        ],
      },
      { rateFor: () => 0, taxRate: TAX },
    );
    expect(withLumps).toHaveLength(2);
    expect(withLumps[0].itemName).toBe("ダミー改修A 一式");
    expect(withLumps[0].amount).toBe(300000);
    expect(withLumps[0].unitLabel).toBe("式");
    expect(withLumps[1].itemName).toBe("ダミー新築B 一式");
    expect(withLumps[1].amount).toBe(450000);
    // sortNo は 1 から連番
    expect(withLumps.map((l) => l.sortNo)).toEqual([1, 2]);
  });

  it("lumpItems 未指定なら従来どおり集約 lump を「請負工事一式」で出力", () => {
    const agg = buildInvoiceLines(
      { sites: {}, lump: 500000, expense: 0 },
      { rateFor: () => 0, taxRate: TAX },
    );
    expect(agg).toHaveLength(1);
    expect(agg[0].itemName).toBe("請負工事一式");
    expect(agg[0].amount).toBe(500000);
  });
});

describe("buildClientLines（取引先単位・自動計算）", () => {
  it("委託料＋残業を出し、残業は「単価×数量＝金額」が一致（割り切れない単価でも）", () => {
    // 18000/8*1.25 = 2812.5 → 表示単価 2813。amount は round(2813×2)=5626。
    // 旧実装の overtimeAmount(2,18000)=round(2×2812.5)=5625 とは 1 円ズレるが、
    // 帳票フェイスでは「単価2813×数量2=5626」と一致する（こちらが正）。
    const lines = buildClientLines(
      { manDays: 10, otHours: 2, expenses: [] },
      { unitPrice: 18000, taxRate: 0.1 },
    );
    const itaku = lines.find((l) => l.itemName === "委託料")!;
    expect(itaku.qty).toBe(10);
    expect(itaku.unitPrice).toBe(18000);
    expect(itaku.amount).toBe(180000);
    expect(itaku.taxRate).toBe(0.1);

    const ot = lines.find((l) => l.itemName === "残業")!;
    expect(ot.unitPrice).toBe(2813);
    expect(ot.qty).toBe(2);
    expect(ot.amount).toBe(5626);
    expect(ot.amount).toBe(ot.unitPrice * ot.qty); // 検算一致
    expect(ot.taxRate).toBe(0.1);
  });

  it("立替経費は種別ごとに「立替 ◯◯」で税率0（対象外）", () => {
    const lines = buildClientLines(
      {
        manDays: 0,
        otHours: 0,
        expenses: [
          { kind: "駐車", amount: 3000 },
          { kind: "燃料", amount: 0 }, // 0 は出さない
        ],
      },
      { unitPrice: 20000, taxRate: 0.1 },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].itemName).toBe("立替 駐車");
    expect(lines[0].amount).toBe(3000);
    expect(lines[0].taxRate).toBe(0);
  });

  it("請負（lumpItems）は「{name} 一式」で計上、全0なら空配列", () => {
    const withLump = buildClientLines(
      { manDays: 0, otHours: 0, expenses: [], lumpItems: [{ name: "ダミー改修", amount: 250000 }] },
      { unitPrice: 0, taxRate: 0.1 },
    );
    expect(withLump).toHaveLength(1);
    expect(withLump[0].itemName).toBe("ダミー改修 一式");
    expect(withLump[0].amount).toBe(250000);

    const empty = buildClientLines(
      { manDays: 0, otHours: 0, expenses: [] },
      { unitPrice: 20000, taxRate: 0.1 },
    );
    expect(empty).toHaveLength(0);
  });
});

// v3 P2/P3: 請負(UKEOI) = ukeoiAmounts → 各 Report 1 行「○月委託料 数量1 単位=式 単価=金額」。
// 常用(JOYO) = 人工×単価。両系統を並べても二重計上しないことの回帰テスト。
describe("buildClientLines（v3: 請負=数量1委託料 / 常用=人工×単価）", () => {
  it("請負(ukeoiAmounts)は案件ごとに「{joyoItemName} 一式扱い」数量1・単位=式・単価=金額", () => {
    const lines = buildClientLines(
      { manDays: 0, otHours: 0, expenses: [], ukeoiAmounts: [300000, 150000, 0] },
      { unitPrice: 0, taxRate: 0.1, joyoItemName: "6月委託料" },
    );
    // 0 円は出さない → 2 行。
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l.itemName).toBe("6月委託料"); // 品目名は常用と共通（写真の体裁）
      expect(l.qty).toBe(1);
      expect(l.unitLabel).toBe("式");
      expect(l.taxRate).toBe(0.1);
      // 数量1なので単価=金額（検算一致）。
      expect(l.amount).toBe(l.unitPrice * l.qty);
    }
    expect(lines[0].unitPrice).toBe(300000);
    expect(lines[0].amount).toBe(300000);
    expect(lines[1].unitPrice).toBe(150000);
    expect(lines[1].amount).toBe(150000);
    expect(lines.map((l) => l.sortNo)).toEqual([1, 2]);
  });

  it("常用(人工×単価)＋請負(数量1)を並べても二重計上せず、独立して積まれる", () => {
    // 常用 12 人工 × 21000 = 252000、請負 2 件（300000 + 150000）。
    const lines = buildClientLines(
      { manDays: 12, otHours: 0, expenses: [], ukeoiAmounts: [300000, 150000] },
      { unitPrice: 21000, taxRate: 0.1, joyoItemName: "6月委託料" },
    );
    // 委託料(常用) 1 行 + 請負 2 行 = 3 行（残業・立替なし）。
    expect(lines).toHaveLength(3);

    const joyo = lines[0];
    expect(joyo.itemName).toBe("6月委託料");
    expect(joyo.qty).toBe(12); // 人工合計（請負の数量1は混ざらない）
    expect(joyo.unitLabel).toBe("人工");
    expect(joyo.unitPrice).toBe(21000);
    expect(joyo.amount).toBe(252000); // 12×21000、請負額は混ざらない

    // 請負 2 行は数量1・式。
    expect(lines[1].amount).toBe(300000);
    expect(lines[2].amount).toBe(150000);

    // 二重計上していない＝課税税込は 252000 + 300000 + 150000 = 702000。
    // 内税: 小計(税抜)=round(702000/1.1)=638182、消費税=702000−638182、合計=702000。
    const s = summarize(lines, 0.1);
    expect(s.subtotal).toBe(638182);
    expect(s.tax).toBe(702000 - 638182);
    expect(s.exempt).toBe(0);
    expect(s.total).toBe(702000);
  });

  it("joyoItemName 未指定なら請負は既定の「委託料」で計上", () => {
    const lines = buildClientLines(
      { manDays: 0, otHours: 0, expenses: [], ukeoiAmounts: [500000] },
      { unitPrice: 0, taxRate: 0.1 },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].itemName).toBe("委託料");
    expect(lines[0].qty).toBe(1);
    expect(lines[0].amount).toBe(500000);
  });
});

describe("summarize（内税/税込）", () => {
  it("小計=round(課税税込/1.1), 消費税=課税税込−小計, exempt=立替, 合計=課税税込+対象外(=集計額)", () => {
    const s = summarize(lines, TAX);
    // 課税(税込): 40000(常用) + 3125(残業) + 500000(請負) = 543125
    expect(s.subtotal).toBe(493750); // round(543125/1.1)=493750
    expect(s.tax).toBe(543125 - 493750); // 49375
    expect(s.tax).toBe(49375);
    expect(s.exempt).toBe(8000);
    // 合計（税込）は課税税込＋対象外＝集計の額。従来の「合計が10%上がる」外税ではない。
    expect(s.total).toBe(543125 + 8000);
  });
});

describe("toCSV", () => {
  it("ヘッダ行＋常用/残業/請負/立替 行を含む", () => {
    const csv = toCSV(
      { invoiceNo: "2026-001", issueDate: "2026/06/30", client: "ダミー商事" },
      lines,
    );
    expect(csv).toContain("No,品目・内容,数量,単位,単価,金額,税率");
    expect(csv).toContain("現場X 常用");
    expect(csv).toContain("現場X 残業");
    expect(csv).toContain("請負工事一式");
    expect(csv).toContain("立替経費");
    // 立替は対象外表記
    expect(csv).toContain("対象外");
    // 請求書メタも含む
    expect(csv).toContain("2026-001");
  });

  it("CSVインジェクション: =,+,-,@ 始まりのセルは ' で無害化", () => {
    const malicious = buildClientLines(
      { manDays: 0, otHours: 0, expenses: [], lumpItems: [{ name: "=HYPERLINK(\"http://x\")", amount: 1000 }] },
      { unitPrice: 0, taxRate: 0.1 },
    );
    const csv = toCSV(
      { invoiceNo: "2026-001", issueDate: "2026/06/30", client: "=cmd|'/c calc'!A1" },
      malicious,
    );
    // 宛先（取引先名）と案件名（itemName）の双方が ' プリフィックスされる
    expect(csv).toContain("'=cmd");
    expect(csv).toContain("'=HYPERLINK");
    // 生の =cmd（' なし）で始まる行が無い
    expect(csv.split(/\r?\n/).some((line) => /(^|,)=cmd/.test(line))).toBe(false);
  });
});

describe("toXlsx（template_013 空テンプレ注入）", () => {
  // テンプレ注入レイアウト: 宛先 B6 / 住所 B8 / 振込先 K6 / 請求金額 F11 /
  //   明細 FIRST=18（B=品目 J=数量 K=単価 M=金額）/ 小計 I50 / 消費税 K50 / 合計 M50。
  const FIRST = 18;

  it("宛先/振込先/明細/合計をテンプレに注入し、再読込で検証できる", async () => {
    const wb = await toXlsx({
      invoiceNo: "2026-001",
      issueDate: "2026/06/30",
      yearMonth: "2026-06",
      client: "ダミー商事",
      honorific: "様",
      address: "ダミー県1-2-3",
      issuer: { issuerName: "ダミー工務店", tel: "090-0000-0000", bankInfo: "ダミー銀行 ダミー支店 普通 0000000" },
      lines: [
        { sortNo: 1, itemName: "みなとみらい", qty: 7, unitLabel: "人工", unitPrice: 20000, amount: 140000, taxRate: 0.1 },
        { sortNo: 2, itemName: "橋本 夜勤", qty: 2, unitLabel: "人工", unitPrice: 23000, amount: 46000, taxRate: 0.1 },
        { sortNo: 3, itemName: "残業代", qty: 1, unitLabel: "時間", unitPrice: 3125, amount: 3125, taxRate: 0.1 },
      ],
      taxRate: 0.1,
    });
    const buf = await wb.xlsx.writeBuffer();
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(buf as ArrayBuffer);
    const ws = wb2.worksheets[0]!;
    const txt = (addr: string) => {
      const v = ws.getCell(addr).value as unknown;
      if (v && typeof v === "object" && "richText" in (v as object)) {
        return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join("");
      }
      return v;
    };

    // 宛先・振込先・請求金額
    expect(String(txt("B6"))).toContain("ダミー商事");
    expect(String(txt("B6"))).toContain("様");
    expect(String(txt("B8"))).toContain("ダミー県");
    expect(String(txt("K6"))).toContain("ダミー銀行");
    // 内税: ご請求金額（税込）= 課税税込の合計（10%上乗せしない）。
    expect(ws.getCell("F11").value).toBe(140000 + 46000 + 3125);

    // 明細（B=品目 / J=数量 / K=単価 / M=金額）
    expect(txt(`B${FIRST}`)).toBe("みなとみらい");
    expect(ws.getCell(`J${FIRST}`).value).toBe(7);
    expect(ws.getCell(`K${FIRST}`).value).toBe(20000);
    expect(ws.getCell(`M${FIRST}`).value).toBe(140000);
    expect(txt(`B${FIRST + 1}`)).toBe("橋本 夜勤");
    expect(txt(`B${FIRST + 2}`)).toBe("残業代");

    // 合計（内税: 小計 I50 / 消費税 K50 / 合計 M50）
    const taxableIncl = 140000 + 46000 + 3125; // 189125（税込）
    const subtotal = Math.round(taxableIncl / 1.1); // 171932
    expect(ws.getCell("I50").value).toBe(subtotal);
    expect(ws.getCell("K50").value).toBe(taxableIncl - subtotal);
    expect(ws.getCell("M50").value).toBe(taxableIncl);

    // 日付は Excel シリアル値（数値）で入れる → 日付書式セルとして解釈され、
    // 読み戻すと Date になる（＝書式の日付部・「支払期限:」ラベルが効く）。文字列ではない。
    const o1 = ws.getCell("O1").value as Date;
    expect(o1 instanceof Date).toBe(true);
    expect(o1.toISOString().slice(0, 10)).toBe("2026-06-30");
    const b49 = ws.getCell("B49").value as Date;
    expect(b49 instanceof Date).toBe(true);
    expect(b49.toISOString().slice(0, 10)).toBe("2026-06-30");
  });

  it("立替（対象外・税率0）は小計に含めず合計に加算する", async () => {
    const wb = await toXlsx({
      invoiceNo: "2026-002",
      issueDate: "2026/06/30",
      client: "ダミー商事",
      lines: [
        { sortNo: 1, itemName: "みなとみらい", qty: 1, unitLabel: "人工", unitPrice: 20000, amount: 20000, taxRate: 0.1 },
        { sortNo: 2, itemName: "立替 パーキング", qty: 1, unitLabel: "式", unitPrice: 800, amount: 800, taxRate: 0 },
      ],
      taxRate: 0.1,
    });
    const buf = await wb.xlsx.writeBuffer();
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(buf as ArrayBuffer);
    const ws = wb2.worksheets[0]!;
    // 内税: 小計=round(20000/1.1)=18182 / 消費税=20000−18182=1818 /
    //   合計=課税税込20000＋対象外800=20800（10%上乗せしない）。
    expect(ws.getCell("I50").value).toBe(18182);
    expect(ws.getCell("K50").value).toBe(1818);
    expect(ws.getCell("M50").value).toBe(20800);
  });
});

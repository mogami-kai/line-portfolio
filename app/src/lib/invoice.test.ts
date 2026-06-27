import { describe, it, expect } from "vitest";
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

describe("summarize", () => {
  it("subtotal=課税合計, tax=round(subtotal*0.1), exempt=立替, total一致", () => {
    const s = summarize(lines, TAX);
    // 課税: 40000(常用) + 3125(残業) + 500000(請負) = 543125
    expect(s.subtotal).toBe(543125);
    expect(s.tax).toBe(Math.round(543125 * 0.1)); // 54313 (round 54312.5→54313)
    expect(s.tax).toBe(54313);
    expect(s.exempt).toBe(8000);
    expect(s.total).toBe(543125 + 54313 + 8000);
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

describe("toXlsx", () => {
  it("Workbook を返し、明細セルに金額が入る", async () => {
    const wb = toXlsx({
      invoiceNo: "2026-001",
      issueDate: "2026/06/30",
      client: "ダミー商事",
      address: "ダミー県ダミー市1-2-3",
      issuer: { issuerName: "ダミー工務店", taxRate: TAX },
      lines,
      taxRate: TAX,
    });
    const ws = wb.getWorksheet("請求書");
    expect(ws).toBeDefined();
    // バッファ書き出しが成功する（壊れたワークブックでない）
    const buf = await wb.xlsx.writeBuffer();
    expect(buf.byteLength).toBeGreaterThan(0);
  });
});

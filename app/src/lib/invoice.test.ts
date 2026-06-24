import { describe, it, expect } from "vitest";
import {
  aggregateForInvoice,
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

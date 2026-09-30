// ============================================================
// 粗利（lib/profit）の純粋関数テスト。
//   売上＝請求書と同じ計算か、取り分の端数、閲覧範囲（協力会社を自社側に出さない）を固める。
// ============================================================

import { describe, it, expect } from "vitest";
import {
  composeProfit,
  computeSalesBySource,
  profitBlock,
  profitScopeFor,
  splitShare,
  sumExpensesBySource,
  sumLabor,
  type SalesReportRow,
} from "./profit.js";
import { buildBillingLines } from "./invoice.js";
import { collectBillingWork } from "./invoiceService.js";
import type { ClientRateInfo, WorkerMonthSummary } from "./aggregate.js";

const rate = (over: Partial<ClientRateInfo> = {}): ClientRateInfo => ({
  resolvedUnit: 20000,
  clientUnitPrice: 20000,
  nightUnitPrice: null,
  otUnitPrice: null,
  billingMode: "AGGREGATE",
  ...over,
});

const report = (over: Partial<SalesReportRow> = {}): SalesReportRow => ({
  clientId: "c1",
  clientName: "辻濱興業",
  source: "SELF",
  contractType: "JOYO",
  contractAmount: null,
  siteName: "みなとみらい",
  site: null,
  entries: [{ shift: "DAY", manDays: 1, otHours: 0 }],
  ...over,
});

const worker = (over: Partial<WorkerMonthSummary> = {}): WorkerMonthSummary => ({
  workerId: "w1",
  workerName: "山田",
  manDays: 1,
  dayManDays: 1,
  halfManDays: 0,
  nightManDays: 0,
  otHours: 0,
  unitPrice: 15000,
  nightUnitPrice: 18750,
  otUnitPrice: null,
  pay: 15000,
  sites: [],
  ...over,
});

describe("profitScopeFor — 粗利を見られる範囲", () => {
  const self = { kind: "SELF" as const };
  const partner = { kind: "PARTNER" as const };

  it("ADMIN は設定に関係なく自社＋協力会社", () => {
    expect(profitScopeFor({ user: { role: "ADMIN" }, org: self }, [])).toBe("ALL");
  });

  it("許可された自社管理者は自社のみ", () => {
    expect(
      profitScopeFor({ user: { role: "SELF_ADMIN" }, org: self }, ["SELF_ADMIN"]),
    ).toBe("SELF");
  });

  it("許可されていないロールは見られない", () => {
    expect(
      profitScopeFor({ user: { role: "SELF_ADMIN" }, org: self }, ["ORG_ADMIN"]),
    ).toBeNull();
  });

  it("協力会社所属の組織管理者は許可されていても見られない", () => {
    expect(
      profitScopeFor({ user: { role: "ORG_ADMIN" }, org: partner }, ["ORG_ADMIN"]),
    ).toBeNull();
  });

  it("管理画面に入れないロールは設定に入っていても見られない", () => {
    expect(
      profitScopeFor({ user: { role: "OWNER" }, org: self }, ["OWNER"]),
    ).toBeNull();
  });
});

describe("splitShare — 取り分の分配", () => {
  it("20%を取り分、残りを会社に分ける", () => {
    expect(splitShare(350000, 0.2)).toEqual({ share: 70000, company: 280000 });
  });

  it("取り分は円未満切り捨て、会社はその残り（合計が一致）", () => {
    const r = splitShare(100001, 0.2);
    expect(r).toEqual({ share: 20000, company: 80001 });
    expect(r.share + r.company).toBe(100001);
  });

  it("0以下なら取り分0（会社がそのまま負担）", () => {
    expect(splitShare(-5000, 0.2)).toEqual({ share: 0, company: -5000 });
    expect(splitShare(0, 0.2)).toEqual({ share: 0, company: 0 });
  });

  it("率は0〜1に丸める", () => {
    expect(splitShare(1000, 1.5)).toEqual({ share: 1000, company: 0 });
    expect(splitShare(1000, -0.1)).toEqual({ share: 0, company: 1000 });
  });
});

describe("computeSalesBySource — 売上は請求書と同じ計算", () => {
  it("夜勤は取引先の夜勤単価、残業は残業単価で計算する", () => {
    const rates = new Map([
      ["c1", rate({ nightUnitPrice: 25000, otUnitPrice: 3000 })],
    ]);
    const out = computeSalesBySource(
      "2026-09",
      [
        report({ entries: [{ shift: "DAY", manDays: 1, otHours: 2 }] }),
        report({ entries: [{ shift: "NIGHT", manDays: 1, otHours: 0 }] }),
      ],
      rates,
      [],
    );
    // 日勤 20000 ＋ 夜勤 25000 ＋ 残業 2h×3000
    expect(out.SELF.sales).toBe(20000 + 25000 + 6000);
    expect(out.PARTNER.sales).toBe(0);
  });

  it("自社と協力会社に分け、合計は取引先の請求額と一致する", () => {
    const rows = [
      report({ source: "SELF", entries: [{ shift: "DAY", manDays: 2, otHours: 1 }] }),
      report({
        source: "PARTNER",
        siteName: "B現場",
        entries: [{ shift: "DAY", manDays: 3, otHours: 0 }],
      }),
    ];
    const rates = new Map([["c1", rate()]]);
    const out = computeSalesBySource("2026-09", rows, rates, []);
    expect(out.SELF.sales).toBe(40000 + Math.round((20000 / 8) * 1.25));
    expect(out.PARTNER.sales).toBe(60000);

    // 請求書（区分を分けずに1取引先ぶん）と同じ金額になる。
    const work = collectBillingWork(rows);
    const invoice = buildBillingLines(
      {
        billingMode: "AGGREGATE",
        yearMonth: "2026-09",
        unitPrice: 20000,
        nightUnitPrice: 0,
        otUnitPrice: null,
        otHours: work.otHours,
        sites: work.sites,
        ukeoiAmounts: work.ukeoiAmounts,
        lumpItems: [],
        expenses: [],
      },
      0.1,
    ).reduce((a, l) => a + l.amount, 0);
    expect(out.SELF.sales + out.PARTNER.sales).toBe(invoice);
  });

  it("請負（出面の契約金額）は出面の区分へ、請負一式（LumpContract）は自社へ", () => {
    const out = computeSalesBySource(
      "2026-09",
      [
        report({
          source: "PARTNER",
          contractType: "UKEOI",
          contractAmount: 300000,
          entries: [{ shift: "DAY", manDays: 5, otHours: 0 }],
        }),
      ],
      new Map([["c1", rate()], ["c2", rate()]]),
      [{ clientId: "c2", name: "外壁足場一式", amount: 500000 }],
    );
    // 請負の職人 entries は請求額に影響しない。
    expect(out.PARTNER.sales).toBe(300000);
    // 出面が無い取引先の請負一式も自社の売上に入る。
    expect(out.SELF.sales).toBe(500000);
  });

  it("単価未設定で常用の人工がある取引先を区分ごとに返す", () => {
    const out = computeSalesBySource(
      "2026-09",
      [
        report({ clientId: "c1", clientName: "辻濱興業" }),
        report({ clientId: "c2", clientName: "恵興業", source: "PARTNER" }),
      ],
      new Map([
        ["c1", rate({ resolvedUnit: 0, clientUnitPrice: null })],
        ["c2", rate({ resolvedUnit: 0, clientUnitPrice: null })],
      ]),
      [],
    );
    expect(out.SELF).toEqual({ sales: 0, unpricedClients: ["辻濱興業"] });
    expect(out.PARTNER).toEqual({ sales: 0, unpricedClients: ["恵興業"] });
  });
});

describe("sumLabor / sumExpensesBySource", () => {
  it("給料を合計し、単価未設定で出面のある職人を返す", () => {
    expect(
      sumLabor([
        worker({ workerName: "山田", pay: 300000 }),
        worker({ workerName: "佐藤", unitPrice: null, pay: 0 }),
        worker({ workerName: "鈴木", unitPrice: null, pay: 0, manDays: 0 }),
      ]),
    ).toEqual({ labor: 300000, unpricedWorkers: ["佐藤"] });
  });

  it("立替は区分ごとに合計し、出面なしは自社に入れる", () => {
    expect(
      sumExpensesBySource([
        { amount: 800, source: "SELF" },
        { amount: 1200, source: null },
        { amount: 500, source: "PARTNER" },
      ]),
    ).toEqual({ SELF: 2000, PARTNER: 500 });
  });
});

describe("composeProfit — 会社に残る額と取り分", () => {
  const noWarnings = {
    unpricedClients: [],
    unpricedPartnerClients: [],
    unpricedWorkers: [],
    unpricedPartnerWorkers: [],
  };

  it("売上−経費−人工 = 会社に残る額 → 20%/80%", () => {
    const p = composeProfit({
      self: profitBlock(1000000, 50000, 600000),
      partner: null,
      otherExpenses: [],
      shareName: "大和",
      shareRate: 0.2,
      warnings: noWarnings,
    });
    expect(p.self.remaining).toBe(350000);
    expect(p.remaining).toBe(350000);
    expect(p.share).toBe(70000);
    expect(p.company).toBe(280000);
  });

  it("協力会社分を足し、その他経費を引いてから分ける", () => {
    const p = composeProfit({
      self: profitBlock(1000000, 50000, 600000), // 350,000
      partner: profitBlock(400000, 0, 300000), // 100,000
      otherExpenses: [
        { id: "o1", name: "車両リース", amount: 40000 },
        { id: "o2", name: "保険", amount: 10000 },
      ],
      shareName: "大和",
      shareRate: 0.2,
      warnings: noWarnings,
    });
    expect(p.otherTotal).toBe(50000);
    expect(p.remaining).toBe(400000);
    expect(p.share).toBe(80000);
    expect(p.company).toBe(320000);
  });
});

// ============================================================
// 出面の LINE 通知（lib/notify）のテスト。
//   送り先の選定（ロール・見える範囲・友だち状態・本人除外）と、通知本文を固める。
//   ★ 協力会社の出面は自社管理者に絶対に送らない（自社にパートナーを見せない不変条件）。
// ============================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DEFAULT_NOTIFY_PARTNER_ROLES,
  DEFAULT_NOTIFY_SELF_ROLES,
  reportNotifyText,
  selectReportRecipients,
  type NotifyCandidate,
  type ReportForNotify,
} from "./notify.js";
import { formatReportLog, multicastToUsers } from "./line.js";

const user = (over: Partial<NotifyCandidate>): NotifyCandidate => ({
  id: "u",
  lineUserId: "U-x",
  role: "ADMIN",
  orgId: "org-self",
  orgKind: "SELF",
  approved: true,
  status: "ACTIVE",
  notifyReports: true,
  lineFriend: true,
  ...over,
});

const CANDIDATES: NotifyCandidate[] = [
  user({ id: "admin", lineUserId: "U-admin", role: "ADMIN" }),
  user({ id: "selfadmin", lineUserId: "U-selfadmin", role: "SELF_ADMIN" }),
  user({ id: "orgadmin-self", lineUserId: "U-orgadmin-self", role: "ORG_ADMIN" }),
  user({
    id: "orgadmin-p",
    lineUserId: "U-orgadmin-p",
    role: "ORG_ADMIN",
    orgId: "org-p",
    orgKind: "PARTNER",
  }),
  user({
    id: "orgadmin-p2",
    lineUserId: "U-orgadmin-p2",
    role: "ORG_ADMIN",
    orgId: "org-p2",
    orgKind: "PARTNER",
  }),
];

const DEFAULT_ROLES = {
  self: DEFAULT_NOTIFY_SELF_ROLES,
  partner: DEFAULT_NOTIFY_PARTNER_ROLES,
};

const ids = (xs: NotifyCandidate[]) => xs.map((x) => x.id).sort();

describe("selectReportRecipients — 送り先", () => {
  it("自社の出面（既定）: 管理者・自社管理者・自社の組織管理者", () => {
    const to = selectReportRecipients(
      { source: "SELF", orgId: "org-self" },
      CANDIDATES,
      DEFAULT_ROLES,
    );
    expect(ids(to)).toEqual(["admin", "orgadmin-self", "selfadmin"]);
  });

  it("協力会社の出面（既定）: 管理者だけ", () => {
    const to = selectReportRecipients(
      { source: "PARTNER", orgId: "org-p" },
      CANDIDATES,
      DEFAULT_ROLES,
    );
    expect(ids(to)).toEqual(["admin"]);
  });

  it("協力会社の出面は、その協力会社の組織管理者にだけ（他社には送らない）", () => {
    const to = selectReportRecipients(
      { source: "PARTNER", orgId: "org-p" },
      CANDIDATES,
      { self: [], partner: ["ADMIN", "ORG_ADMIN"] },
    );
    expect(ids(to)).toEqual(["admin", "orgadmin-p"]);
  });

  it("★協力会社の出面は、設定に入っていても自社管理者には送らない", () => {
    const to = selectReportRecipients(
      { source: "PARTNER", orgId: "org-p" },
      CANDIDATES,
      // 画面では選べないが、設定値が壊れていても送らないこと。
      { self: [], partner: ["ADMIN", "SELF_ADMIN", "ORG_ADMIN"] },
    );
    expect(ids(to)).not.toContain("selfadmin");
    expect(ids(to)).not.toContain("orgadmin-self");
  });

  it("通知先ロールを外したロールには送らない", () => {
    const to = selectReportRecipients(
      { source: "SELF", orgId: "org-self" },
      CANDIDATES,
      { self: ["ADMIN"], partner: [] },
    );
    expect(ids(to)).toEqual(["admin"]);
  });

  it("登録した本人には送らない", () => {
    const to = selectReportRecipients(
      { source: "SELF", orgId: "org-self", createdById: "admin" },
      CANDIDATES,
      DEFAULT_ROLES,
    );
    expect(ids(to)).not.toContain("admin");
  });

  it("通知OFF・友だち未追加(false)・未承認・無効の管理者には送らない（友だち状態が不明なら送る）", () => {
    const to = selectReportRecipients(
      { source: "SELF", orgId: "org-self" },
      [
        user({ id: "off", lineUserId: "U-off", notifyReports: false }),
        user({ id: "blocked", lineUserId: "U-blocked", lineFriend: false }),
        user({ id: "unknown", lineUserId: "U-unknown", lineFriend: null }),
        user({ id: "pending", lineUserId: "U-pending", approved: false }),
        user({ id: "disabled", lineUserId: "U-disabled", status: "DISABLED" }),
      ],
      DEFAULT_ROLES,
    );
    expect(ids(to)).toEqual(["unknown"]);
  });

  it("同じ LINE ユーザーには1回だけ送る", () => {
    const to = selectReportRecipients(
      { source: "SELF", orgId: "org-self" },
      [
        user({ id: "a", lineUserId: "U-same" }),
        user({ id: "b", lineUserId: "U-same", role: "SELF_ADMIN" }),
      ],
      DEFAULT_ROLES,
    );
    expect(to).toHaveLength(1);
  });
});

describe("reportNotifyText — 通知本文", () => {
  const rep: ReportForNotify = {
    workDate: new Date("2026-09-01T00:00:00.000Z"),
    contractType: "JOYO",
    contractAmount: null,
    siteName: "みなとみらい",
    client: { name: "辻濱興業" },
    entries: [{ shift: "DAY", manDays: 1, otHours: 2, worker: { name: "山田" } }],
    expenses: [{ kind: "パーキング", amount: 800 }],
  };

  it("自社は従来のグループ投稿と同じ文面", () => {
    expect(reportNotifyText(rep, { kind: "created" })).toBe(
      formatReportLog({
        workDate: rep.workDate,
        contractType: "JOYO",
        client: rep.client,
        site: { name: "みなとみらい" },
        entries: rep.entries,
        expenses: rep.expenses,
      }),
    );
  });

  it("協力会社は先頭に会社名を付ける", () => {
    const text = reportNotifyText(rep, { kind: "created", partnerOrgName: "協力A" });
    expect(text.split("\n")[0]).toBe("【協力会社 協力A】");
    expect(text).toContain("辻濱興業");
  });

  it("取消は【出面取消】で始まる", () => {
    expect(reportNotifyText(rep, { kind: "canceled" })).toMatch(/^【出面取消】/);
  });

  it("請負は現場行に請負金額を併記する", () => {
    const text = reportNotifyText(
      { ...rep, contractType: "UKEOI", contractAmount: 300000 },
      { kind: "created" },
    );
    expect(text).toContain("みなとみらい（請負 ¥300,000）");
  });
});

describe("multicastToUsers — まとめて送信", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("重複を除いて 500 人ずつに分けて送る", async () => {
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "token");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ids = Array.from({ length: 501 }, (_, i) => `U${i}`);
    await multicastToUsers([...ids, "U0"], "本文");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const bodies = calls.map((c) => JSON.parse(String(c[1].body)));
    expect(bodies[0].to).toHaveLength(500);
    expect(bodies[1].to).toEqual(["U500"]);
    expect(calls[0][0]).toContain("/v2/bot/message/multicast");
  });

  it("LINE がエラーを返したら例外（未通知のまま残すため）", async () => {
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("limit", { status: 429 })),
    );
    await expect(multicastToUsers(["U1"], "本文")).rejects.toThrow(/429/);
  });
});

// ============================================================
// auth.ts のガード/判定ロジックの単体テスト（DB非依存の純粋関数のみ）
//   - bootstrapAdminIds : 環境変数のパース
//   - requireApproved   : 未承認/無効化の遮断
//   - requireAdmin      : 非管理者の遮断
//   - adminScope 系      : スコープ管理者の判定
//   - isSuperAdmin      : 👑最高管理者の判定
// ※ resolveUser など DB を引く関数は統合テスト（要DB/モック）で担保する。
// ============================================================

import { describe, it, expect, afterEach, vi } from "vitest";
import type { Organization, User } from "@prisma/client";

// auth.ts は db.js 経由で @prisma/client を読む（ローカルでは engine 未生成）。
// 本テストは DB 非依存の純粋関数のみを対象にするため、db/line をモックして
// import 副作用を切り離す（Vercel 生成環境でも同じテストが通る）。
vi.mock("./db.js", () => ({ prisma: {} }));
vi.mock("./line.js", () => ({ resolveLineUserFromToken: vi.fn() }));
import {
  bootstrapAdminIds,
  requireApproved,
  requireAdmin,
  adminScope,
  adminScopeOrgId,
  isScopedAdmin,
  isSuperAdmin,
  isAdmin,
  bearerToken,
  type ResolvedUser,
} from "./auth.js";

// ── テスト用の最小 User/Org ビルダー ──
function mkUser(): User {
  return {
    id: "u1",
    lineUserId: "U-line",
    displayName: "テスト",
    role: "VIEWER",
    approved: true,
    status: "ACTIVE",
    superAdmin: false,
    orgId: "org1",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as User;
}

function mkOrg(over: Partial<Organization> = {}): Organization {
  return {
    id: "org1",
    name: "自社",
    kind: "SELF",
    active: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as unknown as Organization;
}

function mk(user: Partial<User>, org: Partial<Organization> = {}): ResolvedUser {
  return { user: { ...mkUser(), ...user } as User, org: mkOrg(org) };
}

describe("bootstrapAdminIds", () => {
  const OLD = process.env.ADMIN_LINE_USER_IDS;
  afterEach(() => {
    if (OLD === undefined) delete process.env.ADMIN_LINE_USER_IDS;
    else process.env.ADMIN_LINE_USER_IDS = OLD;
  });

  it("未設定なら空配列", () => {
    delete process.env.ADMIN_LINE_USER_IDS;
    expect(bootstrapAdminIds()).toEqual([]);
  });

  it("カンマ区切りをトリムして配列化・空要素は除去", () => {
    process.env.ADMIN_LINE_USER_IDS = " U1 , U2 ,, U3 ";
    expect(bootstrapAdminIds()).toEqual(["U1", "U2", "U3"]);
  });
});

describe("requireApproved", () => {
  it("未ログイン(null)は UNAUTHENTICATED", () => {
    expect(() => requireApproved(null)).toThrow("UNAUTHENTICATED");
  });
  it("未承認は NOT_APPROVED", () => {
    expect(() => requireApproved(mk({ approved: false }))).toThrow("NOT_APPROVED");
  });
  it("無効化(DISABLED)は承認済みでも DISABLED", () => {
    expect(() =>
      requireApproved(mk({ approved: true, status: "DISABLED" as User["status"] })),
    ).toThrow("DISABLED");
  });
  it("承認済み ACTIVE は通過", () => {
    const u = mk({ approved: true });
    expect(requireApproved(u)).toBe(u);
  });
});

describe("requireAdmin", () => {
  it("承認済みでも非管理者(VIEWER)は FORBIDDEN", () => {
    expect(() => requireAdmin(mk({ role: "VIEWER", approved: true }))).toThrow(
      "FORBIDDEN",
    );
  });
  it("未承認の管理者は NOT_APPROVED（承認が先）", () => {
    expect(() => requireAdmin(mk({ role: "ADMIN", approved: false }))).toThrow(
      "NOT_APPROVED",
    );
  });
  it("承認済み ADMIN は通過", () => {
    const u = mk({ role: "ADMIN", approved: true });
    expect(requireAdmin(u)).toBe(u);
  });
  it("スコープ管理者(SELF_ADMIN)も通過", () => {
    const u = mk({ role: "SELF_ADMIN" as User["role"], approved: true });
    expect(requireAdmin(u)).toBe(u);
  });
});

describe("adminScope / スコープ管理者", () => {
  it("ADMIN は ALL・スコープ orgId は null", () => {
    const u = mk({ role: "ADMIN" });
    expect(adminScope(u)).toBe("ALL");
    expect(adminScopeOrgId(u)).toBeNull();
    expect(isScopedAdmin(u)).toBe(false);
  });
  it("SELF_ADMIN は ORG・スコープ orgId は自組織", () => {
    const u = mk({ role: "SELF_ADMIN" as User["role"] }, { id: "orgSELF" });
    expect(adminScope(u)).toBe("ORG");
    expect(adminScopeOrgId(u)).toBe("orgSELF");
    expect(isScopedAdmin(u)).toBe(true);
  });
  it("ORG_ADMIN は ORG・スコープ orgId は自組織", () => {
    const u = mk({ role: "ORG_ADMIN" as User["role"] }, { id: "orgP" });
    expect(adminScope(u)).toBe("ORG");
    expect(adminScopeOrgId(u)).toBe("orgP");
  });
});

describe("isAdmin", () => {
  it.each([
    ["ADMIN", true],
    ["SELF_ADMIN", true],
    ["ORG_ADMIN", true],
    ["OWNER", false],
    ["VIEWER", false],
    ["PARTNER", false],
  ])("role=%s → isAdmin=%s", (role, expected) => {
    expect(isAdmin(mk({ role: role as User["role"] }))).toBe(expected);
  });
});

describe("isSuperAdmin", () => {
  it("superAdmin=true のみ true", () => {
    expect(isSuperAdmin(mk({ superAdmin: true }))).toBe(true);
    expect(isSuperAdmin(mk({ superAdmin: false }))).toBe(false);
  });
});

describe("bearerToken", () => {
  it("Bearer 形式のみ受理", () => {
    expect(bearerToken("Bearer abc.def")).toBe("abc.def");
    expect(bearerToken("bearer xyz")).toBe("xyz");
  });
  it("生トークン直入れ・null は拒否", () => {
    expect(bearerToken("abc.def")).toBeNull();
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken("Bearer ")).toBeNull();
  });
});

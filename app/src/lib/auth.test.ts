// 初期 ADMIN 付与（ADMIN_LINE_USER_IDS）のパース部分のテスト。
// DB を触らない純関数のみを対象にする。

import { describe, it, expect, afterEach } from "vitest";
import {
  adminBootstrapLineUserIds,
  isBootstrapAdminLineUserId,
} from "./auth.js";

const ORIGINAL = process.env.ADMIN_LINE_USER_IDS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ADMIN_LINE_USER_IDS;
  else process.env.ADMIN_LINE_USER_IDS = ORIGINAL;
});

describe("adminBootstrapLineUserIds", () => {
  it("未設定なら空配列", () => {
    delete process.env.ADMIN_LINE_USER_IDS;
    expect(adminBootstrapLineUserIds()).toEqual([]);
  });

  it("カンマ区切り・前後空白・空要素を正規化する", () => {
    process.env.ADMIN_LINE_USER_IDS = " Uaaa , ,Ubbb ,";
    expect(adminBootstrapLineUserIds()).toEqual(["Uaaa", "Ubbb"]);
  });
});

describe("isBootstrapAdminLineUserId", () => {
  it("列挙された ID は true / それ以外は false", () => {
    process.env.ADMIN_LINE_USER_IDS = "Uaaa,Ubbb";
    expect(isBootstrapAdminLineUserId("Uaaa")).toBe(true);
    expect(isBootstrapAdminLineUserId("Ubbb")).toBe(true);
    expect(isBootstrapAdminLineUserId("Uccc")).toBe(false);
  });

  it("空文字は false（未ログイン等で誤って昇格しない）", () => {
    process.env.ADMIN_LINE_USER_IDS = "Uaaa";
    expect(isBootstrapAdminLineUserId("")).toBe(false);
  });

  it("部分一致では昇格しない（完全一致のみ）", () => {
    process.env.ADMIN_LINE_USER_IDS = "Uaaabbb";
    expect(isBootstrapAdminLineUserId("Uaaa")).toBe(false);
  });
});

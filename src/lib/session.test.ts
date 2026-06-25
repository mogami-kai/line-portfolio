import { describe, it, expect, beforeEach } from "vitest";
import {
  signSession,
  verifySession,
  parseCookie,
  readSession,
  sessionCookieHeader,
  clearSessionCookieHeader,
  SESSION_COOKIE,
} from "./session.js";

// テスト用 SECRET を注入（getSecret は process.env.SESSION_SECRET を読む）。
beforeEach(() => {
  process.env.SESSION_SECRET = "test-secret-please-change-32-chars-min";
});

describe("signSession / verifySession", () => {
  it("署名→検証の往復で payload を復元できる", () => {
    const value = signSession({ lineUserId: "Uabc", role: "ADMIN" });
    const payload = verifySession(value);
    expect(payload).not.toBeNull();
    expect(payload!.lineUserId).toBe("Uabc");
    expect(payload!.role).toBe("ADMIN");
    expect(payload!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("改竄（payload 書き換え）は検証失敗", () => {
    const value = signSession({ lineUserId: "Uabc", role: "ADMIN" });
    const [, sig] = value.split(".");
    // 別の payload に差し替え（署名は元のまま）→ 不一致で null。
    const forgedPayload = Buffer.from(
      JSON.stringify({ lineUserId: "Uhacker", role: "ADMIN", exp: 9999999999 }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(verifySession(`${forgedPayload}.${sig}`)).toBeNull();
  });

  it("署名部の改竄は検証失敗", () => {
    const value = signSession({ lineUserId: "Uabc", role: "ADMIN" });
    const [payloadB64] = value.split(".");
    expect(verifySession(`${payloadB64}.AAAATAMPERED`)).toBeNull();
  });

  it("失効（exp 過去）は null", () => {
    const value = signSession(
      { lineUserId: "Uabc", role: "ADMIN", exp: Math.floor(Date.now() / 1000) - 10 },
      // ttl は exp 指定時は無視される
      9999,
    );
    expect(verifySession(value)).toBeNull();
  });

  it("SECRET が変わると検証失敗（鍵ローテーションで失効）", () => {
    const value = signSession({ lineUserId: "Uabc", role: "ADMIN" });
    process.env.SESSION_SECRET = "totally-different-secret-32-chars-aaa";
    expect(verifySession(value)).toBeNull();
  });

  it("空・不正形式は null", () => {
    expect(verifySession("")).toBeNull();
    expect(verifySession(undefined)).toBeNull();
    expect(verifySession("no-dot-here")).toBeNull();
    expect(verifySession(".onlysig")).toBeNull();
  });
});

describe("parseCookie / readSession", () => {
  it("Cookie ヘッダから対象クッキーを取り出す", () => {
    const value = signSession({ lineUserId: "Uabc", role: "ADMIN" });
    const header = `foo=bar; ${SESSION_COOKIE}=${value}; baz=qux`;
    expect(parseCookie(header, SESSION_COOKIE)).toBe(value);
    const payload = readSession(header);
    expect(payload?.lineUserId).toBe("Uabc");
  });

  it("該当クッキーが無ければ undefined / null", () => {
    expect(parseCookie("a=1; b=2", SESSION_COOKIE)).toBeUndefined();
    expect(readSession("a=1; b=2")).toBeNull();
    expect(readSession(null)).toBeNull();
  });
});

describe("Set-Cookie 文字列", () => {
  it("発行クッキーは HttpOnly / SameSite=Lax / Path=/ を含む", () => {
    const value = signSession({ lineUserId: "Uabc", role: "ADMIN" });
    const sc = sessionCookieHeader(value);
    expect(sc).toContain(`${SESSION_COOKIE}=`);
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Lax");
    expect(sc).toContain("Path=/");
    expect(sc).toContain("Max-Age=");
  });

  it("クリアは Max-Age=0", () => {
    expect(clearSessionCookieHeader()).toContain("Max-Age=0");
  });
});

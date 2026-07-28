// 招待リンク（Invite）の純関数テスト。DB は触らない。

import { describe, it, expect } from "vitest";
import {
  generateInviteToken,
  isValidInviteTokenFormat,
  buildInviteUrl,
  inviteState,
  roleCanEnterAdmin,
} from "./invite.js";

const base = {
  revokedAt: null as Date | null,
  expiresAt: new Date("2026-08-01T00:00:00Z"),
  maxUses: 1,
  usedCount: 0,
};
const now = new Date("2026-07-28T00:00:00Z");

describe("generateInviteToken / isValidInviteTokenFormat", () => {
  it("生成したトークンは形式チェックを通り、毎回異なる", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(isValidInviteTokenFormat(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it("短すぎる/記号入りは弾く（DB へ投げる前の足切り）", () => {
    expect(isValidInviteTokenFormat("")).toBe(false);
    expect(isValidInviteTokenFormat("abc")).toBe(false);
    expect(isValidInviteTokenFormat("a".repeat(20) + "/../x")).toBe(false);
    expect(isValidInviteTokenFormat("a".repeat(200))).toBe(false);
  });
});

describe("buildInviteUrl", () => {
  it("末尾スラッシュを重複させない", () => {
    expect(buildInviteUrl("https://ex.app", "T1")).toBe("https://ex.app/invite/T1");
    expect(buildInviteUrl("https://ex.app/", "T1")).toBe("https://ex.app/invite/T1");
  });
});

describe("inviteState", () => {
  it("有効", () => {
    expect(inviteState(base, now)).toBe("OK");
  });

  it("存在しない", () => {
    expect(inviteState(null, now)).toBe("NOT_FOUND");
  });

  it("無効化済みは期限内でも使えない", () => {
    expect(inviteState({ ...base, revokedAt: new Date() }, now)).toBe("REVOKED");
  });

  it("期限切れ（ちょうど期限時刻も不可）", () => {
    expect(
      inviteState({ ...base, expiresAt: new Date("2026-07-27T23:59:59Z") }, now),
    ).toBe("EXPIRED");
    expect(inviteState({ ...base, expiresAt: now }, now)).toBe("EXPIRED");
  });

  it("使用回数を使い切ったら不可", () => {
    expect(inviteState({ ...base, maxUses: 2, usedCount: 2 }, now)).toBe("USED_UP");
    expect(inviteState({ ...base, maxUses: 2, usedCount: 1 }, now)).toBe("OK");
  });
});

describe("roleCanEnterAdmin", () => {
  it("管理系ロールのみ管理画面に入れる", () => {
    expect(roleCanEnterAdmin("ADMIN")).toBe(true);
    expect(roleCanEnterAdmin("SELF_ADMIN")).toBe(true);
    expect(roleCanEnterAdmin("ORG_ADMIN")).toBe(true);
    expect(roleCanEnterAdmin("OWNER")).toBe(false);
    expect(roleCanEnterAdmin("PARTNER")).toBe(false);
    expect(roleCanEnterAdmin("VIEWER")).toBe(false);
  });
});

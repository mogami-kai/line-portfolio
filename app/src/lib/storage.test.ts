// ============================================================
// storage.ts の純粋ロジックのテスト（ネットワーク/DB非依存）
//   - sniffImageType  : マジックバイト判定（Content-Type 偽装対策の核）
//   - isValidReceiptId: 領収書ID（ReceiptImage.id）の形式検証（注入対策の核）
// ============================================================

import { describe, it, expect } from "vitest";
import { sniffImageType, isValidReceiptId } from "./storage.js";

describe("sniffImageType", () => {
  it("JPEG (FF D8 FF) を判定", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
  });
  it("PNG (89 50 4E 47 0D 0A 1A 0A) を判定", () => {
    expect(
      sniffImageType(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      ),
    ).toBe("png");
  });
  it("画像以外（PDF/テキスト/空）は null", () => {
    expect(sniffImageType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull(); // %PDF
    expect(sniffImageType(new TextEncoder().encode("hello"))).toBeNull();
    expect(sniffImageType(new Uint8Array([]))).toBeNull();
  });
});

describe("isValidReceiptId", () => {
  it("cuid 形式（英数20〜32文字）を受理", () => {
    expect(isValidReceiptId("cmd1a2b3c4d5e6f7g8h9i0j1k")).toBe(true);
    expect(isValidReceiptId("abcdefghij1234567890")).toBe(true);
  });
  it("パス風・記号入り・短すぎ/長すぎは拒否", () => {
    expect(isValidReceiptId("org/2026-07/x.jpg")).toBe(false);
    expect(isValidReceiptId("../etc/passwd")).toBe(false);
    expect(isValidReceiptId("abc'; DROP TABLE --")).toBe(false);
    expect(isValidReceiptId("short")).toBe(false);
    expect(isValidReceiptId("a".repeat(40))).toBe(false);
    expect(isValidReceiptId("")).toBe(false);
    expect(isValidReceiptId("ABCDEFGHIJ1234567890")).toBe(false); // 大文字は不可
  });
});

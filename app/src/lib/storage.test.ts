// ============================================================
// storage.ts の純粋ロジックのテスト（ネットワーク非依存）
//   - sniffImageType    : マジックバイト判定（Content-Type 偽装対策の核）
//   - isValidReceiptPath: 領収書パスの正規形検証（注入対策の核）
// ============================================================

import { describe, it, expect } from "vitest";
import { sniffImageType, isValidReceiptPath } from "./storage.js";

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

describe("isValidReceiptPath", () => {
  const org = "cmabc123xyz";
  const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";

  it("正規形 {orgId}/{yyyy-MM}/{uuid}.jpg|png を受理", () => {
    expect(isValidReceiptPath(`${org}/2026-07/${uuid}.jpg`, org)).toBe(true);
    expect(isValidReceiptPath(`${org}/2026-07/${uuid}.png`, org)).toBe(true);
  });
  it("他組織のパスは拒否", () => {
    expect(isValidReceiptPath(`otherorg/2026-07/${uuid}.jpg`, org)).toBe(false);
  });
  it("トラバーサル・変形は拒否", () => {
    expect(isValidReceiptPath(`../${org}/2026-07/${uuid}.jpg`, org)).toBe(false);
    expect(isValidReceiptPath(`${org}/2026-07/../../x.jpg`, org)).toBe(false);
    expect(isValidReceiptPath(`${org}/2026-07/${uuid}.gif`, org)).toBe(false);
    expect(isValidReceiptPath(`${org}/202607/${uuid}.jpg`, org)).toBe(false);
    expect(isValidReceiptPath("", org)).toBe(false);
  });
});

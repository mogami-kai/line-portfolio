// ============================================================
// 領収書写真の検証ヘルパー
//   画像本体は Postgres（ReceiptImage テーブル）に直接保存する。
//   外部ストレージ・環境変数・バケット設定は不要（設定ゼロで動く）。
//   - sniffImageType   : マジックバイトで JPEG/PNG を判定（Content-Type 偽装対策）
//   - isValidReceiptId : receiptPath（= ReceiptImage.id）の形式検証（注入対策）
// ============================================================

/**
 * マジックバイトで画像種別を判定する。JPEG/PNG のみ許可（HEIC はクライアントで
 * canvas 再エンコードにより JPEG 化される前提）。該当しなければ null。
 */
export function sniffImageType(bytes: Uint8Array): "jpeg" | "png" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  return null;
}

/**
 * receiptPath（= ReceiptImage.id）の形式検証。
 * Prisma cuid（英数25文字前後）のみ受理し、パス風文字列や SQL 断片を遮断する。
 * 所有権（自組織の画像か）は DB 照会（orgId 一致）で別途確認する。
 */
export function isValidReceiptId(id: string): boolean {
  return /^[a-z0-9]{20,32}$/.test(id);
}

// ============================================================
// 2026年6月の立替経費（建て替え集計）をLINE履歴から取り込むワンタイム seed。
//
//   実行: app ディレクトリで（DATABASE_URL を設定して）
//     npx tsx prisma/seed-expenses-202606.ts
//
//   方針:
//     ・LINE出面トークの「パーキング◯◯円 / ガソリン◯◯」記載を抽出。
//     ・5月は経費の記載なし（取り込み対象なし）。
//     ・立替者(paidBy)は、その日の現場が1人だけのとき本人を設定。複数人で
//       実際の支払者が不明な分は null（集計上は「未指定」）。後でフォーム/編集で補える。
//     ・出面(Report)に紐づけず単体の Expense として作成（reportId 無し）。
//     ・二重実行防止: 既に同月・reportId 無しの Expense があれば何もしない。
// ============================================================

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface SeedExpense {
  date: string; // YYYY-MM-DD
  kind: string; // 用途（パーキング / ガソリン）
  amount: number;
  paidBy: string | null; // 立替者。複数人で不明なら null（未指定）
}

// LINE履歴（2026/06）から抽出した立替経費。
const ROWS: SeedExpense[] = [
  { date: "2026-06-02", kind: "パーキング", amount: 2000, paidBy: "齋" }, // 北仲通北地区・齋のみ
  { date: "2026-06-02", kind: "パーキング", amount: 1200, paidBy: "山口" }, // マノー新江古田・山口のみ
  { date: "2026-06-02", kind: "ガソリン", amount: 3000, paidBy: "山口" },
  { date: "2026-06-03", kind: "ガソリン", amount: 4837, paidBy: null }, // さがみ野・後藤/久保
  { date: "2026-06-10", kind: "パーキング", amount: 800, paidBy: null }, // 橋本・後藤/齋/石渡
  { date: "2026-06-11", kind: "パーキング", amount: 800, paidBy: null }, // 橋本・齋/後藤/山口/石渡
  { date: "2026-06-12", kind: "パーキング", amount: 2000, paidBy: null }, // 新大久保・後藤/山口
  { date: "2026-06-12", kind: "パーキング", amount: 800, paidBy: null }, // 橋本・齋/石渡
  { date: "2026-06-13", kind: "パーキング", amount: 800, paidBy: null }, // 橋本・齋/石渡
  { date: "2026-06-13", kind: "パーキング", amount: 500, paidBy: null }, // 横浜キング・後藤/石渡（夜勤）
  { date: "2026-06-16", kind: "パーキング", amount: 2000, paidBy: "石渡" }, // みなとみらい・石渡のみ
  { date: "2026-06-16", kind: "ガソリン", amount: 1000, paidBy: "石渡" },
  { date: "2026-06-17", kind: "パーキング", amount: 500, paidBy: null }, // 町田・齋/山口/石渡
  { date: "2026-06-18", kind: "パーキング", amount: 500, paidBy: null }, // 町田・齋/山口/石渡
  { date: "2026-06-19", kind: "パーキング", amount: 500, paidBy: null }, // 町田・齋/久保/石渡
  { date: "2026-06-22", kind: "パーキング", amount: 1540, paidBy: null }, // 武蔵小杉・齋/石渡/山口
  { date: "2026-06-23", kind: "パーキング", amount: 1500, paidBy: null }, // 武蔵小杉・齋/石渡/山口
  { date: "2026-06-24", kind: "パーキング", amount: 1400, paidBy: null }, // 武蔵小杉・石渡/山口
  { date: "2026-06-26", kind: "パーキング", amount: 1400, paidBy: null }, // 武蔵小杉・石渡/山口
];

async function main() {
  const from = new Date(Date.UTC(2026, 5, 1));
  const to = new Date(Date.UTC(2026, 6, 1));

  const existing = await prisma.expense.count({
    where: { workDate: { gte: from, lt: to }, reportId: null },
  });
  if (existing > 0) {
    console.log(
      `[seed] 6月の単体Expenseが既に ${existing} 件あります。二重取り込み防止のため何もしません。`,
    );
    return;
  }

  const data = ROWS.map((r) => ({
    workDate: new Date(`${r.date}T00:00:00.000Z`),
    kind: r.kind,
    amount: r.amount,
    paidBy: r.paidBy,
    billable: true,
  }));

  const res = await prisma.expense.createMany({ data });
  const total = ROWS.reduce((a, r) => a + r.amount, 0);
  console.log(`[seed] 立替 ${res.count} 件を取り込みました（合計 ¥${total.toLocaleString("ja-JP")}）。`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

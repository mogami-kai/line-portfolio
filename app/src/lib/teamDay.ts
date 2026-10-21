// ============================================================
// みんなの出面（LIFF の「みんな」タブ）— 同じ会社の1日ぶんの出面
//
//   出面の通知をグループ投稿から管理者への個別送信に切り替えたことで、現場の人が
//   「今日の出面がもう入っているか」を見られなくなった（入れ忘れ・後からの入力が増えた）。
//   そこで LIFF から、自分の所属組織の出面を日付ごとに見られるようにする。
//     ・その日に入力された出面（取引先・現場・職人・入力した人・入力時刻・後日入力か）
//     ・その日の出面に名前がない職人（休みなら問題なし。入れ忘れに気づくため）
//
//   ★ 見える範囲は「自分の所属組織」のみ（orgId で絞る）。自社の人に協力会社の出面は
//     出さない／協力会社の人に自社や他社の出面は出さない（2系統の不変条件）。
//     入力した人も同じ組織の人だけ名前を出し、それ以外（全社管理者の代理登録など）は「管理者」。
//   ★ 金額・経費は出さない（入力の確認が目的）。
// ============================================================

import { prisma } from "./db.js";
import { entryLateDays, isLateEntry, loadLateEntryDays } from "./lateEntry.js";

const SHIFT_LABEL = { DAY: "日勤", HALF: "半日", NIGHT: "夜勤" } as const;

export interface TeamDayReport {
  id: string;
  clientName: string;
  siteName: string;
  /** 例: "山田　佐藤（夜勤・残2h）" */
  workers: string;
  /** 職人の人数。 */
  count: number;
  /** 入力した人（同じ組織の人のみ名前。それ以外は「管理者」）。 */
  inputBy: string;
  /** 入力した日時（JST "M/D HH:mm"）。 */
  enteredAt: string;
  /** 後日入力なら遅れ日数。そうでなければ null。 */
  lateDays: number | null;
  /** 管理者の確認待ち（要確認）。 */
  review: boolean;
  /** 削除申請中。 */
  deleteRequested: boolean;
}

export interface TeamDay {
  date: string; // "yyyy-MM-dd"
  reports: TeamDayReport[];
  /** その日の出面に入っている職人の人数（重複なし）。 */
  workerCount: number;
  /** その日の出面に名前がない職人（有効な職人のみ・名前順）。 */
  missing: string[];
}

/** JST の "M/D HH:mm"。 */
function jstStamp(d: Date): string {
  const j = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const hh = String(j.getUTCHours()).padStart(2, "0");
  const mm = String(j.getUTCMinutes()).padStart(2, "0");
  return `${j.getUTCMonth() + 1}/${j.getUTCDate()} ${hh}:${mm}`;
}

/**
 * 自分の所属組織（orgId）の、date（"yyyy-MM-dd"）の出面を返す。
 * 呼び出し側（API）で本人の承認・所属組織の解決を済ませてから呼ぶこと。
 */
export async function loadTeamDay(orgId: string, date: string): Promise<TeamDay> {
  const workDate = new Date(`${date}T00:00:00.000Z`);
  const [rows, workers, lateEntryDays] = await Promise.all([
    prisma.report.findMany({
      where: { orgId, workDate },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        workDate: true,
        createdAt: true,
        createdById: true,
        status: true,
        siteName: true,
        deleteRequestedAt: true,
        client: { select: { name: true } },
        site: { select: { name: true } },
        entries: {
          select: {
            shift: true,
            otHours: true,
            worker: { select: { id: true, name: true } },
          },
        },
      },
    }),
    prisma.worker.findMany({
      where: { orgId, active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    loadLateEntryDays(),
  ]);

  // 入力した人の名前は、同じ組織の人だけ引く（他組織の名前は出さない）。
  const inputterIds = Array.from(new Set(rows.map((r) => r.createdById)));
  const inputters = inputterIds.length
    ? await prisma.user.findMany({
        where: { id: { in: inputterIds }, orgId },
        select: { id: true, displayName: true },
      })
    : [];
  const nameById = new Map(inputters.map((u) => [u.id, u.displayName]));

  const entered = new Set<string>();
  const reports: TeamDayReport[] = rows.map((r) => {
    const tokens = r.entries.map((e) => {
      entered.add(e.worker.id);
      const notes: string[] = [];
      if (e.shift !== "DAY") notes.push(SHIFT_LABEL[e.shift]);
      if (Number(e.otHours) > 0) notes.push(`残${e.otHours}h`);
      return notes.length ? `${e.worker.name}（${notes.join("・")}）` : e.worker.name;
    });
    const late = entryLateDays(r.workDate, r.createdAt);
    return {
      id: r.id,
      clientName: r.client.name,
      siteName: r.siteName?.trim() || r.site?.name || "",
      workers: tokens.join("　"),
      count: r.entries.length,
      inputBy: nameById.get(r.createdById) ?? "管理者",
      enteredAt: jstStamp(r.createdAt),
      lateDays: isLateEntry(late, lateEntryDays) ? late : null,
      review: r.status === "NEEDS_REVIEW",
      deleteRequested: r.deleteRequestedAt !== null,
    };
  });

  return {
    date,
    reports,
    workerCount: entered.size,
    missing: workers.filter((w) => !entered.has(w.id)).map((w) => w.name),
  };
}

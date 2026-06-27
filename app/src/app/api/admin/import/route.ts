// ============================================================
// POST /api/admin/import — LINE トーク履歴の取り込み（バックフィル）
//
//   管理者専用（middleware が /api/admin を保護＋ここでも getAdminContext 確認）。
//   body: { text: string, commit?: boolean }
//     commit=false（既定）… プレビュー。解析のみ。DB 書き込みなし。
//     commit=true         … 取り込み。マスタ find-or-create ＋ Report 作成。
//
//   ・自社（SELF）組織に取り込む（出面グループへは投稿しない＝歴史データ）。
//   ・冪等: clientRequestId="import:日付:取引先:現場:職人…" を @unique キーに使い、
//     再取り込みしても重複作成しない（P2002 は deduped として数える）。
//   ・解析できない行は skipped で返し、人手確認に回す。
// ============================================================

import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { prisma } from "@/lib/db.js";
import { getAdminContext } from "@/lib/auth.js";
import { parseLineHistory, type ParsedReport } from "@/lib/lineImport.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function workerKey(r: ParsedReport): string {
  const names = r.workers.map((w) => w.name).sort().join(",");
  return `import:${r.date}:${r.client}:${r.site ?? "-"}:${names}`;
}

export async function POST(req: Request) {
  const admin = await getAdminContext();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let body: { text?: string; commit?: boolean };
  try {
    body = (await req.json()) as { text?: string; commit?: boolean };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const text = String(body.text ?? "");
  if (!text.trim()) {
    return NextResponse.json({ ok: false, error: "empty_text" }, { status: 400 });
  }

  // 解析（年補完の基準日は今日）。
  const { reports, skipped } = parseLineHistory(text);

  // 集計プレビュー（職人別 人工/残業）。
  const wmap = new Map<string, { manDays: number; otHours: number }>();
  let totalManDays = 0;
  let totalOtHours = 0;
  const dates: string[] = [];
  for (const r of reports) {
    dates.push(r.date);
    for (const w of r.workers) {
      const cur = wmap.get(w.name) ?? { manDays: 0, otHours: 0 };
      cur.manDays += w.manDays;
      cur.otHours += w.otHours;
      wmap.set(w.name, cur);
      totalManDays += w.manDays;
      totalOtHours += w.otHours;
    }
  }
  const workerTotals = Array.from(wmap.entries())
    .map(([name, v]) => ({ name, manDays: v.manDays, otHours: v.otHours }))
    .sort((a, b) => b.manDays - a.manDays);
  dates.sort();
  const dateRange = dates.length
    ? { from: dates[0], to: dates[dates.length - 1] }
    : null;
  const clientsSet = new Set(reports.map((r) => r.client));
  const sitesSet = new Set(reports.map((r) => `${r.client}/${r.site ?? "-"}`));
  const workersSet = new Set(workerTotals.map((w) => w.name));

  const preview = {
    ok: true as const,
    reportCount: reports.length,
    totalManDays,
    totalOtHours,
    workerTotals,
    clients: Array.from(clientsSet).sort(),
    siteCount: sitesSet.size,
    workers: Array.from(workersSet).sort(),
    skipped: skipped.slice(0, 50),
    skippedCount: skipped.length,
    dateRange,
  };

  if (!body.commit) {
    return NextResponse.json({ ...preview, committed: false });
  }

  // ── commit: マスタ find-or-create ＋ Report 作成 ──
  // 自社（SELF）組織。無ければ作成。
  let selfOrg = await prisma.organization.findFirst({ where: { kind: "SELF" } });
  if (!selfOrg) {
    selfOrg = await prisma.organization.create({
      data: { name: "自社", kind: "SELF" },
    });
  }

  const clientCache = new Map<string, string>(); // name → id
  const siteCache = new Map<string, string>(); // clientId|name → id
  const workerCache = new Map<string, string>(); // name → id

  async function ensureClient(name: string): Promise<string> {
    const hit = clientCache.get(name);
    if (hit) return hit;
    const existing = await prisma.client.findFirst({ where: { name } });
    const id =
      existing?.id ??
      (await prisma.client.create({ data: { name } })).id;
    clientCache.set(name, id);
    return id;
  }
  async function ensureSite(clientId: string, name: string): Promise<string> {
    const key = `${clientId}|${name}`;
    const hit = siteCache.get(key);
    if (hit) return hit;
    const existing = await prisma.site.findFirst({ where: { clientId, name } });
    const id =
      existing?.id ??
      (await prisma.site.create({ data: { clientId, name } })).id;
    siteCache.set(key, id);
    return id;
  }
  async function ensureWorker(name: string): Promise<string> {
    const hit = workerCache.get(name);
    if (hit) return hit;
    const existing = await prisma.worker.findFirst({
      where: { name, orgId: selfOrg!.id },
    });
    const id =
      existing?.id ??
      (await prisma.worker.create({ data: { name, orgId: selfOrg!.id } })).id;
    workerCache.set(name, id);
    return id;
  }

  let imported = 0;
  let deduped = 0;
  const failures: string[] = [];

  for (const r of reports) {
    try {
      const clientId = await ensureClient(r.client);
      const siteId = r.site ? await ensureSite(clientId, r.site) : null;
      const entries: Array<{
        workerId: string;
        shift: "DAY" | "HALF" | "NIGHT";
        manDays: number;
        otHours: number;
      }> = [];
      for (const w of r.workers) {
        const workerId = await ensureWorker(w.name);
        entries.push({
          workerId,
          shift: w.shift,
          manDays: w.manDays,
          otHours: w.otHours,
        });
      }
      const dayStart = new Date(`${r.date}T00:00:00.000Z`);
      await prisma.report.create({
        data: {
          workDate: dayStart,
          clientId,
          siteId,
          contractType: r.contractType,
          source: "SELF",
          orgId: selfOrg.id,
          createdById: admin.user.id,
          status: "CONFIRMED",
          postedToGroup: false, // 歴史データ。グループへは投稿しない。
          clientRequestId: workerKey(r),
          entries: { create: entries },
          expenses: r.expenses.length
            ? {
                create: r.expenses.map((x) => ({
                  workDate: dayStart,
                  clientId,
                  siteId,
                  kind: x.kind,
                  amount: x.amount,
                  billable: true,
                })),
              }
            : undefined,
        },
      });
      imported++;
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") {
        deduped++; // 同一キーが既存 ＝ 取り込み済み。
      } else {
        failures.push(`${r.date} ${r.client}/${r.site ?? "-"}`);
      }
    }
  }

  revalidateTag("reports");

  return NextResponse.json({
    ...preview,
    committed: true,
    imported,
    deduped,
    failures: failures.slice(0, 20),
    failureCount: failures.length,
  });
}

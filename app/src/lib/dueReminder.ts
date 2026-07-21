// ============================================================
// 入金確認リマインド（LINE DM）
//   支払期限(dueDate)＝今日 の請求書を、設定時刻に指定管理者へ bot から通知する。
//   ・スケジューラ（GitHub Actions）が毎時 /api/cron/due-reminders を叩く。
//   ・「設定時刻を過ぎていて、今日まだ送っていなければ送る」方式＝実行遅延/スキップに強い。
//   ・二重送信は InvoiceSetting.dueReminderLastSentOn（JSTの日付）で防止。
//   ・宛先は指定管理者(User)。未指定なら最高管理者(superAdmin)へフォールバック。
// ============================================================

import { prisma } from "./db.js";
import { pushToUser } from "./line.js";
import { jstTodayDate, jstHour } from "./invoiceDates.js";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const yen = (n: number) => "¥" + Math.round(n).toLocaleString("ja-JP");

/**
 * 送信すべきか（純粋関数・テスト可能）。
 *   ・無効 → false / 設定時刻より前 → false / 今日は送信済み → false。
 *   ・設定時刻以降で未送信 → true。
 */
export function shouldRunReminder(args: {
  enabled: boolean;
  reminderHour: number;
  nowHour: number;
  lastSentOnIso: string | null;
  todayIso: string;
}): boolean {
  if (!args.enabled) return false;
  if (args.nowHour < args.reminderHour) return false;
  if (args.lastSentOnIso === args.todayIso) return false;
  return true;
}

/** 今日が支払期限の請求書1件（通知文面用）。 */
interface DueInvoice {
  clientName: string;
  honorific: string;
  total: number;
}

/** "7/31" 形式（JST）。 */
function mdLabel(d: Date): string {
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** 通知の本文を組み立てる。 */
export function buildReminderMessage(today: Date, dues: DueInvoice[]): string {
  const head = `【入金確認リマインド ${mdLabel(today)}】本日が入金予定日`;
  const lines = dues.map((d) => `・${d.clientName} ${d.honorific} ${yen(d.total)}`);
  const sum = dues.reduce((a, d) => a + d.total, 0);
  return [head, ...lines, `合計 ${yen(sum)}`, "入金をご確認ください。"].join("\n");
}

export type ReminderResult =
  | { sent: false; reason: "disabled" | "too_early" | "already_sent" | "no_due" | "no_recipient" }
  | { sent: true; count: number; total: number; toLen: number };

/**
 * リマインド本処理。cron エンドポイントから呼ぶ。now は差し替え可能（テスト用）。
 */
export async function runDueReminder(now: Date = new Date()): Promise<ReminderResult> {
  const setting = await prisma.invoiceSetting.findFirst();
  const today = jstTodayDate(now);
  const todayIso = iso(today);

  const go = shouldRunReminder({
    enabled: setting?.dueReminderEnabled ?? false,
    reminderHour: setting?.dueReminderHour ?? 9,
    nowHour: jstHour(now),
    lastSentOnIso: setting?.dueReminderLastSentOn
      ? iso(setting.dueReminderLastSentOn)
      : null,
    todayIso,
  });
  if (!go) {
    if (!setting?.dueReminderEnabled) return { sent: false, reason: "disabled" };
    if (setting.dueReminderLastSentOn && iso(setting.dueReminderLastSentOn) === todayIso) {
      return { sent: false, reason: "already_sent" };
    }
    return { sent: false, reason: "too_early" };
  }

  // 今日が支払期限の請求書を集計（税込合計＝明細金額の総和）。
  const invoices = await prisma.invoice.findMany({
    where: { dueDate: today },
    select: {
      client: { select: { name: true, honorific: true } },
      lines: { select: { amount: true } },
    },
    orderBy: { invoiceNo: "asc" },
  });
  const dues: DueInvoice[] = invoices.map((iv) => ({
    clientName: iv.client.name,
    honorific: iv.client.honorific ?? "様",
    total: iv.lines.reduce((a, l) => a + l.amount, 0),
  }));

  // 設定時刻は過ぎたので、対象ゼロでも今日は「処理済み」にする（毎時の再クエリを止める）。
  const markSent = () =>
    setting &&
    prisma.invoiceSetting.update({
      where: { id: setting.id },
      data: { dueReminderLastSentOn: today },
    });

  if (dues.length === 0) {
    await markSent();
    return { sent: false, reason: "no_due" };
  }

  // 宛先の管理者を解決（指定 → なければ最高管理者）。
  const recipient = await resolveRecipient(setting!.dueReminderUserId);
  if (!recipient) {
    // 宛先が居ない＝送れない。lastSentOn は更新せず、設定を直せば次回送れるようにする。
    return { sent: false, reason: "no_recipient" };
  }

  const text = buildReminderMessage(today, dues);
  await pushToUser(recipient, text);
  await markSent();
  const total = dues.reduce((a, d) => a + d.total, 0);
  return { sent: true, count: dues.length, total, toLen: recipient.length };
}

/** 通知先の LINE userId を解決。指定 User → 無ければ最高管理者(superAdmin)。 */
async function resolveRecipient(userId: string | null): Promise<string | null> {
  if (userId) {
    const u = await prisma.user.findFirst({
      where: { id: userId, status: "ACTIVE" },
      select: { lineUserId: true },
    });
    if (u?.lineUserId) return u.lineUserId;
  }
  const owner = await prisma.user.findFirst({
    where: { superAdmin: true, status: "ACTIVE" },
    select: { lineUserId: true },
  });
  return owner?.lineUserId ?? null;
}

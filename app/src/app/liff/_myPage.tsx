"use client";

// ============================================================
// /liff マイページ（下タブの2枚目）
//   上: 今月の自分の合計（件数 / 人工 / 残業h）
//   下: 自分が提出した出面の一覧（月ごとに小計付きでずらっと・新しい順）
//   各行から「削除申請」を送れる（管理者が承認すると削除が確定し、
//   LINE グループへも取消の訂正投稿が流れる）。申請の取り下げも可能。
//   データは GET /api/reports/mine（Bearer = LIFF アクセストークン）。
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";

interface MineReport {
  id: string;
  workDate: string; // "yyyy-MM-dd"
  clientName: string;
  siteName: string;
  status: "CONFIRMED" | "NEEDS_REVIEW";
  postedToGroup: boolean;
  deleteRequested: boolean;
  manDays: number;
  nightManDays: number;
  otHours: number;
  workers: string;
  expensesLabel: string;
}

interface MineResponse {
  ok: boolean;
  reports?: MineReport[];
  error?: string;
  message?: string;
}

const WEEKDAY_JP = ["日", "月", "火", "水", "木", "金", "土"] as const;
/** "yyyy-MM-dd"（UTC 0時の出面日）→ "M/D(曜)"。TZズレ防止に UTC で読む。 */
function mdW(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAY_JP[d.getUTCDay()]})`;
}

/** 人工の表示（小数の揺れを整える。例 1 → "1" / 0.5 → "0.5"）。 */
function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

interface MonthGroup {
  ym: string; // "yyyy-MM"
  label: string; // "7月"
  count: number;
  manDays: number;
  nightManDays: number;
  otHours: number;
  reports: MineReport[];
}

export function MyPage({ token }: { token: string }) {
  const [reports, setReports] = useState<MineReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/reports/mine", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as MineResponse;
      if (!res.ok || !data.ok || !data.reports) {
        setError(data.message || data.error || "一覧の取得に失敗しました。");
        return;
      }
      setReports(data.reports);
    } catch {
      setError("通信エラー。電波の良い場所でもう一度お試しください。");
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // 削除申請 / 取り下げ。成功したら該当行のフラグだけ更新（再取得しない）。
  const toggleRequest = useCallback(
    async (r: MineReport) => {
      const withdraw = r.deleteRequested;
      if (
        !withdraw &&
        !window.confirm(
          `${mdW(r.workDate)} ${r.clientName} の出面の削除を申請します。\n管理者が承認すると削除が確定し、LINEグループにも取消が流れます。よろしいですか？`,
        )
      ) {
        return;
      }
      setBusyId(r.id);
      try {
        const res = await fetch(`/api/reports/${r.id}/delete-request`, {
          method: withdraw ? "DELETE" : "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await res.json()) as {
          ok: boolean;
          message?: string;
          error?: string;
        };
        if (!res.ok || !data.ok) {
          window.alert(data.message || data.error || "送信に失敗しました。");
          return;
        }
        setReports(
          (prev) =>
            prev?.map((x) =>
              x.id === r.id ? { ...x, deleteRequested: !withdraw } : x,
            ) ?? prev,
        );
      } catch {
        window.alert("通信エラー。電波の良い場所でもう一度お試しください。");
      } finally {
        setBusyId(null);
      }
    },
    [token],
  );

  // 月ごとにグループ化（reports は新しい順で届く）。
  const groups = useMemo<MonthGroup[]>(() => {
    const out: MonthGroup[] = [];
    for (const r of reports ?? []) {
      const ym = r.workDate.slice(0, 7);
      let g = out[out.length - 1];
      if (!g || g.ym !== ym) {
        g = {
          ym,
          label: `${Number(ym.slice(5, 7))}月`,
          count: 0,
          manDays: 0,
          nightManDays: 0,
          otHours: 0,
          reports: [],
        };
        out.push(g);
      }
      g.count += 1;
      g.manDays += r.manDays;
      g.nightManDays += r.nightManDays;
      g.otHours += r.otHours;
      g.reports.push(r);
    }
    return out;
  }, [reports]);

  // 今月（端末ローカル）の合計。まだ0件でも0で出す。
  const nowYm = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  })();
  const current = groups.find((g) => g.ym === nowYm);
  const nowLabel = `${Number(nowYm.slice(5, 7))}月`;

  if (error) {
    return (
      <>
        <div className="notice notice--error">{error}</div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={load}>
          再読み込み
        </button>
      </>
    );
  }
  if (reports === null) {
    return (
      <div aria-hidden>
        <div className="card" style={{ marginTop: 14 }}>
          <div className="skeleton-line skeleton-line--head" />
          <div className="skeleton-box" style={{ minHeight: 64, borderRadius: 10 }} />
        </div>
        <div className="card">
          <div className="skeleton-line" />
          <div className="skeleton-box" style={{ minHeight: 48, borderRadius: 10 }} />
          <div className="skeleton-box" style={{ minHeight: 48, borderRadius: 10, marginTop: 8 }} />
        </div>
      </div>
    );
  }

  return (
    <>
      {/* 今月の合計 */}
      <div className="card" style={{ marginTop: 14 }}>
        <div className="field" style={{ marginBottom: 8 }}>
          <label className="label">{nowLabel}の自分の出面（合計）</label>
        </div>
        <div className="mp-stats">
          <div className="mp-stat">
            <b>{fmtNum(current?.manDays ?? 0)}</b>
            <span>人工</span>
          </div>
          <div className="mp-stat">
            <b>{fmtNum(current?.nightManDays ?? 0)}</b>
            <span>夜勤</span>
          </div>
          <div className="mp-stat">
            <b>{fmtNum(current?.otHours ?? 0)}</b>
            <span>残業h</span>
          </div>
        </div>
      </div>

      {/* 一覧（月ごと・新しい順） */}
      {reports.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            まだ出面がありません。「入力」タブから送信できます。
          </p>
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.ym}>
            <div className="mp-month-head">
              <span>{g.label}</span>
              <span className="mp-month-sub">
                {fmtNum(g.manDays)}人工
                {g.nightManDays > 0 ? `・夜勤${fmtNum(g.nightManDays)}` : ""}
                {g.otHours > 0 ? `・残${fmtNum(g.otHours)}h` : ""}
              </span>
            </div>
            {g.reports.map((r) => (
              <div className="mp-row" key={r.id}>
                <div className="mp-row-head">
                  <span className="mp-date">
                    {mdW(r.workDate)} {r.clientName}
                  </span>
                  <span className="mp-md">{fmtNum(r.manDays)}人工</span>
                </div>
                <div className="mp-meta">
                  {r.siteName || "(現場未設定)"}
                  {r.otHours > 0 ? `・残業${fmtNum(r.otHours)}h` : ""}
                  {r.expensesLabel ? `・${r.expensesLabel}` : ""}
                </div>
                {r.workers && <div className="mp-names">{r.workers}</div>}
                <div className="mp-actions">
                  {r.status === "NEEDS_REVIEW" && (
                    <span className="badge badge--review">確認待ち</span>
                  )}
                  {r.deleteRequested ? (
                    <>
                      <span className="badge badge--review">削除申請中</span>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={busyId === r.id}
                        onClick={() => toggleRequest(r)}
                      >
                        {busyId === r.id ? "送信中…" : "取り下げ"}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--danger-text btn--sm"
                      disabled={busyId === r.id}
                      onClick={() => toggleRequest(r)}
                    >
                      {busyId === r.id ? "送信中…" : "削除申請"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))
      )}

      <p className="hint" style={{ marginTop: 12 }}>
        間違えたら「削除申請」→ 管理者の承認で削除されます。
      </p>
    </>
  );
}

"use client";

// ============================================================
// /liff みんなの出面（下タブの2枚目）
//   同じ会社の人が入力した出面を日付ごとに見る（グループ投稿をやめて見えなくなった分の代わり）。
//     上: 日付の切り替え（◀ ▶・既定は今日）
//     中: その日の出面に名前がない人（入れ忘れに気づくため。休みなら問題なし）
//     下: その日の出面（取引先・現場・職人・入力した人と時刻・後日入力/確認待ち/削除申請中）
//   見える範囲は自分の所属組織のみ（サーバ側で絞る）。データは GET /api/reports/team。
// ============================================================

import { useCallback, useEffect, useState } from "react";

interface TeamReport {
  id: string;
  clientName: string;
  siteName: string;
  workers: string;
  count: number;
  inputBy: string;
  enteredAt: string;
  lateDays: number | null;
  review: boolean;
  deleteRequested: boolean;
}

interface TeamResponse {
  ok: boolean;
  date?: string;
  reports?: TeamReport[];
  workerCount?: number;
  missing?: string[];
  error?: string;
  message?: string;
}

const WEEKDAY_JP = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 端末ローカルの今日 "yyyy-MM-dd"（入力フォームの既定日付と同じ流儀）。 */
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** "yyyy-MM-dd" を days 日ずらす（UTC で計算＝TZズレなし）。 */
function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "yyyy-MM-dd" → "M/D(曜)"。 */
function mdW(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAY_JP[d.getUTCDay()]})`;
}

export function TeamPage({ token }: { token: string }) {
  const today = todayISO();
  const [date, setDate] = useState<string>(today);
  const [data, setData] = useState<TeamResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (d: string) => {
      setError(null);
      setData(null);
      try {
        const res = await fetch(`/api/reports/team?date=${d}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = (await res.json()) as TeamResponse;
        if (!res.ok || !json.ok) {
          setError(json.message || json.error || "出面の取得に失敗しました。");
          return;
        }
        setData(json);
      } catch {
        setError("通信エラー。電波の良い場所でもう一度お試しください。");
      }
    },
    [token],
  );

  useEffect(() => {
    void load(date);
  }, [load, date]);

  const isToday = date === today;
  const isYesterday = date === shiftDate(today, -1);
  const reports = data?.reports ?? [];
  const missing = data?.missing ?? [];

  return (
    <>
      {/* 日付の切り替え（未来には進めない） */}
      <div className="month-switch team-date" style={{ marginTop: 14 }}>
        <button
          type="button"
          className="month-nav"
          aria-label="前の日"
          onClick={() => setDate((d) => shiftDate(d, -1))}
        >
          ◀
        </button>
        <span className="team-date-label">
          {mdW(date)}
          {isToday && <span className="ym-now">今日</span>}
          {isYesterday && <span className="ym-now">昨日</span>}
        </span>
        <button
          type="button"
          className="month-nav"
          aria-label="次の日"
          disabled={isToday}
          onClick={() => setDate((d) => shiftDate(d, 1))}
        >
          ▶
        </button>
      </div>

      {error ? (
        <>
          <div className="notice notice--error">{error}</div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => load(date)}
          >
            再読み込み
          </button>
        </>
      ) : !data ? (
        <div aria-hidden>
          <div className="card">
            <div className="skeleton-line" />
            <div className="skeleton-box" style={{ minHeight: 48, borderRadius: 10 }} />
            <div className="skeleton-box" style={{ minHeight: 48, borderRadius: 10, marginTop: 8 }} />
          </div>
        </div>
      ) : (
        <>
          <p className="team-count">
            {reports.length}件・{data.workerCount ?? 0}人が入力済み
          </p>

          {/* 名前がない人（入れ忘れに気づくため） */}
          {missing.length > 0 && (
            <div className="card team-missing">
              <div className="label" style={{ marginBottom: 6 }}>
                この日の出面に名前がない人
              </div>
              <div className="team-chips">
                {missing.map((n) => (
                  <span key={n} className="team-chip">
                    {n}
                  </span>
                ))}
              </div>
              <p className="hint" style={{ marginBottom: 0 }}>
                休みなら問題ありません。働いたのに入っていなければ、今日のうちに入力してください。
              </p>
            </div>
          )}

          {/* その日の出面 */}
          {reports.length === 0 ? (
            <div className="card">
              <p className="muted" style={{ margin: 0 }}>
                この日の出面はまだありません。
              </p>
            </div>
          ) : (
            reports.map((r) => (
              <div className="mp-row" key={r.id}>
                <div className="mp-row-head">
                  <span className="mp-date">{r.clientName}</span>
                  <span className="mp-md">{r.count}名</span>
                </div>
                <div className="mp-meta">{r.siteName || "(現場未設定)"}</div>
                {r.workers && <div className="mp-names">{r.workers}</div>}
                <div className="team-foot">
                  <span className="team-by">
                    入力: {r.inputBy}・{r.enteredAt}
                  </span>
                  {r.lateDays != null && (
                    <span className="badge badge--late">後日入力 +{r.lateDays}日</span>
                  )}
                  {r.review && <span className="badge badge--review">確認待ち</span>}
                  {r.deleteRequested && (
                    <span className="badge badge--review">削除申請中</span>
                  )}
                </div>
              </div>
            ))
          )}

          <p className="hint" style={{ marginTop: 12 }}>
            同じ会社の人が入力した出面です。入っていない日・人は、その日のうちに入力してください。
            何日もあとからの入力は、管理者の確認待ちになります。
          </p>
        </>
      )}
    </>
  );
}

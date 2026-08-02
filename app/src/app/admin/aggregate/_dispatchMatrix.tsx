// ============================================================
// 月間出勤マトリクス（表示専用・Server Component）
//   縦=職人・横=日付（1〜末日）。集計・整形はすべて呼び出し側
//   （page.tsx → @/lib/aggregate）で完了させ、ここでは受け取った
//   文字列・数値をそのまま並べるだけ（JSX内で集計処理をしない）。
// ============================================================

export interface DispatchMatrixRow {
  key: string; // React key（workerId優先。無ければ name+index で一意化）
  workerName: string;
  /** 表示済みセル文字列。length = daysInMonth。 */
  cells: string[];
  totals: {
    manDays: number;
    dayManDays: number;
    nightManDays: number;
    halfManDays: number;
    otHours: number;
  };
}

/** 人工・残業の小数表示（0.5を1へ丸めない。誤差だけ丸める）。 */
function fmtNum(n: number): string {
  return String(Math.round(n * 100) / 100);
}

export function DispatchMatrixTable({
  rows,
  daysInMonth,
  weekdays,
  todayDay,
}: {
  rows: DispatchMatrixRow[];
  daysInMonth: number;
  /** weekdays[i] = i+1日の曜日（0=日〜6=土）。 */
  weekdays: number[];
  /** 選択月が当月（JST）の場合のみ日番号。それ以外は null。 */
  todayDay: number | null;
}) {
  if (rows.length === 0) {
    return <p className="muted">この月の確定済み出面はありません。</p>;
  }

  const dayNumbers = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  return (
    <div>
      <p className="dm-hint">← 横にスワイプして日付を確認 →</p>
      <div className="dm-scroll">
        <table className="dm-table">
          <thead>
            <tr>
              <th className="dm-th-name">氏名</th>
              {dayNumbers.map((d) => (
                <th
                  key={d}
                  className={[
                    "dm-th-day",
                    weekdays[d - 1] === 0 ? "dm-sun" : "",
                    weekdays[d - 1] === 6 ? "dm-sat" : "",
                    d === todayDay ? "dm-today" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {d}
                </th>
              ))}
              <th className="dm-th-total dm-total-divider">人工</th>
              <th className="dm-th-total">日勤</th>
              <th className="dm-th-total">夜勤</th>
              <th className="dm-th-total">半日</th>
              <th className="dm-th-total">残業</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="dm-td-name">{r.workerName}</td>
                {r.cells.map((c, i) => (
                  <td
                    key={`${r.key}-${i + 1}`}
                    className={[
                      "dm-td-day",
                      weekdays[i] === 0 ? "dm-sun" : "",
                      weekdays[i] === 6 ? "dm-sat" : "",
                      i + 1 === todayDay ? "dm-today" : "",
                      c === "－" ? "dm-empty" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {c}
                  </td>
                ))}
                <td className="dm-td-total dm-total-divider">
                  {fmtNum(r.totals.manDays)}
                </td>
                <td className="dm-td-total">{fmtNum(r.totals.dayManDays)}</td>
                <td className="dm-td-total">{fmtNum(r.totals.nightManDays)}</td>
                <td className="dm-td-total">{fmtNum(r.totals.halfManDays)}</td>
                <td className="dm-td-total">{fmtNum(r.totals.otHours)}h</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

"use client";

// ============================================================
// 月間出勤マトリクス（/admin/aggregate 上部）
//   縦=職人・横=日付（1〜末日）。マス目をタップするとその日その職人の出面を
//   その場で編集できる（管理ホームと同じ編集モーダルを再利用）。
//   保存・削除すると router.refresh() が走り、表と下の集計が同時に最新化される
//   ＝出面データと常に同期する。
//
//   集計・整形は呼び出し側（page.tsx → @/lib/aggregate）で完了させ、ここでは
//   受け取った値を並べるだけ（JSX内で集計処理をしない）。
// ============================================================

import { useState } from "react";
import { EditModal } from "../_editReport.js";

/** セルから開く出面への参照（サーバ側 DispatchEntryRef と同形）。 */
export interface DispatchCellRef {
  reportId: string;
  clientName: string;
  siteName: string;
  /** "日" / "夜" / "半"。 */
  shiftLabel: string;
  otHours: number;
}

export interface DispatchMatrixCell {
  /** 表示文字列（"－" / "日" / "日×2" / "日+夜" 等）。 */
  text: string;
  /** その日その職人の残業合計（0なら残業なし）。 */
  otHours: number;
  /** タップで開く出面（0件ならタップ不可）。 */
  refs: DispatchCellRef[];
}

export interface DispatchMatrixRow {
  key: string; // React key（workerId優先。無ければ index で一意化）
  workerName: string;
  /** length = daysInMonth。 */
  cells: DispatchMatrixCell[];
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

/** 現場名（未設定なら取引先名）。セルのツールチップ・選択リストに使う。 */
function refLabel(r: DispatchCellRef): string {
  return r.siteName || r.clientName;
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
  // 編集モーダルで開いている出面。null なら閉じている。
  const [openReportId, setOpenReportId] = useState<string | null>(null);
  // 同日に複数出面があるマス目の選択（どれを開くか）。
  const [picker, setPicker] = useState<{
    title: string;
    refs: DispatchCellRef[];
  } | null>(null);

  if (rows.length === 0) {
    return <p className="muted">この月の確定済み出面はありません。</p>;
  }

  const dayNumbers = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  /** マス目タップ: 1件なら即編集、複数件ならどれを開くか選ばせる。 */
  const onCellClick = (
    row: DispatchMatrixRow,
    day: number,
    cell: DispatchMatrixCell,
  ) => {
    if (cell.refs.length === 0) return;
    if (cell.refs.length === 1) {
      setOpenReportId(cell.refs[0].reportId);
      return;
    }
    setPicker({ title: `${row.workerName}　${day}日の出面`, refs: cell.refs });
  };

  return (
    <div>
      <p className="dm-hint">
        マス目をタップすると出面を編集できます（← 横スワイプで日付移動 →）
      </p>
      <div
        className="dm-scroll"
        tabIndex={0}
        role="region"
        aria-label="月間出勤マトリクス"
      >
        <table className="dm-table">
          <thead>
            <tr>
              <th scope="col" className="dm-th-name">
                氏名
              </th>
              {dayNumbers.map((d) => (
                <th
                  scope="col"
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
              <th scope="col" className="dm-th-total dm-total-divider">
                人工
              </th>
              <th scope="col" className="dm-th-total">
                日勤
              </th>
              <th scope="col" className="dm-th-total">
                夜勤
              </th>
              <th scope="col" className="dm-th-total">
                半日
              </th>
              <th scope="col" className="dm-th-total">
                残業
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row" className="dm-td-name">
                  {r.workerName}
                </th>
                {r.cells.map((c, i) => {
                  const day = i + 1;
                  const clickable = c.refs.length > 0;
                  // 残業がどの現場で出たかをツールチップに出す（PCのホバー用）。
                  const title = clickable
                    ? c.refs
                        .map(
                          (ref) =>
                            `${refLabel(ref)}（${ref.shiftLabel}${
                              ref.otHours > 0
                                ? `・残${fmtNum(ref.otHours)}h`
                                : ""
                            }）`,
                        )
                        .join(" / ")
                    : undefined;
                  return (
                    <td
                      key={`${r.key}-${day}`}
                      className={[
                        "dm-td-day",
                        weekdays[i] === 0 ? "dm-sun" : "",
                        weekdays[i] === 6 ? "dm-sat" : "",
                        day === todayDay ? "dm-today" : "",
                        clickable ? "" : "dm-empty",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      title={title}
                    >
                      {clickable ? (
                        <button
                          type="button"
                          className="dm-cell-btn"
                          onClick={() => onCellClick(r, day, c)}
                          aria-label={`${r.workerName} ${day}日の出面を編集`}
                        >
                          <span className="dm-cell-shift">{c.text}</span>
                          {c.otHours > 0 && (
                            <span className="dm-cell-ot">
                              残{fmtNum(c.otHours)}
                            </span>
                          )}
                        </button>
                      ) : (
                        c.text
                      )}
                    </td>
                  );
                })}
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

      {/* 残業の内訳（誰が・何日に・どの現場で）。残業ゼロの月は表示しない。 */}
      <OvertimeBreakdown rows={rows} onPick={setOpenReportId} />

      {/* 同日に複数出面があるマス目 → どれを開くか選ぶ */}
      {picker && (
        <div className="dm-picker-overlay">
          <button
            type="button"
            className="dm-picker-scrim"
            aria-label="閉じる"
            onClick={() => setPicker(null)}
          />
          <div className="dm-picker" role="dialog" aria-label={picker.title}>
            <div className="dm-picker-head">{picker.title}</div>
            <div className="dm-picker-list">
              {picker.refs.map((ref, i) => (
                <button
                  key={`${ref.reportId}-${i}`}
                  type="button"
                  className="dm-picker-item"
                  onClick={() => {
                    setPicker(null);
                    setOpenReportId(ref.reportId);
                  }}
                >
                  <span className="dm-picker-site">{refLabel(ref)}</span>
                  <span className="dm-picker-meta">
                    {ref.shiftLabel}
                    {ref.otHours > 0 && `・残${fmtNum(ref.otHours)}h`}
                  </span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setPicker(null)}
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* 出面の編集モーダル（管理ホームと同一。保存/削除で router.refresh()） */}
      {openReportId && (
        <EditModal
          reportId={openReportId}
          onClose={() => setOpenReportId(null)}
        />
      )}
    </div>
  );
}

/**
 * 残業の内訳。「誰が・何日に・どの現場で・何時間」を一覧にする。
 * マス目にも「残N」を出しているが、残業だけを拾って確認したいとき用。
 */
function OvertimeBreakdown({
  rows,
  onPick,
}: {
  rows: DispatchMatrixRow[];
  onPick: (reportId: string) => void;
}) {
  // 表示用に平坦化（新たな集計はしない。refs が持つ値を拾うだけ）。
  const items: {
    key: string;
    workerName: string;
    day: number;
    site: string;
    otHours: number;
    reportId: string;
  }[] = [];
  for (const r of rows) {
    r.cells.forEach((c, i) => {
      for (const ref of c.refs) {
        if (ref.otHours > 0) {
          items.push({
            key: `${r.key}-${i + 1}-${ref.reportId}`,
            workerName: r.workerName,
            day: i + 1,
            site: refLabel(ref),
            otHours: ref.otHours,
            reportId: ref.reportId,
          });
        }
      }
    });
  }

  if (items.length === 0) return null;

  const total = items.reduce((a, x) => a + x.otHours, 0);
  // 日付順（同日は職人名順）で読みやすく並べる。
  items.sort(
    (a, b) =>
      a.day - b.day || a.workerName.localeCompare(b.workerName, "ja"),
  );

  return (
    <details className="dm-ot">
      <summary>
        残業の内訳
        <span className="dm-ot-total">
          {items.length}件・計{fmtNum(total)}h
        </span>
      </summary>
      <table className="worker-table dm-ot-table">
        <thead>
          <tr>
            <th>職人</th>
            <th className="num">日</th>
            <th>現場</th>
            <th className="num">残業</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((x) => (
            <tr key={x.key}>
              <td className="wt-name">{x.workerName}</td>
              <td className="num">{x.day}日</td>
              <td>{x.site}</td>
              <td className="num">{fmtNum(x.otHours)}h</td>
              <td className="num">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => onPick(x.reportId)}
                >
                  編集
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

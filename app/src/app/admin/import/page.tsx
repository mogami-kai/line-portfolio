"use client";

// ============================================================
// /admin/import — LINEトーク履歴の取り込み（バックフィル UI）
//   ① テキストを貼る → ②「確認（プレビュー）」で集計を表示（DB変更なし）
//   → 内容が正しければ ③「この内容で取り込む」で登録。
//   冪等なので同じテキストを再取り込みしても重複しません。
// ============================================================

import { useState } from "react";

interface WorkerTotal {
  name: string;
  manDays: number;
  otHours: number;
}
interface ImportResult {
  ok: boolean;
  error?: string;
  committed?: boolean;
  reportCount: number;
  totalManDays: number;
  totalOtHours: number;
  workerTotals: WorkerTotal[];
  clients: string[];
  siteCount: number;
  workers: string[];
  skipped: Array<{ reason: string; raw: string }>;
  skippedCount: number;
  dateRange: { from: string; to: string } | null;
  imported?: number;
  deduped?: number;
  failures?: string[];
  failureCount?: number;
}

export default function ImportPage() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<null | "preview" | "commit">(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(commit: boolean) {
    setError(null);
    setBusy(commit ? "commit" : "preview");
    if (commit) {
      const ok = window.confirm(
        "この内容でデータベースへ取り込みます。よろしいですか？（同じ内容の再取り込みは重複しません）",
      );
      if (!ok) {
        setBusy(null);
        return;
      }
    }
    try {
      const res = await fetch("/api/admin/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, commit }),
      });
      const data = (await res.json()) as ImportResult;
      if (!res.ok || !data.ok) {
        setError(data.error || "取り込みに失敗しました。");
        setResult(null);
      } else {
        setResult(data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "通信エラー");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="container container--admin">
      <div className="page-head">
        <h1 className="page-title">LINE取り込み</h1>
        <a href="/admin" className="badge">
          ← 管理
        </a>
      </div>
      <p className="page-sub">
        LINEの「トーク履歴を保存」したテキストを貼り付けて、過去の出面をまとめて登録します。
      </p>

      <div className="card">
        <div className="field">
          <label className="label" htmlFor="src">
            トーク履歴テキスト
          </label>
          <textarea
            id="src"
            className="textarea"
            style={{ minHeight: 180, fontFamily: "monospace", fontSize: 13 }}
            placeholder={"例）\n2026/06/10(水)\n17:28\t後藤　尚哉\t\"6月10日「水」\n辻濱工業　常用\n橋本\n後藤　齋　石渡\nパーキング800\""}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="hint">
            ※ そのまま全部貼ってOK。雑談・スタンプ・取消などは自動で除外します。
          </p>
        </div>
        <div className="row-gap">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => run(false)}
            disabled={busy !== null || !text.trim()}
          >
            {busy === "preview" ? "確認中…" : "① 確認（プレビュー）"}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => run(true)}
            disabled={busy !== null || !result || result.reportCount === 0}
          >
            {busy === "commit" ? "取り込み中…" : "② この内容で取り込む"}
          </button>
        </div>
      </div>

      {error && <div className="notice notice--error">{error}</div>}

      {result && (
        <>
          {result.committed ? (
            <div className="notice notice--ok">
              <p className="notice-title">取り込み完了</p>
              新規 <b>{result.imported}</b> 件
              {result.deduped ? `／重複スキップ ${result.deduped} 件` : ""}
              {result.failureCount ? `／失敗 ${result.failureCount} 件` : ""}。
              <a href="/admin" style={{ marginLeft: 8 }}>
                ダッシュボードで確認 →
              </a>
            </div>
          ) : (
            <div className="notice notice--warn">
              <p className="notice-title">プレビュー（まだ登録していません）</p>
              内容を確認して、正しければ「② この内容で取り込む」を押してください。
            </div>
          )}

          <div className="stat-grid">
            <div className="stat">
              <div className="stat-k">出面 件数</div>
              <div className="stat-v">{result.reportCount}</div>
            </div>
            <div className="stat">
              <div className="stat-k">人工合計</div>
              <div className="stat-v">{result.totalManDays}</div>
            </div>
            <div className="stat">
              <div className="stat-k">残業合計</div>
              <div className="stat-v">
                {result.totalOtHours}
                <small>h</small>
              </div>
            </div>
            <div className="stat">
              <div className="stat-k">期間</div>
              <div className="stat-v" style={{ fontSize: 14 }}>
                {result.dateRange
                  ? `${result.dateRange.from} 〜 ${result.dateRange.to}`
                  : "—"}
              </div>
            </div>
          </div>

          {result.workerTotals.length > 0 && (
            <>
              <div className="section-head">
                <h2 className="section-title">職人別（この取り込み分）</h2>
              </div>
              <table className="worker-table">
                <thead>
                  <tr>
                    <th>職人</th>
                    <th>人工</th>
                    <th>残業</th>
                  </tr>
                </thead>
                <tbody>
                  {result.workerTotals.map((w) => (
                    <tr key={w.name}>
                      <td className="wt-name">{w.name}</td>
                      <td>{w.manDays}</td>
                      <td className="wt-ot">{w.otHours ? `${w.otHours}h` : "—"}</td>
                    </tr>
                  ))}
                  <tr className="wt-total">
                    <td>合計</td>
                    <td>{result.totalManDays}</td>
                    <td>{result.totalOtHours}h</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}

          <p className="muted" style={{ marginTop: 12 }}>
            取引先 {result.clients.length}件・現場 {result.siteCount}件・職人{" "}
            {result.workers.length}名を{result.committed ? "登録" : "作成予定"}。
            {result.clients.length > 0 && (
              <>
                <br />
                取引先: {result.clients.join("、")}
              </>
            )}
          </p>

          {result.skippedCount > 0 && (
            <details className="card" style={{ marginTop: 12 }}>
              <summary className="disclosure-btn" style={{ padding: 0 }}>
                読み取れなかった行 {result.skippedCount}件（確認用）
              </summary>
              <div className="stack-sm" style={{ marginTop: 10 }}>
                {result.skipped.map((s, i) => (
                  <div key={i} className="notice" style={{ fontSize: 12 }}>
                    <b>[{s.reason}]</b>
                    <pre className="notice-pre" style={{ fontSize: 12 }}>
                      {s.raw}
                    </pre>
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </main>
  );
}

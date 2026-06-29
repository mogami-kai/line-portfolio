"use client";

// ============================================================
// 出面のインライン編集（管理ホーム /admin）— 編集ボタン＋同一ページ内モーダル
//
//   「直近の出面」フィードと「要確認」カードの右上に置く「編集」ボタン。
//   押すと別ページに飛ばず、その場で大きなモーダル（createPortal で body 直下）が
//   開き、その出面の全項目を編集・削除できる。
//
//   - 全項目はオンデマンド取得（getReportForEditAction）。ボタン分のデータを
//     ページ側で先読みしないため、一覧の RSC ペイロードを増やさない。
//   - 保存は updateReportAction（プレーン引数 / React 19）。削除は既存の
//     deleteReportAction（FormData, name="id"）を流用。どちらも成功後に
//     router.refresh() でフィード/要確認を最新化し、モーダルを閉じる。
//   - 職人プールは「その出面の org」に属する職人だけ（既存 entry の職人は
//     同 org のため必ず含まれる）。
// ============================================================

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  getReportForEditAction,
  updateReportAction,
  deleteReportAction,
} from "./_actions.js";
import { SHIFTS, SHIFT_LABEL, SHIFT_TO_MANDAYS } from "./_editTypes.js";
import type {
  ClientLite,
  WorkerLite,
  EditableReport,
  EditableEntry,
  EditableExpense,
  ContractType,
  Shift,
} from "./_editTypes.js";

/**
 * 出面1件の編集を開くトリガーボタン。
 *   variant="feed"  … フィード右上の小さい編集ボタン（class="feed-edit"）。
 *   variant="review"… 要確認右上のボタン（class="btn btn--ghost btn--sm"）。
 * 押下時に該当出面の全項目を取得しモーダルを表示する。
 */
export function EditReportButton({
  reportId,
  variant = "feed",
}: {
  reportId: string;
  variant?: "feed" | "review";
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {variant === "feed" ? (
        <button
          type="button"
          className="feed-edit"
          onClick={() => setOpen(true)}
        >
          編集
        </button>
      ) : (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setOpen(true)}
        >
          編集
        </button>
      )}
      {open && <EditModal reportId={reportId} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 編集モーダル本体（body 直下にポータル）。フォーム状態と保存/削除を持つ。 */
function EditModal({
  reportId,
  onClose,
}: {
  reportId: string;
  onClose: () => void;
}) {
  const router = useRouter();

  // SSR 中は createPortal しない（body が無い）。マウント後に true。
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // 取得結果（org の判定にも使う）と取得エラー。取引先/職人は開いた時に取得。
  const [data, setData] = useState<EditableReport | null>(null);
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [workers, setWorkers] = useState<WorkerLite[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // フォーム状態（取得後に初期化）。
  const [workDate, setWorkDate] = useState("");
  const [clientId, setClientId] = useState("");
  const [siteName, setSiteName] = useState("");
  const [contractType, setContractType] = useState<ContractType>("JOYO");
  const [contractAmount, setContractAmount] = useState(""); // 入力は文字列で保持
  const [entries, setEntries] = useState<EditableEntry[]>([]);
  const [expenses, setExpenses] = useState<EditableExpense[]>([]);

  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // ── 初回: 全項目をオンデマンド取得しフォームを初期化 ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await getReportForEditAction(reportId);
        if (cancelled) return;
        const rep = d.report;
        setData(rep);
        setClients(d.clients);
        setWorkers(d.workers);
        setWorkDate(rep.workDate);
        setClientId(rep.clientId);
        setSiteName(rep.siteName);
        setContractType(rep.contractType);
        setContractAmount(String(rep.contractAmount ?? ""));
        setEntries(rep.entries.map((e) => ({ ...e })));
        setExpenses(rep.expenses.map((x) => ({ ...x })));
      } catch (e) {
        if (!cancelled) {
          setLoadErr(String((e as Error).message || e) || "読み込みに失敗しました。");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reportId]);

  // ── 開いている間: 背面スクロールを止め、Escape で閉じる ──
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // その出面の org に属する職人だけを選択肢に（既存 entry の職人は必ず含まれる）。
  const pool: WorkerLite[] = data
    ? workers.filter((w) => w.orgId === data.orgId)
    : [];

  // ── 職人行の操作 ──
  function addEntry() {
    const first = pool[0];
    if (!first) return;
    setEntries((prev) => [
      ...prev,
      { workerId: first.id, shift: "DAY", manDays: 1, otHours: 0 },
    ]);
  }
  function updateEntry(i: number, patch: Partial<EditableEntry>) {
    setEntries((prev) => prev.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  }
  function removeEntry(i: number) {
    setEntries((prev) => prev.filter((_, idx) => idx !== i));
  }
  // 勤務体系の変更で人工を既定値に追従させる（人工は手入力で上書き可）。
  function changeShift(i: number, shift: Shift) {
    updateEntry(i, { shift, manDays: SHIFT_TO_MANDAYS[shift] });
  }

  // ── 経費行の操作 ──
  function addExpense() {
    setExpenses((prev) => [...prev, { kind: "", amount: 0, billable: true }]);
  }
  function updateExpense(i: number, patch: Partial<EditableExpense>) {
    setExpenses((prev) => prev.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }
  function removeExpense(i: number) {
    setExpenses((prev) => prev.filter((_, idx) => idx !== i));
  }

  // ── 保存 ──
  function onSave() {
    setErrMsg(null);
    if (entries.length < 1) {
      setErrMsg("職人を1名以上入力してください。");
      return;
    }
    if (entries.some((e) => !e.workerId)) {
      setErrMsg("職人を選択してください。");
      return;
    }
    if (contractType === "UKEOI" && !(Number(contractAmount) > 0)) {
      setErrMsg("請負金額（正の整数）を入力してください。");
      return;
    }
    startTransition(async () => {
      try {
        await updateReportAction({
          id: reportId,
          workDate,
          clientId,
          siteName,
          contractType,
          contractAmount: contractType === "UKEOI" ? Number(contractAmount) : null,
          entries,
          expenses: expenses.filter((x) => x.kind.trim() && x.amount > 0),
        });
        router.refresh();
        onClose();
      } catch (e) {
        setErrMsg(String((e as Error).message || e));
      }
    });
  }

  // ── 削除（既存の deleteReportAction を FormData で）──
  function onDelete() {
    if (!confirm("この出面を削除します。元に戻せません。よろしいですか？")) return;
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.set("id", reportId);
        await deleteReportAction(fd);
        router.refresh();
        onClose();
      } catch (e) {
        setErrMsg(String((e as Error).message || e));
      }
    });
  }

  if (!mounted) return null;

  return createPortal(
    <div className="rem-overlay" role="dialog" aria-modal="true">
      <button
        type="button"
        className="rem-scrim"
        aria-label="閉じる"
        onClick={onClose}
      />
      <div className="rem-panel">
        <div className="rem-head">
          <div className="rem-title">出面を編集</div>
          <button
            type="button"
            className="rem-close"
            aria-label="閉じる"
            onClick={onClose}
          >
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        {loadErr ? (
          <div className="notice notice--error">{loadErr}</div>
        ) : !data ? (
          <div className="rem-loading">読み込み中…</div>
        ) : (
          <>
            {/* ── ① 基本 ── */}
            <div className="rem-sec">
              <div className="rem-sec-title">基本</div>
              <div className="field">
                <label className="label" htmlFor="rem-date">
                  日付
                </label>
                <input
                  id="rem-date"
                  className="input"
                  type="date"
                  value={workDate}
                  onChange={(e) => setWorkDate(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="rem-client">
                  取引先
                </label>
                <select
                  id="rem-client"
                  className="select"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                >
                  <option value="">選択してください</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="label" htmlFor="rem-site">
                  現場
                </label>
                <input
                  id="rem-site"
                  className="input"
                  type="text"
                  placeholder="例: ○○マンション 外構（任意）"
                  value={siteName}
                  onChange={(e) => setSiteName(e.target.value)}
                />
                <p className="hint">任意・自由入力。空でも保存できます。</p>
              </div>
            </div>

            {/* ── ② 契約 ── */}
            <div className="rem-sec">
              <div className="rem-sec-title">契約</div>
              <div className="field">
                <div className="seg" role="group" aria-label="契約種別">
                  <button
                    type="button"
                    className={`seg-item ${
                      contractType === "JOYO" ? "seg-item--on" : ""
                    }`}
                    onClick={() => setContractType("JOYO")}
                  >
                    常用
                  </button>
                  <button
                    type="button"
                    className={`seg-item ${
                      contractType === "UKEOI" ? "seg-item--on" : ""
                    }`}
                    onClick={() => setContractType("UKEOI")}
                  >
                    請負
                  </button>
                </div>
              </div>
              {contractType === "UKEOI" && (
                <div className="field">
                  <label className="label" htmlFor="rem-amount">
                    請負金額（円・税抜）
                  </label>
                  <input
                    id="rem-amount"
                    className="input input--num"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    placeholder="例: 300000"
                    value={contractAmount}
                    onChange={(e) => setContractAmount(e.target.value)}
                  />
                </div>
              )}
            </div>

            {/* ── ③ 職人 ── */}
            <div className="rem-sec">
              <div className="rem-sec-title">職人</div>
              {entries.map((e, i) => (
                <div className="rem-row" key={i}>
                  <select
                    className="select"
                    aria-label="職人"
                    value={e.workerId}
                    onChange={(ev) => updateEntry(i, { workerId: ev.target.value })}
                  >
                    {pool.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="select"
                    aria-label="勤務体系"
                    value={e.shift}
                    onChange={(ev) => changeShift(i, ev.target.value as Shift)}
                  >
                    {SHIFTS.map((sh) => (
                      <option key={sh} value={sh}>
                        {SHIFT_LABEL[sh]}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input input--num"
                    type="number"
                    inputMode="decimal"
                    aria-label="人工"
                    min={0}
                    step={0.25}
                    value={e.manDays}
                    onChange={(ev) =>
                      updateEntry(i, { manDays: Number(ev.target.value) })
                    }
                  />
                  <input
                    className="input input--num"
                    type="number"
                    inputMode="decimal"
                    aria-label="残業時間"
                    min={0}
                    step={0.5}
                    value={e.otHours}
                    onChange={(ev) =>
                      updateEntry(i, { otHours: Number(ev.target.value) })
                    }
                  />
                  <button
                    type="button"
                    className="rem-row-del"
                    onClick={() => removeEntry(i)}
                  >
                    削除
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={addEntry}
                disabled={pool.length === 0}
              >
                ＋ 職人を追加
              </button>
            </div>

            {/* ── ④ 経費（任意）── */}
            <div className="rem-sec">
              <div className="rem-sec-title">経費（任意）</div>
              {expenses.map((x, i) => (
                <div className="rem-row" key={i}>
                  <input
                    className="input"
                    type="text"
                    aria-label="内容"
                    placeholder="種別（駐車/燃料…）"
                    value={x.kind}
                    onChange={(ev) => updateExpense(i, { kind: ev.target.value })}
                  />
                  <input
                    className="input input--num"
                    type="number"
                    inputMode="numeric"
                    aria-label="金額"
                    min={0}
                    step={1}
                    placeholder="金額"
                    value={x.amount}
                    onChange={(ev) =>
                      updateExpense(i, { amount: Number(ev.target.value) })
                    }
                  />
                  <label className="inline-row">
                    <input
                      type="checkbox"
                      checked={x.billable}
                      onChange={(ev) =>
                        updateExpense(i, { billable: ev.target.checked })
                      }
                    />
                    請求
                  </label>
                  <button
                    type="button"
                    className="rem-row-del"
                    onClick={() => removeExpense(i)}
                  >
                    削除
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={addExpense}
              >
                ＋ 経費を追加
              </button>
            </div>

            {errMsg && <div className="notice notice--error">{errMsg}</div>}

            <div className="rem-foot">
              <button
                type="button"
                className="btn btn--danger-text"
                onClick={onDelete}
                disabled={isPending}
              >
                この出面を削除
              </button>
              <div className="rem-foot-actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={onClose}
                  disabled={isPending}
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={onSave}
                  disabled={isPending}
                >
                  {isPending ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

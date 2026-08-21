"use client";

// ============================================================
// 出面の新規登録（管理ホーム /admin）— 「＋ 出面を追加」ボタン＋モーダル
//
//   LIFF提出し忘れ分を、管理者が自分のLINEアカウントで代理送信する必要が
//   あった不便を解消する。管理画面から直接・任意の組織の職人で登録できる。
//
//   構造は _editReport.tsx の EditModal を踏襲（同じ rem-* クラスを再利用）。
//   異なる点:
//     - 組織セレクトあり（全社管理者のみ。スコープ管理者は自組織固定＝非表示）
//     - 職人プールは選択中の組織でフィルタ（active のみ）
//     - LINEグループ投稿チェック（選択組織が SELF のときだけ表示・既定ON）
//     - 削除／メタ表示（入力者・最終編集）は無し（新規作成のため）
// ============================================================

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { getReportCreateFormDataAction, createReportAction } from "./_actions.js";
import { SHIFTS, SHIFT_LABEL, SHIFT_TO_MANDAYS } from "./_editTypes.js";
import { ExpenseKindPicker } from "../_components/expenseKindPicker.js";
import type {
  ClientLite,
  WorkerLite,
  OrgLite,
  EditableEntry,
  EditableExpense,
  ContractType,
  Shift,
} from "./_editTypes.js";

/** 「＋ 出面を追加」ボタン。管理ダッシュボードの「直近の出面」見出し脇に置く。 */
export function CreateReportButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="btn btn--primary btn--sm"
        onClick={() => setOpen(true)}
      >
        ＋ 出面を追加
      </button>
      {open && <CreateModal onClose={() => setOpen(false)} />}
    </>
  );
}

export function CreateModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();

  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const [orgs, setOrgs] = useState<OrgLite[]>([]);
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [workers, setWorkers] = useState<WorkerLite[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [orgId, setOrgId] = useState("");
  const [workDate, setWorkDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [clientId, setClientId] = useState("");
  const [siteName, setSiteName] = useState("");
  const [contractType, setContractType] = useState<ContractType>("JOYO");
  const [contractAmount, setContractAmount] = useState("");
  const [entries, setEntries] = useState<EditableEntry[]>([]);
  const [expenses, setExpenses] = useState<EditableExpense[]>([]);
  const [postToGroup, setPostToGroup] = useState(true);

  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // ── 初回: 組織/取引先/職人をオンデマンド取得 ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await getReportCreateFormDataAction();
        if (cancelled) return;
        setOrgs(d.orgs);
        setClients(d.clients);
        setWorkers(d.workers);
        if (d.orgs.length === 1) setOrgId(d.orgs[0].id);
        setLoaded(true);
      } catch (e) {
        if (!cancelled) {
          setLoadErr(String((e as Error).message || e) || "読み込みに失敗しました。");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  const selectedOrg = orgs.find((o) => o.id === orgId) ?? null;
  const pool: WorkerLite[] = orgId ? workers.filter((w) => w.orgId === orgId) : [];

  // 組織を切り替えたら、その組織に属さない職人行はクリア（誤登録防止）。
  function changeOrg(id: string) {
    setOrgId(id);
    setEntries([]);
  }

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
  function changeShift(i: number, shift: Shift) {
    updateEntry(i, { shift, manDays: SHIFT_TO_MANDAYS[shift] });
  }

  // ── 経費行の操作 ──
  function addExpense() {
    setExpenses((prev) => [
      ...prev,
      { kind: "", amount: 0, billable: true, paidBy: "", receiptPath: null },
    ]);
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
    if (!orgId) {
      setErrMsg("組織を選択してください。");
      return;
    }
    if (!clientId) {
      setErrMsg("取引先を選択してください。");
      return;
    }
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
        await createReportAction({
          orgId,
          workDate,
          clientId,
          siteName,
          contractType,
          contractAmount: contractType === "UKEOI" ? Number(contractAmount) : null,
          entries,
          expenses: expenses.filter((x) => x.kind.trim() && x.amount > 0),
          postToGroup,
        });
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
          <div className="rem-title">出面を追加</div>
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
          <div className="rem-body">
            <div className="notice notice--error">{loadErr}</div>
          </div>
        ) : !loaded ? (
          <div className="rem-body">
            <div className="rem-loading">読み込み中…</div>
          </div>
        ) : (
          <>
            <div className="rem-body">
              {/* ── ① 基本 ── */}
              <div className="rem-sec">
                <div className="rem-sec-title">基本</div>
                {orgs.length > 1 ? (
                  <div className="field">
                    <label className="label" htmlFor="crm-org">
                      組織
                    </label>
                    <select
                      id="crm-org"
                      className="select"
                      value={orgId}
                      onChange={(e) => changeOrg(e.target.value)}
                    >
                      <option value="">選択してください</option>
                      {orgs.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                          {o.kind === "PARTNER" ? "（協力会社）" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  orgs[0] && (
                    <div className="field">
                      <span className="label">組織</span>
                      <div className="muted">{orgs[0].name}</div>
                    </div>
                  )
                )}
                <div className="field">
                  <label className="label" htmlFor="crm-date">
                    日付
                  </label>
                  <input
                    id="crm-date"
                    className="input"
                    type="date"
                    value={workDate}
                    onChange={(e) => setWorkDate(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="crm-client">
                    取引先
                  </label>
                  <select
                    id="crm-client"
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
                  <label className="label" htmlFor="crm-site">
                    現場
                  </label>
                  <input
                    id="crm-site"
                    className="input"
                    type="text"
                    placeholder="例: ○○マンション 外構（任意）"
                    value={siteName}
                    onChange={(e) => setSiteName(e.target.value)}
                  />
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
                    <label className="label" htmlFor="crm-amount">
                      請負金額（円・税抜）
                    </label>
                    <input
                      id="crm-amount"
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
                {!orgId ? (
                  <div className="muted">先に組織を選択してください。</div>
                ) : (
                  <>
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
                  </>
                )}
              </div>

              {/* ── ④ 経費（任意）── */}
              <div className="rem-sec">
                <div className="rem-sec-title">経費（任意）</div>
                {expenses.map((x, i) => (
                  <div key={i}>
                    <ExpenseKindPicker
                      value={x.kind}
                      onChange={(v) => updateExpense(i, { kind: v })}
                    />
                    <div className="rem-row" style={{ marginTop: 8 }}>
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
                      <input
                        className="input"
                        type="text"
                        aria-label="立替えた人"
                        placeholder="立替えた人（任意）"
                        value={x.paidBy}
                        onChange={(ev) => updateExpense(i, { paidBy: ev.target.value })}
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
                  </div>
                ))}
                <button type="button" className="btn btn--ghost btn--sm" onClick={addExpense}>
                  ＋ 経費を追加
                </button>
              </div>

              {/* ── ⑤ LINEグループ投稿（SELF組織のときだけ）── */}
              {selectedOrg?.kind === "SELF" && (
                <div className="rem-sec">
                  <div className="rem-sec-title">LINE通知</div>
                  <label className="inline-row">
                    <input
                      type="checkbox"
                      checked={postToGroup}
                      onChange={(e) => setPostToGroup(e.target.checked)}
                    />
                    出面グループに投稿する
                  </label>
                  <p className="es-sub">
                    まとめて後追い登録する場合はオフにすると、グループへの通知を省略できます。
                  </p>
                </div>
              )}

              {errMsg && <div className="notice notice--error">{errMsg}</div>}
            </div>

            <div className="rem-foot">
              <div className="rem-foot-actions" style={{ marginLeft: "auto" }}>
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
                  {isPending ? "登録中…" : "登録"}
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

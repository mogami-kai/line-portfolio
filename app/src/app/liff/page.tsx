"use client";

// ============================================================
// /liff — 出面入力フォーム（LIFF / クライアントコンポーネント）
//
//   - LIFF SDK を CDN から読み込み（https://static.line.me/liff/edge/2/sdk.js）。
//   - liff.init({ liffId: NEXT_PUBLIC_LIFF_ID }) → アクセストークン取得。
//   - /api/masters から取引先・現場・職人を取得（Bearer = アクセストークン）。
//   - フォーム: 日付(既定=今日) / 取引先(select) / 現場(select+新規) /
//              契約種別(常用|請負) / 職人(複数選択, 各人に 半日|夜勤|残業) / 経費(任意)。
//   - 送信 → POST /api/reports（Bearer = アクセストークン）。
//
//   ※ パートナーも同じこのページを開く。所属 org はサーバ側で解決されるため、
//      自社/パートナーのトグルは UI に存在しない（本人は source を選ばない）。
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

// LIFF SDK の最小型（@line/liff 非依存）。
interface Liff {
  init: (config: { liffId: string }) => Promise<void>;
  isLoggedIn: () => boolean;
  login: (opts?: { redirectUri?: string }) => void;
  getAccessToken: () => string | null;
  isInClient: () => boolean;
}
declare global {
  interface Window {
    liff?: Liff;
  }
}

const LIFF_SDK_URL = "https://static.line.me/liff/edge/2/sdk.js";

type Shift = "DAY" | "HALF" | "NIGHT";
type ContractType = "JOYO" | "UKEOI";

interface SiteOption {
  id: string;
  name: string;
}
interface ClientOption {
  id: string;
  name: string;
  sites: SiteOption[];
}
interface WorkerOption {
  id: string;
  name: string;
}
interface MastersResponse {
  ok: boolean;
  me?: { displayName: string; role: string; orgName: string };
  clients: ClientOption[];
  workers: WorkerOption[];
  error?: string;
  message?: string;
}

// フォーム上の職人1行の状態。
interface EntryState {
  workerId: string;
  selected: boolean;
  shift: Shift;
  otHours: string; // 入力は文字列で保持し送信時に数値化
}

interface ExpenseState {
  kind: string;
  amount: string;
  billable: boolean;
}

const SHIFT_TO_MANDAYS: Record<Shift, number> = {
  DAY: 1,
  HALF: 0.5,
  NIGHT: 1,
};

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// CDN スクリプトを一度だけ読み込む。
function loadLiffSdk(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window !== "undefined" && window.liff) {
      resolve();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${LIFF_SDK_URL}"]`,
    );
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error("LIFF SDK load error")),
      );
      return;
    }
    const s = document.createElement("script");
    s.src = LIFF_SDK_URL;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("LIFF SDK load error"));
    document.head.appendChild(s);
  });
}

const box: CSSProperties = {
  maxWidth: 560,
  margin: "0 auto",
  padding: "16px",
  fontFamily:
    "system-ui, -apple-system, 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif",
  color: "#1a1a1a",
};
const label: CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  margin: "14px 0 4px",
};
const input: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 16,
  border: "1px solid #ccc",
  borderRadius: 8,
  boxSizing: "border-box",
};
const row: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
};

export default function LiffPage() {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [masters, setMasters] = useState<MastersResponse | null>(null);
  const [mastersError, setMastersError] = useState<string | null>(null);

  // フォーム状態
  const [workDate, setWorkDate] = useState<string>(todayISO());
  const [clientId, setClientId] = useState<string>("");
  const [siteId, setSiteId] = useState<string>("");
  const [newSiteName, setNewSiteName] = useState<string>("");
  const [contractType, setContractType] = useState<ContractType>("JOYO");
  const [entries, setEntries] = useState<EntryState[]>([]);
  const [expenses, setExpenses] = useState<ExpenseState[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    | { kind: "ok"; reportId: string; status: string; posted: boolean; askback?: string }
    | { kind: "error"; message: string }
    | null
  >(null);

  // ── LIFF 初期化 ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
      if (!liffId) {
        setLoadError("NEXT_PUBLIC_LIFF_ID が未設定です。");
        return;
      }
      try {
        await loadLiffSdk();
        const liff = window.liff;
        if (!liff) throw new Error("LIFF SDK が読み込めませんでした。");
        await liff.init({ liffId });
        if (cancelled) return;
        if (!liff.isLoggedIn()) {
          // ブラウザ起動など未ログイン時はログインへ。LINE アプリ内なら通常ログイン済み。
          liff.login();
          return;
        }
        const t = liff.getAccessToken();
        if (!t) throw new Error("アクセストークンを取得できませんでした。");
        setToken(t);
        setReady(true);
      } catch (e) {
        if (!cancelled)
          setLoadError(e instanceof Error ? e.message : "LIFF 初期化に失敗しました。");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── マスタ取得 ──
  useEffect(() => {
    if (!ready || !token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/masters", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await res.json()) as MastersResponse;
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          setMastersError(data.message || data.error || "マスタ取得に失敗しました。");
          return;
        }
        setMasters(data);
        // 既定取引先＝先頭。
        if (data.clients[0]) setClientId(data.clients[0].id);
        // 職人行を初期化。
        setEntries(
          data.workers.map((w) => ({
            workerId: w.id,
            selected: false,
            shift: "DAY" as Shift,
            otHours: "0",
          })),
        );
      } catch (e) {
        if (!cancelled)
          setMastersError(e instanceof Error ? e.message : "通信エラー");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, token]);

  const currentClient = useMemo(
    () => masters?.clients.find((c) => c.id === clientId) ?? null,
    [masters, clientId],
  );

  // 取引先を変えたら現場選択をリセット。
  useEffect(() => {
    setSiteId("");
    setNewSiteName("");
  }, [clientId]);

  const toggleWorker = useCallback((workerId: string) => {
    setEntries((prev) =>
      prev.map((e) =>
        e.workerId === workerId ? { ...e, selected: !e.selected } : e,
      ),
    );
  }, []);

  const updateEntry = useCallback(
    (workerId: string, patch: Partial<EntryState>) => {
      setEntries((prev) =>
        prev.map((e) => (e.workerId === workerId ? { ...e, ...patch } : e)),
      );
    },
    [],
  );

  const addExpense = useCallback(() => {
    setExpenses((prev) => [
      ...prev,
      { kind: "", amount: "", billable: true },
    ]);
  }, []);
  const updateExpense = useCallback(
    (idx: number, patch: Partial<ExpenseState>) => {
      setExpenses((prev) =>
        prev.map((x, i) => (i === idx ? { ...x, ...patch } : x)),
      );
    },
    [],
  );
  const removeExpense = useCallback((idx: number) => {
    setExpenses((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const onSubmit = useCallback(async () => {
    setResult(null);
    if (!token) {
      setResult({ kind: "error", message: "未認証です。" });
      return;
    }
    if (!clientId) {
      setResult({ kind: "error", message: "取引先を選択してください。" });
      return;
    }
    const selected = entries.filter((e) => e.selected);
    if (selected.length === 0) {
      setResult({ kind: "error", message: "職人を1名以上選択してください。" });
      return;
    }

    const payloadEntries = selected.map((e) => {
      const ot = Number(e.otHours);
      return {
        workerId: e.workerId,
        shift: e.shift,
        manDays: SHIFT_TO_MANDAYS[e.shift],
        otHours: isFinite(ot) && ot > 0 ? ot : 0,
      };
    });

    const payloadExpenses = expenses
      .map((x) => ({
        kind: x.kind.trim(),
        amount: Math.round(Number(x.amount)),
        billable: x.billable,
      }))
      .filter((x) => x.kind && isFinite(x.amount) && x.amount !== 0);

    const body: Record<string, unknown> = {
      workDate,
      clientId,
      contractType,
      entries: payloadEntries,
    };
    if (siteId) body.siteId = siteId;
    else if (newSiteName.trim()) body.newSiteName = newSiteName.trim();
    if (payloadExpenses.length) body.expenses = payloadExpenses;

    setSubmitting(true);
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.status === 422) {
        // 聞き返し（hold）。
        setResult({
          kind: "error",
          message: data.message || "入力内容を確認してください。",
        });
        return;
      }
      if (!res.ok || !data.ok) {
        setResult({
          kind: "error",
          message: data.message || data.error || "送信に失敗しました。",
        });
        return;
      }
      setResult({
        kind: "ok",
        reportId: data.reportId,
        status: data.status,
        posted: Boolean(data.postedToGroup),
        askback: data.askback,
      });
      // 送信後は選択をクリア（日付・取引先は残す）。
      setEntries((prev) => prev.map((e) => ({ ...e, selected: false, shift: "DAY", otHours: "0" })));
      setExpenses([]);
    } catch (e) {
      setResult({
        kind: "error",
        message: e instanceof Error ? e.message : "通信エラー",
      });
    } finally {
      setSubmitting(false);
    }
  }, [token, clientId, entries, expenses, workDate, contractType, siteId, newSiteName]);

  // ── 表示 ──
  if (loadError) {
    return (
      <main style={box}>
        <h1 style={{ fontSize: 18 }}>出面入力</h1>
        <p style={{ color: "#b00020" }}>{loadError}</p>
      </main>
    );
  }
  if (!ready) {
    return (
      <main style={box}>
        <h1 style={{ fontSize: 18 }}>出面入力</h1>
        <p>読み込み中…</p>
      </main>
    );
  }

  return (
    <main style={box}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>出面入力</h1>
      {masters?.me && (
        <p style={{ fontSize: 12, color: "#666", margin: 0 }}>
          {masters.me.orgName} / {masters.me.displayName}
        </p>
      )}

      {mastersError && <p style={{ color: "#b00020" }}>{mastersError}</p>}

      {/* 日付 */}
      <label style={label}>日付</label>
      <input
        style={input}
        type="date"
        value={workDate}
        onChange={(e) => setWorkDate(e.target.value)}
      />

      {/* 取引先 */}
      <label style={label}>取引先</label>
      <select
        style={input}
        value={clientId}
        onChange={(e) => setClientId(e.target.value)}
      >
        <option value="">選択してください</option>
        {masters?.clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>

      {/* 現場（既存 select ＋ 新規入力） */}
      <label style={label}>現場</label>
      <select
        style={input}
        value={siteId}
        onChange={(e) => setSiteId(e.target.value)}
        disabled={!currentClient}
      >
        <option value="">（現場を選択 / 新規は下に入力）</option>
        {currentClient?.sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <input
        style={{ ...input, marginTop: 6 }}
        type="text"
        placeholder="新規現場名（既存に無いとき。要確認キューに載ります）"
        value={newSiteName}
        onChange={(e) => setNewSiteName(e.target.value)}
        disabled={Boolean(siteId)}
      />

      {/* 契約種別 */}
      <label style={label}>契約種別</label>
      <div style={row}>
        <label style={{ fontSize: 15 }}>
          <input
            type="radio"
            name="contract"
            checked={contractType === "JOYO"}
            onChange={() => setContractType("JOYO")}
          />{" "}
          常用
        </label>
        <label style={{ fontSize: 15 }}>
          <input
            type="radio"
            name="contract"
            checked={contractType === "UKEOI"}
            onChange={() => setContractType("UKEOI")}
          />{" "}
          請負
        </label>
      </div>

      {/* 職人（複数選択＋各人に半日/夜勤/残業） */}
      <label style={label}>職人</label>
      {masters && masters.workers.length === 0 && (
        <p style={{ fontSize: 13, color: "#666" }}>
          職人マスタが空です。管理者に登録を依頼してください。
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {entries.map((e) => {
          const w = masters?.workers.find((x) => x.id === e.workerId);
          if (!w) return null;
          return (
            <div
              key={e.workerId}
              style={{
                border: "1px solid #e0e0e0",
                borderRadius: 8,
                padding: 8,
                background: e.selected ? "#f3f9ff" : "#fff",
              }}
            >
              <label style={{ ...row, fontSize: 15, fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={e.selected}
                  onChange={() => toggleWorker(e.workerId)}
                />
                {w.name}
              </label>
              {e.selected && (
                <div style={{ ...row, marginTop: 6, flexWrap: "wrap" }}>
                  <select
                    style={{ ...input, width: "auto", flex: "0 0 auto" }}
                    value={e.shift}
                    onChange={(ev) =>
                      updateEntry(e.workerId, { shift: ev.target.value as Shift })
                    }
                  >
                    <option value="DAY">日勤 (1.0)</option>
                    <option value="HALF">半日 (0.5)</option>
                    <option value="NIGHT">夜勤 (1.0)</option>
                  </select>
                  <span style={{ fontSize: 13 }}>残業</span>
                  <input
                    style={{ ...input, width: 72, flex: "0 0 auto" }}
                    type="number"
                    min={0}
                    step={0.5}
                    value={e.otHours}
                    onChange={(ev) =>
                      updateEntry(e.workerId, { otHours: ev.target.value })
                    }
                  />
                  <span style={{ fontSize: 13 }}>h</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 経費（任意） */}
      <label style={label}>経費（任意）</label>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {expenses.map((x, i) => (
          <div key={i} style={{ ...row, flexWrap: "wrap" }}>
            <input
              style={{ ...input, width: 140, flex: "0 0 auto" }}
              type="text"
              placeholder="種別（駐車/燃料…）"
              value={x.kind}
              onChange={(ev) => updateExpense(i, { kind: ev.target.value })}
            />
            <input
              style={{ ...input, width: 110, flex: "0 0 auto" }}
              type="number"
              placeholder="金額"
              value={x.amount}
              onChange={(ev) => updateExpense(i, { amount: ev.target.value })}
            />
            <label style={{ fontSize: 13 }}>
              <input
                type="checkbox"
                checked={x.billable}
                onChange={(ev) => updateExpense(i, { billable: ev.target.checked })}
              />{" "}
              請求
            </label>
            <button
              type="button"
              onClick={() => removeExpense(i)}
              style={{ marginLeft: "auto" }}
            >
              削除
            </button>
          </div>
        ))}
        <button type="button" onClick={addExpense} style={{ alignSelf: "flex-start" }}>
          ＋ 経費を追加
        </button>
      </div>

      {/* 送信 */}
      <button
        type="button"
        onClick={onSubmit}
        disabled={submitting}
        style={{
          marginTop: 20,
          width: "100%",
          padding: "12px",
          fontSize: 16,
          fontWeight: 700,
          color: "#fff",
          background: submitting ? "#9bbf9b" : "#06c755",
          border: "none",
          borderRadius: 10,
          cursor: submitting ? "default" : "pointer",
        }}
      >
        {submitting ? "送信中…" : "送信する"}
      </button>

      {/* 結果 */}
      {result?.kind === "ok" && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            borderRadius: 8,
            background: "#eaf7ee",
            border: "1px solid #bfe6cb",
            fontSize: 14,
          }}
        >
          <div>送信しました（{result.status}）。</div>
          <div style={{ color: "#555", fontSize: 12 }}>
            {result.posted
              ? "出面グループへログを投稿しました。"
              : "（グループ投稿なし）"}
          </div>
          {result.askback && (
            <div style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>
              {result.askback}
            </div>
          )}
        </div>
      )}
      {result?.kind === "error" && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            borderRadius: 8,
            background: "#fdecef",
            border: "1px solid #f6c4ce",
            fontSize: 14,
            whiteSpace: "pre-wrap",
          }}
        >
          {result.message}
        </div>
      )}
    </main>
  );
}

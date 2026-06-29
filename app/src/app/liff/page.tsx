"use client";

// ============================================================
// /liff — 出面入力フォーム（LIFF / クライアントコンポーネント）
//
//   設計方針（IT 不慣れな職人 / 親方向け・ワンタップ最優先）:
//     - LIFF SDK を CDN から読み込み → liff.init → アクセストークン取得。
//     - /api/masters で取引先・職人を取得（Bearer = アクセストークン）。
//     - 入力は極力タップだけ:
//         勤務体系(日勤/半日/夜勤)・常用/請負 = 大きなセグメント／チップ。
//         取引先 = タップ選択。職人 = 複数選択チップ（＋自分で職人を追加できる）。
//         現場 = 自由入力テキスト。
//     - スマート既定: 日付=今日。取引先/現場/職人/契約 = 前回送信（localStorage）を復元。
//     - ★「前回と同じで送る」: 画面上部の大ボタン。1タップで前回内容を確認画面へ。
//     - 送信ボタンは画面下部に固定（親指ゾーン, 56px）。二重送信防止。
//     - 送信後: 成功カード（要約）＋「もう1件入力」「閉じる」。
//       聞き返し(422 hold / confirm)は notice に bot メッセージを出し、修正→再送できる。
//
//   ※ POST /api/reports のボディ形は厳守:
//      { workDate, clientId, siteName, contractType, entries[], expenses?[] }
//        - siteName: 現場の自由入力（siteId は送らない）。空文字可。
//        - 請負金額（contractAmount）はフォームからは送らない（管理側でのみ入力）。
//
//   ※ パートナーも同じこのページを開く。所属 org はサーバ側で解決されるため、
//      自社/パートナーのトグルは UI に存在しない（本人は source を選ばない）。
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// 冪等キー生成（二重送信防止）。crypto.randomUUID 優先、無ければ簡易生成。
function newRequestId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// LIFF SDK の最小型（@line/liff 非依存）。
interface Liff {
  init: (config: { liffId: string }) => Promise<void>;
  isLoggedIn: () => boolean;
  login: (opts?: { redirectUri?: string }) => void;
  getAccessToken: () => string | null;
  isInClient: () => boolean;
  closeWindow?: () => void;
}
declare global {
  interface Window {
    liff?: Liff;
  }
}

// LIFF v2 SDK（公式CDN: static.line-scdn.net。static.line.me は読めずSDK load errorになる）
const LIFF_SDK_URL = "https://static.line-scdn.net/liff/edge/2/sdk.js";
const LS_KEY = "demen:lastReport:v1";

type Shift = "DAY" | "HALF" | "NIGHT";
type ContractType = "JOYO" | "UKEOI";

interface ClientOption {
  id: string;
  name: string;
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

// 職人の自己追加 POST /api/workers の返却。
interface WorkerCreated {
  ok?: boolean;
  id?: string;
  name?: string;
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

// localStorage に保存する「前回送信」スナップショット。
interface LastReport {
  clientId: string;
  siteName: string;
  contractType: ContractType;
  workerIds: string[];
  shiftByWorker: Record<string, Shift>;
}

const SHIFT_TO_MANDAYS: Record<Shift, number> = {
  DAY: 1,
  HALF: 0.5,
  NIGHT: 1,
};
const SHIFT_LABEL: Record<Shift, string> = {
  DAY: "日勤",
  HALF: "半日",
  NIGHT: "夜勤",
};
const SHIFTS: Shift[] = ["DAY", "HALF", "NIGHT"];

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function loadLast(): LastReport | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as LastReport;
    if (!v || typeof v.clientId !== "string") return null;
    return v;
  } catch {
    return null;
  }
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

type View = "form" | "confirm" | "success";

interface SubmitOk {
  reportId: string;
  status: string;
  posted: boolean;
  askback?: string;
  // 成功カードの要約用
  summary: { date: string; client: string; site: string; count: number };
}

export default function LiffPage() {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [masters, setMasters] = useState<MastersResponse | null>(null);
  const [mastersError, setMastersError] = useState<string | null>(null);

  // フォーム状態
  const [workDate, setWorkDate] = useState<string>(todayISO());
  const [clientId, setClientId] = useState<string>("");
  // 現場は自由入力（現場マスタ非依存）。送信bodyの siteName。
  const [siteName, setSiteName] = useState<string>("");
  const [contractType, setContractType] = useState<ContractType>("JOYO");
  const [entries, setEntries] = useState<EntryState[]>([]);
  const [showExpenses, setShowExpenses] = useState<boolean>(false);
  const [expenses, setExpenses] = useState<ExpenseState[]>([]);

  // 職人の自己追加用
  const [newWorkerName, setNewWorkerName] = useState<string>("");
  const [addingWorker, setAddingWorker] = useState<boolean>(false);
  const [workerAddError, setWorkerAddError] = useState<string | null>(null);
  // 職人の絞り込み（多人数のとき・名前で部分一致／大文字小文字無視）。
  const [workerQuery, setWorkerQuery] = useState<string>("");

  const [view, setView] = useState<View>("form");
  const [submitting, setSubmitting] = useState(false);
  const [okResult, setOkResult] = useState<SubmitOk | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<"warn" | "error">("error");
  const errorRef = useRef<HTMLDivElement | null>(null);
  // エラー/聞き返しが出たら、その通知へスクロール（下部CTAから送って失敗しても気づける）。
  useEffect(() => {
    if (errorMsg) {
      errorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [errorMsg]);
  const [last, setLast] = useState<LastReport | null>(null);

  // 冪等キー: 「1件の出面」に対し一意。送信成功・新規入力でローテーションし、
  // 失敗時の再送（同一内容）では同じキーを使い回して二重登録を防ぐ。
  const requestIdRef = useRef<string>(newRequestId());

  // ── LIFF 初期化 ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
      if (!liffId) {
        console.warn("[liff] NEXT_PUBLIC_LIFF_ID is not set");
        setLoadError("アプリの設定に問題があります。管理者にご連絡ください。");
        return;
      }
      try {
        await loadLiffSdk();
        const liff = window.liff;
        if (!liff) throw new Error("LIFF SDK が読み込めませんでした。");
        await liff.init({ liffId });
        if (cancelled) return;
        if (!liff.isLoggedIn()) {
          liff.login();
          return;
        }
        const t = liff.getAccessToken();
        if (!t) throw new Error("アクセストークンを取得できませんでした。");
        setToken(t);
        setReady(true);
      } catch (e) {
        console.error("[liff] init failed", e);
        if (!cancelled)
          setLoadError(
            "読み込みに失敗しました。電波の良い場所で、LINE からもう一度開き直してください。",
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── マスタ取得 ＋ 前回送信の復元（スマート既定） ──
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
          setMastersError(
            data.message || data.error || "マスタ取得に失敗しました。",
          );
          return;
        }
        setMasters(data);

        const saved = loadLast();
        setLast(saved);

        // 取引先の既定: 前回 → 先頭。
        const savedClientValid =
          saved && data.clients.some((c) => c.id === saved.clientId);
        const initialClientId = savedClientValid
          ? saved!.clientId
          : data.clients[0]?.id ?? "";
        setClientId(initialClientId);

        // 現場・契約の既定: 前回（同一取引先のとき）。
        if (savedClientValid) {
          setSiteName(saved!.siteName ?? "");
          setContractType(saved!.contractType);
        }

        // 職人行を初期化（前回選択を復元）。
        const savedSet = new Set(saved?.workerIds ?? []);
        setEntries(
          data.workers.map((w) => ({
            workerId: w.id,
            selected: savedSet.has(w.id),
            shift: (saved?.shiftByWorker?.[w.id] as Shift) ?? "DAY",
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

  const selectedEntries = useMemo(
    () => entries.filter((e) => e.selected),
    [entries],
  );

  // 職人 id → 名前（並び替え/絞り込みで参照）。
  const workerNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of masters?.workers ?? []) m.set(w.id, w.name);
    return m;
  }, [masters]);

  // 検索欄は人数が多いときだけ出す（少人数では邪魔しない）。
  const showWorkerSearch = (masters?.workers.length ?? 0) >= 8;

  // 表示用の職人行: 選択済みを先頭へまとめ、検索クエリで絞り込み。
  // 並びは安定（元の登録順）を保ちつつ、選択/未選択でグループ化する。
  const visibleEntries = useMemo(() => {
    const q = workerQuery.trim().toLowerCase();
    const matched = q
      ? entries.filter((e) =>
          (workerNameById.get(e.workerId) ?? "").toLowerCase().includes(q),
        )
      : entries;
    // 選択済みは検索でも常に残す（選択を見失わないように）。
    const base = q
      ? Array.from(
          new Map(
            [...matched, ...entries.filter((e) => e.selected)].map((e) => [
              e.workerId,
              e,
            ]),
          ).values(),
        )
      : matched;
    const sel = base.filter((e) => e.selected);
    const rest = base.filter((e) => !e.selected);
    return [...sel, ...rest];
  }, [entries, workerQuery, workerNameById]);

  const clientName = currentClient?.name ?? "";
  // 確認/成功カードの現場表記。
  const siteLabel = useMemo(() => {
    const t = siteName.trim();
    return t || "(現場未設定)";
  }, [siteName]);

  // 取引先を変えても現場の自由入力は維持（同じ現場で取引先だけ直す運用に配慮）。
  const onPickClient = useCallback((id: string) => {
    setClientId(id);
  }, []);

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

  // ── 職人を自分で追加（POST /api/workers）──
  const onAddWorker = useCallback(async () => {
    const name = newWorkerName.trim();
    setWorkerAddError(null);
    if (!name) {
      setWorkerAddError("職人名を入力してください。");
      return;
    }
    if (!token) {
      setWorkerAddError("未認証です。");
      return;
    }
    setAddingWorker(true);
    try {
      const res = await fetch("/api/workers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name }),
      });
      const data = (await res.json()) as WorkerCreated;
      if (!res.ok || !data.id || !data.name) {
        setWorkerAddError(
          data.message || data.error || "職人の追加に失敗しました。",
        );
        return;
      }
      const created: WorkerOption = { id: data.id, name: data.name };

      // マスタへ反映（同名の重複追加を避ける）。
      setMasters((prev) =>
        prev && !prev.workers.some((w) => w.id === created.id)
          ? { ...prev, workers: [...prev.workers, created] }
          : prev,
      );
      // 職人行へ追加＋即時選択（既存ならその行を選択にするだけ）。
      setEntries((prev) => {
        const exists = prev.some((e) => e.workerId === created.id);
        if (exists) {
          return prev.map((e) =>
            e.workerId === created.id ? { ...e, selected: true } : e,
          );
        }
        return [
          ...prev,
          {
            workerId: created.id,
            selected: true,
            shift: "DAY",
            otHours: "0",
          },
        ];
      });
      setNewWorkerName("");
    } catch (e) {
      setWorkerAddError(e instanceof Error ? e.message : "通信エラー");
    } finally {
      setAddingWorker(false);
    }
  }, [newWorkerName, token]);

  const addExpense = useCallback(() => {
    setExpenses((prev) => [...prev, { kind: "", amount: "", billable: true }]);
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

  // ── 送信処理（フォーム / 確認 共通） ──
  const doSubmit = useCallback(async () => {
    setErrorMsg(null);
    if (!token) {
      setErrorKind("error");
      setErrorMsg("未認証です。");
      return;
    }
    if (!clientId) {
      setErrorKind("error");
      setErrorMsg("取引先を選択してください。");
      return;
    }
    const selected = entries.filter((e) => e.selected);
    if (selected.length === 0) {
      setErrorKind("error");
      setErrorMsg("職人を1名以上選んでください。");
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
      // 現場は自由入力（空文字可）。siteId は送らない。
      siteName: siteName.trim(),
      contractType,
      entries: payloadEntries,
      // 二重送信防止の冪等キー（同一内容の再送では同じ値を使う）。
      clientRequestId: requestIdRef.current,
    };
    if (payloadExpenses.length) body.expenses = payloadExpenses;

    // 成功時の要約スナップショット。
    const summarySnapshot = {
      date: workDate,
      client: clientName,
      site: siteLabel,
      count: selected.length,
    };

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

      // 聞き返し（hold = 422）: 保存されていない。修正して再送。
      if (res.status === 422) {
        setErrorKind("warn");
        setErrorMsg(
          data.message ||
            "入力内容のご確認が必要です。修正して再度送信してください。",
        );
        setView("form");
        return;
      }
      if (!res.ok || !data.ok) {
        setErrorKind("error");
        setErrorMsg(data.message || data.error || "送信に失敗しました。");
        setView("form");
        return;
      }

      // 成功 → 前回送信を保存（次回のスマート既定 / 「前回と同じ」用）。
      const snapshot: LastReport = {
        clientId,
        siteName: siteName.trim(),
        contractType,
        workerIds: selected.map((e) => e.workerId),
        shiftByWorker: Object.fromEntries(
          selected.map((e) => [e.workerId, e.shift]),
        ),
      };
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(snapshot));
        setLast(snapshot);
      } catch {
        /* localStorage 不可でも送信自体は成功 */
      }

      setOkResult({
        reportId: data.reportId,
        status: data.status,
        posted: Boolean(data.postedToGroup),
        askback: data.askback,
        summary: summarySnapshot,
      });
      // 次の入力は別レコード → 冪等キーをローテーション。
      requestIdRef.current = newRequestId();
      setView("success");
    } catch (e) {
      setErrorKind("error");
      setErrorMsg(e instanceof Error ? e.message : "通信エラー");
      setView("form");
    } finally {
      setSubmitting(false);
    }
  }, [
    token,
    clientId,
    entries,
    expenses,
    workDate,
    contractType,
    siteName,
    clientName,
    siteLabel,
  ]);

  // ★「前回と同じで送る」: 前回内容で state を整え、確認画面へ。
  const onRepeat = useCallback(() => {
    if (!last || !masters) return;
    setErrorMsg(null);
    // 別レコードとして送るため新しい冪等キーに。
    requestIdRef.current = newRequestId();
    setWorkDate(todayISO());
    setClientId(last.clientId);
    setSiteName(last.siteName ?? "");
    setContractType(last.contractType);
    const set = new Set(last.workerIds);
    setEntries(
      masters.workers.map((w) => ({
        workerId: w.id,
        selected: set.has(w.id),
        shift: (last.shiftByWorker?.[w.id] as Shift) ?? "DAY",
        otHours: "0",
      })),
    );
    setExpenses([]);
    setShowExpenses(false);
    setView("confirm");
  }, [last, masters]);

  // 成功後「もう1件入力」: 選択だけリセットしてフォームへ。
  const onAnother = useCallback(() => {
    setOkResult(null);
    setErrorMsg(null);
    setExpenses([]);
    setShowExpenses(false);
    setEntries((prev) =>
      prev.map((e) => ({ ...e, selected: false, shift: "DAY", otHours: "0" })),
    );
    setView("form");
  }, []);

  const onClose = useCallback(() => {
    try {
      window.liff?.closeWindow?.();
    } catch {
      /* ブラウザ起動時は閉じられない */
    }
  }, []);

  // ── 表示: ローディング / エラー ──
  if (loadError) {
    return (
      <main className="container">
        <h1 className="page-title" style={{ marginTop: 12 }}>
          出面入力
        </h1>
        <div className="notice notice--error" style={{ marginTop: 12 }}>
          {loadError}
        </div>
      </main>
    );
  }
  if (!ready || !masters) {
    // 真っ白スピナーではなく、フォームの骨組み（スケルトン）を即出して体感を短縮。
    return (
      <main className="container">
        <div className="page-head">
          <h1 className="page-title">出面入力</h1>
          <span className="muted">読み込み中…</span>
        </div>
        {mastersError ? (
          <div className="notice notice--error">{mastersError}</div>
        ) : (
          <div aria-hidden>
            <div className="card" style={{ marginTop: 14 }}>
              <div className="skeleton-line skeleton-line--head" />
              <div
                className="skeleton-box"
                style={{ minHeight: 48, borderRadius: 10 }}
              />
              <div className="skeleton-line" />
              <div
                className="skeleton-box"
                style={{ minHeight: 48, borderRadius: 10 }}
              />
            </div>
            <div className="card">
              <div className="skeleton-line skeleton-line--head" />
              <div
                className="skeleton-box"
                style={{ minHeight: 56, borderRadius: 10 }}
              />
              <div
                className="skeleton-box"
                style={{ minHeight: 56, borderRadius: 10, marginTop: 8 }}
              />
            </div>
          </div>
        )}
      </main>
    );
  }

  // ── 成功カード ──
  if (view === "success" && okResult) {
    const s = okResult.summary;
    const needsReview = okResult.status === "NEEDS_REVIEW";
    return (
      <main className="container">
        <div className="card success">
          <div className="success-ico" aria-hidden>
            <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </div>
          <div className="success-title">登録しました</div>
          <div className="summary-list">
            <div className="summary-row">
              <span className="k">日付</span>
              <span className="v">{s.date}</span>
            </div>
            <div className="summary-row">
              <span className="k">取引先</span>
              <span className="v">{s.client}</span>
            </div>
            <div className="summary-row">
              <span className="k">現場</span>
              <span className="v">{s.site}</span>
            </div>
            <div className="summary-row">
              <span className="k">人数</span>
              <span className="v">{s.count}名</span>
            </div>
          </div>

          {okResult.posted && (
            <p className="muted">出面グループへ投稿しました。</p>
          )}
          {needsReview && (
            <div className="notice notice--warn" style={{ textAlign: "left" }}>
              <p className="notice-title">管理者の確認待ちです</p>
              {okResult.askback ? (
                <p className="notice-pre">{okResult.askback}</p>
              ) : (
                <span>内容に確認事項があるため、要確認として登録しました。</span>
              )}
            </div>
          )}

          <div className="row-gap" style={{ marginTop: 8 }}>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              閉じる
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={onAnother}
            >
              もう1件入力
            </button>
          </div>
        </div>
      </main>
    );
  }

  // ── 確認画面（「前回と同じで送る」専用の最終確認） ──
  if (view === "confirm") {
    return (
      <main className="container has-cta">
        <div className="page-head">
          <h1 className="page-title">この内容で送信</h1>
        </div>

        {errorMsg && (
          <div
            className={`notice ${
              errorKind === "warn" ? "notice--warn" : "notice--error"
            }`}
          >
            <p className="notice-pre" style={{ margin: 0 }}>
              {errorMsg}
            </p>
          </div>
        )}

        <div className="card">
          <div className="summary-list" style={{ margin: 0 }}>
            <div className="summary-row">
              <span className="k">日付</span>
              <span className="v">{workDate}</span>
            </div>
            <div className="summary-row">
              <span className="k">取引先</span>
              <span className="v">{clientName}</span>
            </div>
            <div className="summary-row">
              <span className="k">現場</span>
              <span className="v">{siteLabel}</span>
            </div>
            <div className="summary-row">
              <span className="k">契約</span>
              <span className="v">
                {contractType === "JOYO" ? "常用" : "請負"}
              </span>
            </div>
            <div className="summary-row">
              <span className="k">職人</span>
              <span className="v">
                {selectedEntries
                  .map((e) => {
                    const w = masters.workers.find(
                      (x) => x.id === e.workerId,
                    );
                    return `${w?.name ?? ""}(${SHIFT_LABEL[e.shift]})`;
                  })
                  .join("、") || "未選択"}
              </span>
            </div>
          </div>
        </div>

        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => setView("form")}
        >
          内容を直す
        </button>

        <div className="cta-bar">
          <div className="cta-inner">
            <button
              type="button"
              className="btn btn--primary btn--lg btn--block"
              onClick={doSubmit}
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <span className="spinner" aria-hidden /> 送信中…
                </>
              ) : (
                "送信"
              )}
            </button>
          </div>
        </div>
      </main>
    );
  }

  // ── 入力フォーム ──
  const noWorkers = masters.workers.length === 0;

  return (
    <main className="container has-cta">
      <div className="page-head">
        <h1 className="page-title">出面入力</h1>
        {masters.me && (
          <span className="muted">
            {masters.me.orgName} / {masters.me.displayName}
          </span>
        )}
      </div>

      {/* ★ killer: 前回と同じで送る */}
      {last && (
        <button type="button" className="repeat-btn" onClick={onRepeat}>
          <span className="repeat-ico" aria-hidden>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-8.1-5" />
              <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 8.1 5" />
              <path d="M21 3v5h-5" />
              <path d="M3 21v-5h5" />
            </svg>
          </span>
          <span>
            <span className="repeat-main">前回と同じで送る</span>
            <span className="repeat-sub">
              {(masters.clients.find((c) => c.id === last.clientId)?.name ??
                "前回の取引先")}
              {last.siteName ? `・${last.siteName}` : ""}・職人
              {last.workerIds.length}名 → 確認へ
            </span>
          </span>
        </button>
      )}

      {mastersError && (
        <div className="notice notice--error">{mastersError}</div>
      )}
      {errorMsg && (
        <div
          ref={errorRef}
          className={`notice ${
            errorKind === "warn" ? "notice--warn" : "notice--error"
          }`}
        >
          {errorKind === "warn" && (
            <p className="notice-title">要確認</p>
          )}
          <p className="notice-pre" style={{ margin: 0 }}>
            {errorMsg}
          </p>
        </div>
      )}

      <div className="card" style={{ marginTop: 14 }}>
        {/* 日付 */}
        <div className="field">
          <label className="label" htmlFor="workDate">
            日付
          </label>
          <input
            id="workDate"
            className="input"
            type="date"
            value={workDate}
            onChange={(e) => setWorkDate(e.target.value)}
          />
        </div>

        {/* 取引先 */}
        <div className="field">
          <label className="label" htmlFor="clientSel">
            取引先
          </label>
          <select
            id="clientSel"
            className="select"
            value={clientId}
            onChange={(e) => onPickClient(e.target.value)}
          >
            <option value="">選択してください</option>
            {masters.clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {/* 現場メモ（任意・自由入力。現場マスタ非依存。siteName 仕様は不変） */}
        <div className="field">
          <label className="label" htmlFor="siteName">
            現場メモ（任意）
          </label>
          <input
            id="siteName"
            className="input"
            type="text"
            placeholder="例: ○○邸 / 1階内装（任意）"
            value={siteName}
            onChange={(e) => setSiteName(e.target.value)}
          />
          <p className="hint">任意・管理用のメモです。請求書には出ません。</p>
        </div>

        {/* 契約種別（セグメント） */}
        <div className="field">
          <label className="label">契約種別</label>
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
      </div>

      {/* 職人（複数選択チップ＋各人に勤務体系/残業。＋自分で職人を追加） */}
      <div className="card">
        <div className="field" style={{ marginBottom: 8 }}>
          <label className="label">
            職人（タップで選択）
            {selectedEntries.length > 0 && (
              <span className="badge badge--self" style={{ marginLeft: 6 }}>
                {selectedEntries.length}名
              </span>
            )}
          </label>
        </div>

        {/* 職人が多いときだけ検索欄を出す（少人数では非表示） */}
        {showWorkerSearch && (
          <div className="field" style={{ marginBottom: 8 }}>
            <input
              className="input"
              type="text"
              inputMode="search"
              placeholder="職人を検索（名前）"
              value={workerQuery}
              onChange={(ev) => setWorkerQuery(ev.target.value)}
            />
          </div>
        )}

        {noWorkers ? (
          <p className="muted">
            職人がまだありません。下の「職人を追加」で登録できます。
          </p>
        ) : visibleEntries.length === 0 ? (
          <p className="muted">「{workerQuery.trim()}」に一致する職人がいません。</p>
        ) : (
          visibleEntries.map((e) => {
            const w = masters.workers.find((x) => x.id === e.workerId);
            if (!w) return null;
            return (
              <div
                key={e.workerId}
                className={`worker-card ${e.selected ? "worker-card--on" : ""}`}
              >
                <div
                  className="worker-head"
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleWorker(e.workerId)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ")
                      toggleWorker(e.workerId);
                  }}
                >
                  <span className="worker-mark" aria-hidden>
                    {e.selected ? (
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    ) : null}
                  </span>
                  {w.name}
                </div>
                {e.selected && (
                  <div className="worker-opts">
                    <div className="seg" role="group" aria-label="勤務体系">
                      {SHIFTS.map((sh) => (
                        <button
                          key={sh}
                          type="button"
                          className={`seg-item ${
                            e.shift === sh ? "seg-item--on" : ""
                          }`}
                          onClick={() =>
                            updateEntry(e.workerId, { shift: sh })
                          }
                        >
                          {SHIFT_LABEL[sh]}
                          <br />
                          <small>{SHIFT_TO_MANDAYS[sh].toFixed(1)}</small>
                        </button>
                      ))}
                    </div>
                    <div
                      className="inline-row"
                      style={{ marginTop: 10 }}
                    >
                      <span className="label" style={{ margin: 0 }}>
                        残業
                      </span>
                      <input
                        className="input input--num"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step={0.5}
                        value={e.otHours}
                        onChange={(ev) =>
                          updateEntry(e.workerId, {
                            otHours: ev.target.value,
                          })
                        }
                      />
                      <span className="muted">時間</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}

        {/* ＋職人を追加（その場で org に永続化） */}
        <div className="worker-add">
          <input
            className="input worker-add-input"
            type="text"
            placeholder="職人名を入力"
            value={newWorkerName}
            onChange={(ev) => {
              setNewWorkerName(ev.target.value);
              if (workerAddError) setWorkerAddError(null);
            }}
            onKeyDown={(ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault();
                if (!addingWorker) onAddWorker();
              }
            }}
            disabled={addingWorker}
          />
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={onAddWorker}
            disabled={addingWorker || !newWorkerName.trim()}
          >
            {addingWorker ? (
              <>
                <span className="spinner" aria-hidden /> 追加中…
              </>
            ) : (
              "職人を追加"
            )}
          </button>
        </div>
        {workerAddError && (
          <p className="hint" style={{ color: "var(--danger)" }}>
            {workerAddError}
          </p>
        )}
      </div>

      {/* 経費（既定は閉じる：累進的開示） */}
      <div className="card">
        {!showExpenses ? (
          <button
            type="button"
            className="disclosure-btn"
            onClick={() => {
              setShowExpenses(true);
              if (expenses.length === 0) addExpense();
            }}
          >
            ＋ 経費を追加（任意）
          </button>
        ) : (
          <>
            <div className="field" style={{ marginBottom: 8 }}>
              <label className="label">経費</label>
            </div>
            <div className="stack-sm">
              {expenses.map((x, i) => (
                <div key={i} className="worker-card" style={{ margin: 0 }}>
                  <div className="inline-row">
                    <input
                      className="input"
                      style={{ flex: "1 1 120px" }}
                      type="text"
                      placeholder="種別（駐車/燃料…）"
                      value={x.kind}
                      onChange={(ev) =>
                        updateExpense(i, { kind: ev.target.value })
                      }
                    />
                    <input
                      className="input input--num"
                      type="number"
                      inputMode="numeric"
                      placeholder="金額"
                      value={x.amount}
                      onChange={(ev) =>
                        updateExpense(i, { amount: ev.target.value })
                      }
                    />
                  </div>
                  <div
                    className="inline-row"
                    style={{ marginTop: 8, justifyContent: "space-between" }}
                  >
                    <label
                      className="chip"
                      style={{ cursor: "pointer" }}
                    >
                      <input
                        type="checkbox"
                        checked={x.billable}
                        onChange={(ev) =>
                          updateExpense(i, { billable: ev.target.checked })
                        }
                      />
                      請求する
                    </label>
                    <button
                      type="button"
                      className="btn btn--danger-text"
                      onClick={() => removeExpense(i)}
                    >
                      削除
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={addExpense}
              >
                ＋ もう1件
              </button>
            </div>
          </>
        )}
      </div>

      {/* スティッキー送信（親指ゾーン） */}
      <div className="cta-bar">
        <div className="cta-inner">
          <button
            type="button"
            className="btn btn--primary btn--lg btn--block"
            onClick={doSubmit}
            disabled={submitting || noWorkers}
          >
            {submitting ? (
              <>
                <span className="spinner" aria-hidden /> 送信中…
              </>
            ) : (
              "送信"
            )}
          </button>
        </div>
      </div>
    </main>
  );
}

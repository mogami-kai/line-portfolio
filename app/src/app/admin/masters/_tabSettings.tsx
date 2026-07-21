"use client";

// ============================================================
// /admin/masters — 請求書設定タブ（実装）
//
//   freee / マネーフォワード 風。1枚のフォームを4ブロック（.mst-block）に
//   分割し、その下に請求書プレビュー（.mst-preview）を置く。
//   ・会社情報 / 振込先 / 税設定 / 担当者 の4ブロック。
//   ・末尾に「保存」（btn--primary）1つ。送信は saveInvoiceSettingAction。
//     ここはドロワーではないので、成功後は router.refresh() のみ（onClose 不要）。
//   ・プレビューは入力に追従（会社名・住所・登録番号・振込先・税率・担当者が
//     請求書にどう載るかをその場で確認できる）。各値は useState で保持する。
//
//   ※ 税率はモデル上は比率（0.10）。フォームでは % 表示で入力し、
//     送信時は name="taxRatePct"（% 値）で saveInvoiceSettingAction に渡す
//     （サーバ側で /100 して保存）。
//
//   Server Action は ../_actions.js を再利用（DB / ロジックは変更しない）。
// ============================================================

import type { JSX } from "react";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SettingRow, AdminOption } from "./_mastersTypes.js";
import { saveInvoiceSettingAction } from "../_actions.js";

/** 比率（0.10）→ 表示用の % 値（10）。未設定時は既定 10%。 */
function rateToPct(taxRate: number | undefined): number {
  const r = typeof taxRate === "number" && Number.isFinite(taxRate) ? taxRate : 0.1;
  return Math.round(r * 100);
}

export function SettingsTab({
  setting,
  admins,
}: {
  setting: SettingRow | null;
  admins: AdminOption[];
}): JSX.Element {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // プレビュー追従のため各値を controlled で保持（初期値は現在の設定）。
  const [issuerName, setIssuerName] = useState(setting?.issuerName ?? "");
  const [address, setAddress] = useState(setting?.address ?? "");
  const [tel, setTel] = useState(setting?.tel ?? "");
  const [email, setEmail] = useState(setting?.email ?? "");
  const [regNumber, setRegNumber] = useState(setting?.regNumber ?? "");
  const [bankInfo, setBankInfo] = useState(setting?.bankInfo ?? "");
  const [taxPct, setTaxPct] = useState<string>(String(rateToPct(setting?.taxRate)));
  const [contactName, setContactName] = useState(setting?.contactName ?? "");
  // 入金確認リマインド（プレビュー追従は不要だが操作状態として保持）。
  const [reminderOn, setReminderOn] = useState(setting?.dueReminderEnabled ?? false);
  const [reminderHour, setReminderHour] = useState<string>(
    String(setting?.dueReminderHour ?? 9),
  );
  const [reminderUserId, setReminderUserId] = useState(
    setting?.dueReminderUserId ?? "",
  );

  function submit(fd: FormData): void {
    setErr(null);
    setDone(false);
    start(async () => {
      try {
        await saveInvoiceSettingAction(fd);
        setDone(true);
        router.refresh();
      } catch (e) {
        setErr(String((e as Error).message || e));
      }
    });
  }

  // プレビュー用に税率（数値%）を正規化（不正入力時は 0 扱いで表示）。
  const pctNum = useMemo(() => {
    const n = Number(taxPct);
    return Number.isFinite(n) ? n : 0;
  }, [taxPct]);

  return (
    <div>
      <form action={submit}>
        {err && (
          <div className="notice notice--error" role="alert">
            {err}
          </div>
        )}
        {done && !err && (
          <div className="notice notice--ok" role="status">
            保存しました。
          </div>
        )}

        {/* ── 会社情報 ── */}
        <section className="mst-block">
          <h3 className="mst-block-title">会社情報</h3>

          <div className="field">
            <label className="label" htmlFor="set-issuerName">
              会社名
            </label>
            <input
              id="set-issuerName"
              className="input"
              name="issuerName"
              type="text"
              required
              autoComplete="organization"
              value={issuerName}
              onChange={(e) => setIssuerName(e.target.value)}
              placeholder="例: 株式会社○○工務店"
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="set-address">
              住所
            </label>
            <input
              id="set-address"
              className="input"
              name="address"
              type="text"
              autoComplete="street-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="例: 東京都○○区○○ 1-2-3 ○○ビル4F"
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="set-tel">
              TEL
            </label>
            <input
              id="set-tel"
              className="input"
              name="tel"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={tel}
              onChange={(e) => setTel(e.target.value)}
              placeholder="例: 03-1234-5678"
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="set-email">
              Email
            </label>
            <input
              id="set-email"
              className="input"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="例: info@example.co.jp"
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="set-regNumber">
              登録番号
            </label>
            <input
              id="set-regNumber"
              className="input"
              name="regNumber"
              type="text"
              autoComplete="off"
              value={regNumber}
              onChange={(e) => setRegNumber(e.target.value)}
              placeholder="T1234567890123"
            />
            <p className="hint">適格請求書発行事業者の登録番号（インボイス）。</p>
          </div>
        </section>

        {/* ── 振込先 ── */}
        <section className="mst-block">
          <h3 className="mst-block-title">振込先</h3>

          <div className="field">
            <label className="label" htmlFor="set-bankInfo">
              振込先
            </label>
            <input
              id="set-bankInfo"
              className="input"
              name="bankInfo"
              type="text"
              autoComplete="off"
              value={bankInfo}
              onChange={(e) => setBankInfo(e.target.value)}
              placeholder="○○銀行 ○○支店 普通 1234567 カ）○○コウムテン"
            />
            <p className="hint">銀行・支店・種別・番号・名義をまとめて入力します。</p>
          </div>
        </section>

        {/* ── 税設定 ── */}
        <section className="mst-block">
          <h3 className="mst-block-title">税設定</h3>

          <div className="field">
            <label className="label" htmlFor="set-taxPct">
              標準税率（%）
            </label>
            <input
              id="set-taxPct"
              className="input input--num"
              name="taxRatePct"
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              step={1}
              required
              value={taxPct}
              onChange={(e) => setTaxPct(e.target.value)}
              placeholder="10"
            />
            <p className="hint">請求書の消費税計算に使う標準税率（%）。</p>
          </div>
        </section>

        {/* ── 担当者 ── */}
        <section className="mst-block">
          <h3 className="mst-block-title">担当者</h3>

          <div className="field">
            <label className="label" htmlFor="set-contactName">
              担当者名
            </label>
            <input
              id="set-contactName"
              className="input"
              name="contactName"
              type="text"
              autoComplete="name"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="例: 山田 太郎"
            />
          </div>
        </section>

        {/* ── 入金確認リマインド（LINE） ── */}
        <section className="mst-block">
          <h3 className="mst-block-title">入金確認リマインド（LINE）</h3>

          <div className="field">
            <label className="inline-row" style={{ gap: 8 }}>
              <input
                type="checkbox"
                name="dueReminderEnabled"
                checked={reminderOn}
                onChange={(e) => setReminderOn(e.target.checked)}
              />
              <span>支払期限の当日にLINEで通知する</span>
            </label>
            <p className="hint">
              その日が支払期限（入金予定日）の請求書を、指定した管理者へbotからDMします。取引先名と金額が届きます。
            </p>
          </div>

          <div className="field">
            <label className="label" htmlFor="set-reminderHour">
              通知時刻
            </label>
            <select
              id="set-reminderHour"
              className="select"
              name="dueReminderHour"
              value={reminderHour}
              onChange={(e) => setReminderHour(e.target.value)}
              disabled={!reminderOn}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={String(h)}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </select>
            <p className="hint">毎日この時刻ごろに送ります（JST）。</p>
          </div>

          <div className="field">
            <label className="label" htmlFor="set-reminderUser">
              通知先の管理者
            </label>
            <select
              id="set-reminderUser"
              className="select"
              name="dueReminderUserId"
              value={reminderUserId}
              onChange={(e) => setReminderUserId(e.target.value)}
              disabled={!reminderOn}
            >
              <option value="">最高管理者（既定）</option>
              {admins.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </select>
            <p className="hint">
              通知先の管理者が、この公式アカウントを「友だち追加」している必要があります（未追加だと届きません）。
            </p>
          </div>
        </section>

        {/* ── プレビュー（入力に追従。請求書の差出人欄の見え方） ── */}
        <div className="mst-preview" aria-label="請求書プレビュー">
          <InvoicePreview
            issuerName={issuerName}
            address={address}
            tel={tel}
            email={email}
            regNumber={regNumber}
            bankInfo={bankInfo}
            pct={pctNum}
            contactName={contactName}
          />
        </div>

        <div className="field" style={{ marginTop: 16 }}>
          <button type="submit" className="btn btn--primary" disabled={pending}>
            {pending ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ============================================================
// 請求書プレビュー（差出人ブロックの簡易表示）
//   入力中の値がそのまま請求書のどこに載るかを示す。未入力はプレースホルダ風に
//   薄く「（未入力）」を出して、空欄が請求書に出てしまうことに気づけるようにする。
// ============================================================
function InvoicePreview({
  issuerName,
  address,
  tel,
  email,
  regNumber,
  bankInfo,
  pct,
  contactName,
}: {
  issuerName: string;
  address: string;
  tel: string;
  email: string;
  regNumber: string;
  bankInfo: string;
  pct: number;
  contactName: string;
}): JSX.Element {
  const muted: React.CSSProperties = { color: "var(--ink-3)" };
  const placeholder = (label: string) => <span style={muted}>（{label}）</span>;

  const telEmail = [tel.trim(), email.trim()].filter(Boolean).join("　/　");

  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.08em",
          color: "var(--ink-3)",
          marginBottom: 12,
        }}
      >
        請求書プレビュー
      </div>

      {/* 差出人（請求書右上に載る想定のブロック） */}
      <div style={{ lineHeight: 1.7 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "var(--ink)" }}>
          {issuerName.trim() || placeholder("会社名")}
        </div>
        <div>{address.trim() || placeholder("住所")}</div>
        {telEmail ? (
          <div style={{ color: "var(--ink-2)" }}>{telEmail}</div>
        ) : (
          <div>{placeholder("TEL / Email")}</div>
        )}
        <div style={{ color: "var(--ink-2)" }}>
          {regNumber.trim() ? `登録番号 ${regNumber.trim()}` : placeholder("登録番号")}
        </div>
        {contactName.trim() && (
          <div style={{ color: "var(--ink-2)" }}>担当 {contactName.trim()}</div>
        )}
      </div>

      {/* 金額欄の見え方（税率がどう効くか） */}
      <div
        style={{
          marginTop: 14,
          paddingTop: 12,
          borderTop: "1px solid var(--line)",
          display: "flex",
          justifyContent: "space-between",
          color: "var(--ink-2)",
        }}
      >
        <span>消費税（{Number.isFinite(pct) ? pct : 0}%）</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          小計 × {(Number.isFinite(pct) ? pct : 0) / 100}
        </span>
      </div>

      {/* 振込先（請求書下部に載る想定） */}
      <div
        style={{
          marginTop: 12,
          paddingTop: 12,
          borderTop: "1px solid var(--line)",
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-3)", marginBottom: 4 }}>
          お振込先
        </div>
        <div style={{ color: "var(--ink)" }}>
          {bankInfo.trim() || placeholder("振込先")}
        </div>
      </div>
    </div>
  );
}

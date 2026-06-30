"use client";

// ============================================================
// 集計画面のインライン単価エディタ（取引先 / 職人）
//   人工単価・残業単価（円/時）を入力して保存。空欄は「未設定」(null)。
//   保存はサーバアクション（ADMINガード）→ 月次集計キャッシュ無効化で即反映。
// ============================================================

import { useState, useTransition } from "react";
import { setClientRatesAction, setWorkerRatesAction } from "../_actions.js";

function toNullableInt(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  const n = Math.round(Number(t));
  return isFinite(n) && n >= 0 ? n : null;
}

export function RateEditor({
  kind,
  targetId,
  unitPrice,
  nightUnitPrice = null,
  otUnitPrice,
}: {
  kind: "client" | "worker";
  targetId: string;
  unitPrice: number | null;
  /** 取引先のみ: 夜勤単価。職人では使わない。 */
  nightUnitPrice?: number | null;
  otUnitPrice: number | null;
}) {
  const [unit, setUnit] = useState(unitPrice == null ? "" : String(unitPrice));
  const [night, setNight] = useState(
    nightUnitPrice == null ? "" : String(nightUnitPrice),
  );
  const [ot, setOt] = useState(otUnitPrice == null ? "" : String(otUnitPrice));
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);

  function save() {
    setDone(false);
    const u = toNullableInt(unit);
    const n = toNullableInt(night);
    const o = toNullableInt(ot);
    startTransition(async () => {
      if (kind === "client") {
        await setClientRatesAction(targetId, u, n, o);
      } else {
        await setWorkerRatesAction(targetId, u, o);
      }
      setDone(true);
    });
  }

  return (
    <div className="rate-editor">
      <label className="rate-field">
        <span className="rate-label">{kind === "client" ? "日勤単価" : "人工単価"}</span>
        <input
          className="input input--num"
          type="number"
          inputMode="numeric"
          min={0}
          placeholder="円"
          value={unit}
          onChange={(e) => {
            setUnit(e.target.value);
            setDone(false);
          }}
        />
      </label>
      {kind === "client" && (
        <label className="rate-field">
          <span className="rate-label">夜勤単価</span>
          <input
            className="input input--num"
            type="number"
            inputMode="numeric"
            min={0}
            placeholder="日勤と同じ"
            value={night}
            onChange={(e) => {
              setNight(e.target.value);
              setDone(false);
            }}
          />
        </label>
      )}
      <label className="rate-field">
        <span className="rate-label">残業単価/時</span>
        <input
          className="input input--num"
          type="number"
          inputMode="numeric"
          min={0}
          placeholder="自動"
          value={ot}
          onChange={(e) => {
            setOt(e.target.value);
            setDone(false);
          }}
        />
      </label>
      <button
        type="button"
        className="btn btn--sm"
        onClick={save}
        disabled={pending}
      >
        {pending ? "保存中…" : done ? "保存済み" : "保存"}
      </button>
    </div>
  );
}

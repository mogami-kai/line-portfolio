"use client";

// ============================================================
// 経費種別ピッカー（LIFF入力・管理の編集モーダル共通）
//   よく使う種別（パーキング/ガソリン/高速）はワンタップ選択。
//   「その他」を選んだ時だけ自由入力欄を出す（予測変換ミス防止と自由度の両立）。
// ============================================================

import { useState } from "react";

export const PRESET_EXPENSE_KINDS = ["パーキング", "ガソリン", "高速"] as const;

export function ExpenseKindPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  // 既存データが候補外（弁当など）なら「その他」選択状態で開く。
  const [other, setOther] = useState(
    () => value !== "" && !(PRESET_EXPENSE_KINDS as readonly string[]).includes(value),
  );

  return (
    <>
      <div className="kind-chips">
        {PRESET_EXPENSE_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className={`kind-chip ${!other && value === k ? "kind-chip--on" : ""}`}
            onClick={() => {
              setOther(false);
              onChange(k);
            }}
          >
            {k}
          </button>
        ))}
        <button
          type="button"
          className={`kind-chip ${other ? "kind-chip--on" : ""}`}
          onClick={() => {
            setOther(true);
            onChange(""); // 候補の値を引き継がず、空で自由入力を始める
          }}
        >
          その他
        </button>
      </div>
      {other && (
        <input
          className="input"
          type="text"
          placeholder="種別を入力（弁当など）"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ marginTop: 8 }}
        />
      )}
    </>
  );
}

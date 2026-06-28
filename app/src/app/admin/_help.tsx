"use client";

// ============================================================
// ❓ヘルプ トグル（コーチマーク）
//   押すと <html> に .help-on を付与し、ページ内の各 .help-bubble（吹き出し）が
//   一斉に表示される（位置計算なしの CSS リビールで堅牢）。もう一度押す/離脱で消える。
//   サーバーコンポーネントのページに「説明の出し入れ」だけを足す最小のクライアント部品。
// ============================================================

import { useEffect, useState } from "react";

export function HelpToggle({ label = "使い方" }: { label?: string }) {
  const [on, setOn] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle("help-on", on);
    return () => document.documentElement.classList.remove("help-on");
  }, [on]);

  return (
    <button
      type="button"
      className={`help-toggle ${on ? "help-toggle--on" : ""}`}
      onClick={() => setOn((v) => !v)}
      aria-pressed={on}
    >
      {on ? "説明を閉じる" : label}
    </button>
  );
}

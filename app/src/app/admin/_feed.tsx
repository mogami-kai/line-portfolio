"use client";

// ============================================================
// 直近の出面フィード（コンパクト3列＋「表示」で当月全件）
//   サーバーから当月の出面（プレーン配列）を受け取り、最初の数件だけ3列で表示。
//   「表示」を押すとその月の全件を展開（もう一度で畳む）。
// ============================================================

import { useState } from "react";

export interface FeedItem {
  id: string;
  date: string; // "M/D(曜)"
  client: string;
  site: string;
  names: string;
  md: number;
  ot: number;
  partner: boolean;
  review: boolean;
}

export function RecentFeed({
  items,
  initial = 9,
}: {
  items: FeedItem[];
  initial?: number;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, initial);

  return (
    <>
      <div className="feed-grid">
        {shown.map((r) => (
          <div className="feed-cell" key={r.id}>
            <div className="feed-date">{r.date}</div>
            <div className="feed-client">
              {r.client}
              {r.review && <span className="badge badge--review feed-mini">要</span>}
              {r.partner && <span className="badge badge--partner feed-mini">協</span>}
            </div>
            <div className="feed-site">{r.site}</div>
            {r.names && <div className="feed-names">{r.names}</div>}
            <div className="feed-figs">
              <b>{r.md}</b>人工
              {r.ot > 0 && <span className="feed-ot"> ・残{r.ot}h</span>}
            </div>
          </div>
        ))}
      </div>
      {items.length > initial && (
        <button
          type="button"
          className="btn btn--ghost btn--sm feed-toggle"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
        >
          {all ? "閉じる" : `その月の全 ${items.length} 件を表示`}
        </button>
      )}
    </>
  );
}

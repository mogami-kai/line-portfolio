"use client";

// ============================================================
// 現場ピッカー（LIFF入力フォーム用・スマホ片手操作）
//   全件チップ表示をやめ、初期は「ピン→最近→よく使う」の先頭10件のみ。
//   それ以上は検索で。さらに「＋現場を追加（通常／今回だけ＝スポット）」。
//   サーバ(api/masters)が既に pinned→lastUsedAt→usageCount→name で整列して返すため、
//   初期表示は先頭スライスでよい。選択中の現場は一覧外でも必ず先頭に出す。
// ============================================================

import { useMemo, useState } from "react";

export interface PickerSite {
  id: string;
  name: string;
  isPinned?: boolean;
  usageCount?: number;
  lastUsedAt?: string | null;
}

const INITIAL_MAX = 10; // 初期表示チップの上限（チップ氾濫の防止）
const SEARCH_MAX = 24; // 検索結果の上限

export function SitePicker({
  sites,
  siteId,
  setSiteId,
  newSiteName,
  setNewSiteName,
  newSiteTemporary,
  setNewSiteTemporary,
  showNewSite,
  setShowNewSite,
  disabled,
}: {
  sites: PickerSite[];
  siteId: string;
  setSiteId: (id: string) => void;
  newSiteName: string;
  setNewSiteName: (s: string) => void;
  newSiteTemporary: boolean;
  setNewSiteTemporary: (b: boolean) => void;
  showNewSite: boolean;
  setShowNewSite: (b: boolean) => void;
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!query) return [];
    return sites.filter((s) => s.name.toLowerCase().includes(query)).slice(0, SEARCH_MAX);
  }, [sites, query]);

  // 初期表示はサーバ整列済みの先頭 INITIAL_MAX 件。
  const initial = useMemo(() => sites.slice(0, INITIAL_MAX), [sites]);

  const base = query ? filtered : initial;
  const selected = sites.find((s) => s.id === siteId);
  // 選択中が一覧に無ければ先頭に差し込み、必ず見えるように。
  const shown =
    selected && !base.some((s) => s.id === selected.id) ? [selected, ...base] : base;

  const hiddenCount = query ? 0 : Math.max(0, sites.length - initial.length);

  const pick = (id: string) => {
    setSiteId(siteId === id ? "" : id);
    setShowNewSite(false);
    setNewSiteName("");
  };

  return (
    <div className="field">
      <label className="label">現場</label>

      {sites.length > INITIAL_MAX && (
        <input
          className="input site-search"
          type="search"
          inputMode="search"
          placeholder="現場を検索"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={disabled}
        />
      )}

      <div className="chip-wrap">
        {shown.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`chip ${siteId === s.id ? "chip--on" : ""}`}
            onClick={() => pick(s.id)}
            disabled={disabled}
          >
            {s.isPinned ? "📌 " : ""}
            {s.name}
          </button>
        ))}
        <button
          type="button"
          className={`chip chip--add ${showNewSite ? "chip--on" : ""}`}
          onClick={() => {
            setShowNewSite(!showNewSite);
            setSiteId("");
          }}
          disabled={disabled}
        >
          ＋ 現場を追加
        </button>
      </div>

      {query && filtered.length === 0 && !showNewSite && (
        <p className="hint">
          「{q.trim()}」に一致する現場がありません。「＋ 現場を追加」で登録できます。
        </p>
      )}
      {!query && hiddenCount > 0 && (
        <p className="hint">ほか {hiddenCount} 件。見つからないときは検索してください。</p>
      )}

      {showNewSite && (
        <div className="site-new">
          <input
            className="input"
            type="text"
            placeholder="新しい現場名を入力"
            value={newSiteName}
            onChange={(e) => setNewSiteName(e.target.value)}
          />
          <label className="site-spot">
            <input
              type="checkbox"
              checked={newSiteTemporary}
              onChange={(e) => setNewSiteTemporary(e.target.checked)}
            />
            今回だけ（スポット現場・一覧に残さない）
          </label>
          <p className="hint">
            {newSiteTemporary
              ? "スポット現場として登録します。一覧には残らず、管理者の確認後に正式な現場にできます。"
              : "通常の現場として登録します。次回からこの一覧に出ます。"}
          </p>
        </div>
      )}
    </div>
  );
}

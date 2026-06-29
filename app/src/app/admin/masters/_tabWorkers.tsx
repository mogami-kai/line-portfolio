"use client";

// ============================================================
// /admin/masters — 職人タブ（実装）
//
//   freee / マネーフォワード 風。1ページ縦羅列をやめ、一覧中心＋ドロワー編集。
//   ・上部 .mst-toolbar：職人名で絞り込む検索 ＋「職人を追加」ボタン（primary）。
//   ・所属（自社 SELF / 協力会社 PARTNER）でグループ表示。協力会社は会社ごとに
//     小見出しを分ける。各見出しに「有効 n 人」を出す。
//   ・一覧の各行は薄く（大きなアコーディオン禁止）。
//       PC（>=641px）: table.mst-table（氏名 / 所属 / 状態）
//       スマホ（<=640px）: .mst-card（main=氏名 / meta=「自社 / 有効」）
//     行タップで編集ドロワーを開く（一覧の中にフォームを展開しない）。
//   ・追加 / 編集はすべて Drawer の中。Server Action は "../_actions.js" を再利用。
//
//   ※ 凍結 CSS クラスのみ使用。グループ見出し等、凍結クラスに無い構造の余白は
//     CSS 変数を参照したインラインスタイルで最小限に補う（globals.css は触らない）。
//   ※ WorkerRow は別名（aliases）を持たないため、編集ドロワーの別名欄は空から始まる。
//     送信すると別名は入力値で上書きされる旨を hint で明示する（取り違え防止）。
// ============================================================

import { useMemo, useState, useTransition } from "react";
import type { JSX, CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { Drawer } from "./_drawer.js";
import type { WorkerRow, OrgRow } from "./_mastersTypes.js";
import {
  createWorkerAction,
  updateWorkerAction,
  setWorkerActiveAction,
  deleteWorkerAction,
} from "../_actions.js";
import { ConfirmDeleteButton } from "../_confirmDelete.js";

/** 種別ラベル（英語表記は画面に出さない）。 */
function kindLabel(kind: "SELF" | "PARTNER"): string {
  return kind === "SELF" ? "自社" : "協力会社";
}

// 凍結クラスに無い構造の余白だけ、CSS 変数を参照したインラインで補う。
const groupStyle: CSSProperties = { marginBottom: 24 };
const groupHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  margin: "0 0 8px",
};
const groupNameStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 800,
  color: "var(--ink)",
};
const groupCountStyle: CSSProperties = {
  marginLeft: "auto",
  fontSize: 12,
  color: "var(--ink-2)",
  fontVariantNumeric: "tabular-nums",
};
const rowClickStyle: CSSProperties = { cursor: "pointer" };
const checkRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 14,
  color: "var(--ink)",
  cursor: "pointer",
};
const auxStyle: CSSProperties = {
  marginTop: 8,
  paddingTop: 16,
  borderTop: "1px solid var(--line)",
};

/** 1グループ＝1組織分の職人。表示順は自社→協力会社、同種は組織名で安定化。 */
interface Group {
  orgId: string;
  orgName: string;
  orgKind: "SELF" | "PARTNER";
  rows: WorkerRow[];
  activeCount: number;
}

export function WorkersTab({
  workers,
  orgs,
}: {
  workers: WorkerRow[];
  orgs: OrgRow[];
}): JSX.Element {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState("");

  // 検索（職人は別名を props に持たないので氏名のみで絞り込む）。
  const [q, setQ] = useState("");

  // ドロワー: "add"＝追加 / WorkerRow＝その行の編集 / null＝閉。
  const [editing, setEditing] = useState<WorkerRow | "add" | null>(null);
  const open = editing !== null;
  const isAdd = editing === "add";
  const row = editing === "add" ? null : editing;

  function closeDrawer(): void {
    setEditing(null);
    setErr("");
  }

  function openAdd(): void {
    setErr("");
    setEditing("add");
  }

  function openEdit(w: WorkerRow): void {
    setErr("");
    setEditing(w);
  }

  // 追加ドロワーの所属（select）。自社→協力会社、同種は名前順。
  const addableOrgs = useMemo(
    () =>
      [...orgs].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "SELF" ? -1 : 1;
        return a.name.localeCompare(b.name, "ja");
      }),
    [orgs],
  );

  // 絞り込み後を組織ごとにグルーピング（自社→協力会社、組織名で安定）。
  const groups = useMemo<Group[]>(() => {
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? workers.filter((w) => w.name.toLowerCase().includes(needle))
      : workers;

    const map = new Map<string, Group>();
    for (const w of filtered) {
      let g = map.get(w.orgId);
      if (!g) {
        g = {
          orgId: w.orgId,
          orgName: w.orgName,
          orgKind: w.orgKind,
          rows: [],
          activeCount: 0,
        };
        map.set(w.orgId, g);
      }
      g.rows.push(w);
      if (w.active) g.activeCount += 1;
    }

    const list = [...map.values()];
    for (const g of list) {
      g.rows.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    }
    list.sort((a, b) => {
      if (a.orgKind !== b.orgKind) return a.orgKind === "SELF" ? -1 : 1;
      return a.orgName.localeCompare(b.orgName, "ja");
    });
    return list;
  }, [workers, q]);

  const totalActive = useMemo(
    () => workers.filter((w) => w.active).length,
    [workers],
  );

  // ── 追加（createWorkerAction） ──
  function submitAdd(fd: FormData): void {
    start(async () => {
      try {
        await createWorkerAction(fd);
        router.refresh();
        closeDrawer();
      } catch (e) {
        setErr(String((e as Error).message || e));
      }
    });
  }

  // ── 編集（updateWorkerAction） ──
  function submitEdit(fd: FormData): void {
    start(async () => {
      try {
        await updateWorkerAction(fd);
        router.refresh();
        closeDrawer();
      } catch (e) {
        setErr(String((e as Error).message || e));
      }
    });
  }

  // ── 有効/無効トグル（setWorkerActiveAction）。送信後に閉じる。 ──
  function submitToggleActive(fd: FormData): void {
    start(async () => {
      try {
        await setWorkerActiveAction(fd);
        router.refresh();
        closeDrawer();
      } catch (e) {
        setErr(String((e as Error).message || e));
      }
    });
  }

  const hasWorkers = workers.length > 0;

  return (
    <div>
      {/* 検索 ＋ 追加 */}
      <div className="mst-toolbar">
        <input
          type="search"
          className="mst-search"
          placeholder="職人名で絞り込み"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="職人名で絞り込み"
        />
        <button type="button" className="mst-add" onClick={openAdd}>
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          職人を追加
        </button>
      </div>

      <div className="mst-counts">
        <span className="mst-count">
          登録 <b>{workers.length}</b> 人
        </span>
        <span className="mst-count">
          有効 <b>{totalActive}</b> 人
        </span>
      </div>

      {!hasWorkers && (
        <div className="mst-empty">
          まだ職人が登録されていません。「職人を追加」から登録してください。
        </div>
      )}

      {hasWorkers && groups.length === 0 && (
        <div className="mst-empty">「{q}」に一致する職人はいません。</div>
      )}

      {groups.map((g) => (
        <section key={g.orgId} style={groupStyle}>
          <h3 style={groupHeadStyle}>
            <span style={groupNameStyle}>{g.orgName}</span>
            <span
              className={`badge ${
                g.orgKind === "SELF" ? "badge--self" : "badge--partner"
              }`}
            >
              {kindLabel(g.orgKind)}
            </span>
            <span style={groupCountStyle}>有効 {g.activeCount} 人</span>
          </h3>

          {/* PC: テーブル（氏名 / 所属 / 状態）。行タップで編集。 */}
          <div className="mst-table-wrap">
            <table className="mst-table">
              <thead>
                <tr>
                  <th>氏名</th>
                  <th>所属</th>
                  <th>状態</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((w) => (
                  <tr
                    key={w.id}
                    onClick={() => openEdit(w)}
                    style={rowClickStyle}
                  >
                    <td>{w.name}</td>
                    <td>{g.orgName}</td>
                    <td>
                      {w.active ? (
                        <span className="badge badge--self">有効</span>
                      ) : (
                        <span className="badge">無効</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* スマホ: コンパクトカード（行タップで編集）。 */}
          <div className="mst-cards">
            {g.rows.map((w) => (
              <button
                key={w.id}
                type="button"
                className="mst-card"
                onClick={() => openEdit(w)}
              >
                <span className="mst-card-main">{w.name}</span>
                <span className="mst-card-meta">
                  {kindLabel(w.orgKind)} / {w.active ? "有効" : "無効"}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}

      {/* ── ドロワー（追加 / 編集を1つで使い回す） ── */}
      <Drawer
        open={open}
        title={isAdd ? "職人を追加" : "職人を編集"}
        onClose={closeDrawer}
        footer={
          <>
            <button
              type="submit"
              form="worker-form"
              className="btn btn--primary"
              disabled={pending}
            >
              {pending ? "保存中…" : isAdd ? "追加する" : "保存する"}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={closeDrawer}
              disabled={pending}
            >
              キャンセル
            </button>
          </>
        }
      >
        {err && (
          <div className="notice notice--error" role="alert">
            {err}
          </div>
        )}

        {isAdd ? (
          <form id="worker-form" action={submitAdd}>
            <div className="field">
              <label className="label" htmlFor="w-org">
                所属
              </label>
              <select
                id="w-org"
                name="orgId"
                className="select"
                defaultValue={addableOrgs[0]?.id ?? ""}
                required
              >
                {addableOrgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}（{kindLabel(o.kind)}）
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="label" htmlFor="w-name">
                職人名
              </label>
              <input
                id="w-name"
                name="name"
                className="input"
                type="text"
                autoComplete="off"
                required
              />
            </div>

            <div className="field">
              <label className="label" htmlFor="w-aliases">
                別名（任意）
              </label>
              <input
                id="w-aliases"
                name="aliases"
                className="input"
                type="text"
                autoComplete="off"
                placeholder="例: たろう、田中太郎"
              />
              <p className="hint">
                出面入力での表記ゆれを吸収します。読点・カンマ・改行で区切って複数登録できます。
              </p>
            </div>
          </form>
        ) : (
          row && (
            <>
              <form id="worker-form" action={submitEdit}>
                <input type="hidden" name="id" value={row.id} />

                <div className="field">
                  <label className="label" htmlFor="w-name-e">
                    職人名
                  </label>
                  <input
                    id="w-name-e"
                    name="name"
                    className="input"
                    type="text"
                    autoComplete="off"
                    defaultValue={row.name}
                    required
                  />
                </div>

                <div className="field">
                  <label className="label" htmlFor="w-aliases-e">
                    別名（任意）
                  </label>
                  <input
                    id="w-aliases-e"
                    name="aliases"
                    className="input"
                    type="text"
                    autoComplete="off"
                    placeholder="例: たろう、田中太郎"
                  />
                  <p className="hint">
                    保存すると別名はこの入力内容で置き換わります。空のまま保存すると別名は消去されます。
                  </p>
                </div>

                <div className="field">
                  <label style={checkRowStyle}>
                    <input
                      type="checkbox"
                      name="active"
                      value="on"
                      defaultChecked={row.active}
                    />
                    <span>有効（出面入力の選択肢に表示する）</span>
                  </label>
                </div>

                <p className="hint">
                  所属（{kindLabel(row.orgKind)}・{row.orgName}）は変更できません。
                </p>
              </form>

              {/* 有効/無効トグル（setWorkerActiveAction）。別フォームで即時切替。 */}
              <div style={auxStyle}>
                <form action={submitToggleActive}>
                  <input type="hidden" name="id" value={row.id} />
                  <input
                    type="hidden"
                    name="active"
                    value={row.active ? "false" : "true"}
                  />
                  {row.active ? (
                    <button
                      type="submit"
                      className="btn btn--danger-text"
                      disabled={pending}
                    >
                      無効化（出面入力の選択肢から外す）
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className="btn btn--ghost btn--sm"
                      disabled={pending}
                    >
                      有効化する
                    </button>
                  )}
                </form>
                <p className="hint">
                  無効化しても過去の出面記録は残ります。再び有効化すれば選択肢に戻ります。
                </p>
              </div>

              {/* 完全削除（deleteWorkerAction）。出面に未使用のときだけ可能。 */}
              <div style={auxStyle}>
                <ConfirmDeleteButton
                  action={deleteWorkerAction}
                  id={row.id}
                  label="完全に削除"
                  confirmText="この職人を完全に削除します（出面に未使用の場合のみ）。よろしいですか？"
                />
                <p className="hint">
                  無効化＝出面記録は残す / 完全削除＝出面に未使用のときだけ可能。出面で使用中の職人は削除できません（無効化してください）。
                </p>
              </div>
            </>
          )
        )}
      </Drawer>
    </div>
  );
}

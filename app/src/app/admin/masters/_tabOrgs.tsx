"use client";

// ============================================================
// /admin/masters — 自社・協力会社タブ（実装）
//
//   freee / マネーフォワード 風。一覧中心 ＋ ドロワー編集。
//   ・「組織」という英語/内部語は画面に出さない（自社 / 協力会社で表記）。
//   ・追加できるのは協力会社（PARTNER）のみ。自社（SELF）はここから作らない
//     （自社は通常1つ）。ただし自社が重複している場合に片方を掃除できるよう、
//     自社も協力会社と同じく行クリックで編集ドロワーを開け、削除もできる。
//       自社＝出面が自社グループに自動投稿される入力元。
//       協力会社＝管理画面の集計のみに使う相手先。
//   ・上部に短い説明 ＋ .mst-toolbar の右に「協力会社を追加」（primary）。
//   ・一覧: PC は table.mst-table（組織名 / 種別 / 状態）、
//     スマホは .mst-cards のコンパクトカード。自社・協力会社いずれの行も
//     タップで編集ドロワーを開く。
//   ・追加 / 編集はすべて Drawer の中（一覧の中にフォームを展開しない）。
//
//   Server Action は ../_actions.js を再利用（DB / ロジックは変更しない）。
//   追加は kind=PARTNER 固定で createOrganizationAction、編集は
//   updateOrganizationAction（name ＋ active ＋ hidden id）。種別（SELF/PARTNER）
//   は不可逆のため編集UIには出さない。削除は deleteOrganizationAction で、
//   編集ドロワー footer の ConfirmDeleteButton から呼ぶ（確認必須）。
//   ユーザー/職人/出面が紐づく組織はアクション側が日本語 throw → ボタンが
//   alert 表示するので、UI 側で件数判定はしない（無効化トグルは併設）。
//   送信は <form action={submit}> のラッパ内でアクションに FormData を渡し、
//   成功で router.refresh()＋ドロワーを閉じる。
// ============================================================

import type { JSX } from "react";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Drawer } from "./_drawer.js";
import type { OrgRow } from "./_mastersTypes.js";
import { ConfirmDeleteButton } from "../_confirmDelete.js";
import {
  createOrganizationAction,
  updateOrganizationAction,
  deleteOrganizationAction,
} from "../_actions.js";

/** 種別ラベル（英語表記は画面に出さない）。 */
function kindLabel(kind: "SELF" | "PARTNER"): string {
  return kind === "SELF" ? "自社" : "協力会社";
}

export function OrgsTab({ orgs }: { orgs: OrgRow[] }): JSX.Element {
  // ドロワー: "add"＝協力会社を追加 / OrgRow＝その協力会社を編集 / null＝閉。
  const [editing, setEditing] = useState<OrgRow | "add" | null>(null);

  // 自社→協力会社の順、同種は組織名で安定化。
  const sorted = useMemo(
    () =>
      [...orgs].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "SELF" ? -1 : 1;
        return a.name.localeCompare(b.name, "ja");
      }),
    [orgs],
  );

  const counts = useMemo(() => {
    let self = 0;
    let partner = 0;
    for (const o of orgs) {
      if (o.kind === "SELF") self += 1;
      else partner += 1;
    }
    return { self, partner };
  }, [orgs]);

  return (
    <div>
      {/* ツールバー: 説明は上にあるので、ここは右側の「協力会社を追加」のみ。
          検索欄が無いので marginLeft:auto で右寄せ（.mst-toolbar は flex）。 */}
      <div className="mst-toolbar">
        <button
          type="button"
          className="mst-add"
          style={{ marginLeft: "auto" }}
          onClick={() => setEditing("add")}
        >
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
          協力会社を追加
        </button>
      </div>

      <div className="mst-counts">
        <span className="mst-count">
          自社 <b>{counts.self}</b> 件
        </span>
        <span className="mst-count">
          協力会社 <b>{counts.partner}</b> 件
        </span>
      </div>

      {sorted.length === 0 ? (
        <div className="mst-empty">
          自社・協力会社がまだありません。「協力会社を追加」から登録してください。
        </div>
      ) : (
        <>
          {/* PC: テーブル（組織名 / 種別 / 状態）。自社・協力会社いずれの行もクリックで編集。 */}
          <div className="mst-table-wrap">
            <table className="mst-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>種別</th>
                  <th>状態</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((o) => {
                  const isSelf = o.kind === "SELF";
                  return (
                    <tr
                      key={o.id}
                      onClick={() => setEditing(o)}
                      style={{ cursor: "pointer" }}
                    >
                      <td>{o.name}</td>
                      <td>
                        <span
                          className={`badge ${
                            isSelf ? "badge--self" : "badge--partner"
                          }`}
                        >
                          {kindLabel(o.kind)}
                        </span>
                      </td>
                      <td>
                        {o.active ? (
                          <span className="badge badge--self">有効</span>
                        ) : (
                          <span className="badge">無効</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* スマホ: コンパクトカード。自社・協力会社いずれもタップで編集ドロワー。 */}
          <div className="mst-cards">
            {sorted.map((o) => {
              const sub = `${kindLabel(o.kind)} / ${o.active ? "有効" : "無効"}`;
              return (
                <button
                  key={o.id}
                  type="button"
                  className="mst-card"
                  onClick={() => setEditing(o)}
                >
                  <span className="mst-card-main">
                    {o.name}
                    <span className="mst-card-sub">{sub}</span>
                  </span>
                  <span className="mst-card-meta">編集</span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {editing !== null && (
        <OrgDrawer
          row={editing === "add" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

// ============================================================
// 追加 / 編集ドロワー
//   row=null は協力会社の追加（kind=PARTNER 固定で createOrganizationAction）、
//   row 指定は編集（updateOrganizationAction。name ＋ active ＋ hidden id）。
//   種別（SELF/PARTNER）は不可逆なので編集UIには出さない（hint で明示）。
//   編集時は footer に削除（deleteOrganizationAction）を併設。確認必須。
//   ユーザー/職人/出面が紐づく組織はアクション側が日本語 throw → 無効化へ誘導。
//   自社（SELF）も編集・削除の対象（重複自社の片方を掃除できる）。
//   送信は <form action={submit}>。成功で router.refresh()→onClose()。
// ============================================================
function OrgDrawer({
  row,
  onClose,
}: {
  row: OrgRow | null;
  onClose: () => void;
}): JSX.Element {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const isEdit = row !== null;

  function submit(fd: FormData): void {
    setErr(null);
    start(async () => {
      try {
        if (isEdit) await updateOrganizationAction(fd);
        else await createOrganizationAction(fd);
        router.refresh();
        onClose();
      } catch (e) {
        setErr(String((e as Error).message || e));
      }
    });
  }

  return (
    <Drawer
      open
      title={
        isEdit
          ? `${kindLabel(row.kind)}を編集`
          : "協力会社を追加"
      }
      onClose={onClose}
      footer={
        <>
          {/* 編集時のみ削除を併設。左寄せの危険操作 ＋ 右に保存/キャンセル。
              FK 参照がある組織は action 側が日本語 throw → 無効化へ誘導される。 */}
          {isEdit && (
            <ConfirmDeleteButton
              action={deleteOrganizationAction}
              id={row.id}
              confirmText="この組織を削除します。よろしいですか？（取り消せません）"
            />
          )}
          <button
            type="submit"
            form="org-form"
            className="btn btn--primary"
            disabled={pending}
            style={isEdit ? { marginLeft: "auto" } : undefined}
          >
            {pending ? "保存中…" : isEdit ? "保存する" : "追加する"}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            disabled={pending}
          >
            キャンセル
          </button>
        </>
      }
    >
      <form id="org-form" action={submit}>
        {isEdit ? (
          <input type="hidden" name="id" value={row.id} />
        ) : (
          // 追加は協力会社のみ。種別は PARTNER 固定（自社はここから作らない）。
          <input type="hidden" name="kind" value="PARTNER" />
        )}

        {err && (
          <div className="notice notice--error" role="alert">
            {err}
          </div>
        )}

        <div className="field">
          <label className="label" htmlFor="org-name">
            名称
          </label>
          <input
            id="org-name"
            className="input"
            name="name"
            type="text"
            autoComplete="off"
            required
            defaultValue={row?.name ?? ""}
            placeholder="例: ○○工業"
          />
        </div>

        {isEdit && (
          <div className="field">
            <label className="inline-row" style={{ gap: 8 }}>
              <input
                type="checkbox"
                name="active"
                value="on"
                defaultChecked={row.active}
              />
              <span>有効（集計の対象に含める）</span>
            </label>
          </div>
        )}

        <p className="hint">
          {isEdit
            ? `種別（${kindLabel(row.kind)}）は変更できません。${
                row.kind === "SELF"
                  ? "自社は出面が自社グループへ自動投稿される入力元です。"
                  : "協力会社は管理画面の集計のみに使います。"
              }`
            : "協力会社として登録します。種別は協力会社で固定です（自社はここから追加できません）。"}
        </p>
      </form>
    </Drawer>
  );
}

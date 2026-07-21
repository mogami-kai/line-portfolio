"use client";

// ============================================================
// /admin/masters — 取引先タブ
//
//   freee / マネーフォワード 風。一覧中心 ＋ ドロワー編集。
//   ・.mst-toolbar: 取引先名で絞り込み（部分一致）＋「取引先を追加」ボタン。
//   ・.mst-counts: 有効 / 無効 / 単価未設定 の件数サマリー。
//   ・一覧: PC は table.mst-table（取引先名 / 敬称 / 常用単価 / 状態）、
//     スマホは .mst-cards のコンパクトカード。どちらも行クリックで編集ドロワー。
//   ・追加/編集は必ず Drawer の中で行う（一覧の中にフォームを展開しない）。
//
//   Server Action は ../_actions.js を再利用（DB/ロジックは変更しない）。
//   送信は <form action={submit}> のラッパ内で create/updateClientAction に
//   FormData を渡し、成功で router.refresh()＋ドロワーを閉じる。
// ============================================================

import type { JSX } from "react";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Drawer } from "./_drawer.js";
import type { ClientRow } from "./_mastersTypes.js";
import {
  createClientAction,
  deleteClientAction,
  updateClientAction,
} from "../_actions.js";
import { ConfirmDeleteButton } from "../_confirmDelete.js";

/** 常用単価の表示（円。未設定は「未設定」）。 */
function priceLabel(unitPrice: number | null): string {
  return unitPrice != null ? `¥${unitPrice.toLocaleString()}` : "未設定";
}

/** 支払期限の表示（翌月の何日か。null=末日）。 */
function paymentLabel(paymentDay: number | null): string {
  return paymentDay == null ? "翌月末" : `翌月${paymentDay}日`;
}

/** 支払期限プルダウンの選択肢（翌月の日）。空＝末日。 */
const PAYMENT_DAY_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "翌月末（末日）" },
  { value: "5", label: "翌月5日" },
  { value: "10", label: "翌月10日" },
  { value: "15", label: "翌月15日" },
  { value: "20", label: "翌月20日" },
  { value: "25", label: "翌月25日" },
];

export function ClientsTab({ clients }: { clients: ClientRow[] }): JSX.Element {
  // 絞り込みキーワード（取引先名の部分一致・大文字小文字を無視）。
  const [q, setQ] = useState("");
  // ドロワー: null=閉じている / "new"=追加 / ClientRow=その行を編集。
  const [editing, setEditing] = useState<ClientRow | "new" | null>(null);

  const counts = useMemo(() => {
    let active = 0;
    let inactive = 0;
    let noPrice = 0;
    for (const c of clients) {
      if (c.active) active += 1;
      else inactive += 1;
      if (c.unitPrice == null) noPrice += 1;
    }
    return { active, inactive, noPrice };
  }, [clients]);

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return clients;
    return clients.filter((c) => c.name.toLowerCase().includes(kw));
  }, [clients, q]);

  return (
    <div>
      <div className="mst-toolbar">
        <input
          type="search"
          className="mst-search"
          placeholder="取引先名で絞り込み"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="取引先名で絞り込み"
        />
        <button
          type="button"
          className="mst-add"
          onClick={() => setEditing("new")}
        >
          取引先を追加
        </button>
      </div>

      <div className="mst-counts">
        <span className="mst-count">
          有効 <b>{counts.active}</b> 件
        </span>
        <span className="mst-count">
          無効 <b>{counts.inactive}</b> 件
        </span>
        <span className="mst-count">
          単価未設定 <b>{counts.noPrice}</b> 件
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="mst-empty">
          {clients.length === 0
            ? "取引先がまだありません。「取引先を追加」から登録してください。"
            : "該当する取引先がありません。"}
        </div>
      ) : (
        <>
          {/* PC: テーブル（>=641px で表示）。行クリックで編集ドロワー。 */}
          <div className="mst-table-wrap">
            <table className="mst-table">
              <thead>
                <tr>
                  <th>取引先名</th>
                  <th>敬称</th>
                  <th className="mst-c-num">常用単価</th>
                  <th>支払期限</th>
                  <th>状態</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setEditing(c)}
                    style={{ cursor: "pointer" }}
                  >
                    <td>{c.name}</td>
                    <td>{c.honorific}</td>
                    <td className="mst-c-num">{priceLabel(c.unitPrice)}</td>
                    <td>{paymentLabel(c.paymentDay)}</td>
                    <td>
                      <span
                        className={`badge ${c.active ? "badge--self" : "badge--partner"}`}
                      >
                        {c.active ? "有効" : "無効"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* スマホ: コンパクトカード（<=640px で表示）。タップで編集ドロワー。 */}
          <div className="mst-cards">
            {filtered.map((c) => (
              <button
                key={c.id}
                type="button"
                className="mst-card"
                onClick={() => setEditing(c)}
              >
                <span className="mst-card-main">
                  {c.name}
                  <span className="mst-card-sub">
                    {`${c.honorific} / 常用単価 ${priceLabel(c.unitPrice)} / 支払 ${paymentLabel(c.paymentDay)} / ${c.active ? "有効" : "無効"}`}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {editing !== null && (
        <ClientDrawer
          row={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

// ============================================================
// 追加/編集ドロワー
//   row=null は追加（createClientAction）、row 指定は編集（updateClientAction）。
//   送信は <form action={submit}>。成功で router.refresh()→onClose()。
// ============================================================
function ClientDrawer({
  row,
  onClose,
}: {
  row: ClientRow | null;
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
        if (isEdit) await updateClientAction(fd);
        else await createClientAction(fd);
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
      title={isEdit ? "取引先を編集" : "取引先を追加"}
      onClose={onClose}
      footer={
        <>
          <button
            type="submit"
            form="client-form"
            className="btn btn--primary"
            disabled={pending}
          >
            {pending ? "保存中…" : "保存"}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            disabled={pending}
          >
            キャンセル
          </button>
          {isEdit && row !== null && (
            <ConfirmDeleteButton
              action={deleteClientAction}
              id={row.id}
              confirmText="この取引先を削除します。関連する現場/単価も消えます。よろしいですか？"
            />
          )}
        </>
      }
    >
      <form id="client-form" action={submit}>
        {isEdit && <input type="hidden" name="id" value={row.id} />}

        {err && (
          <div className="notice notice--error" role="alert">
            {err}
          </div>
        )}

        <div className="field">
          <label className="label" htmlFor="client-name">
            取引先名
          </label>
          <input
            id="client-name"
            className="input"
            name="name"
            type="text"
            required
            defaultValue={row?.name ?? ""}
            placeholder="例: 株式会社○○建設"
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="client-honorific">
            敬称
          </label>
          <select
            id="client-honorific"
            className="select"
            name="honorific"
            defaultValue={row?.honorific ?? "様"}
          >
            <option value="御中">御中</option>
            <option value="様">様</option>
          </select>
        </div>

        <div className="field">
          <label className="label" htmlFor="client-address">
            住所
          </label>
          <input
            id="client-address"
            className="input"
            name="address"
            type="text"
            defaultValue={row?.address ?? ""}
            placeholder="任意"
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="client-unitPrice">
            日勤単価
          </label>
          <input
            id="client-unitPrice"
            className="input input--num"
            name="unitPrice"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            defaultValue={row?.unitPrice != null ? String(row.unitPrice) : ""}
            placeholder="任意（円）"
          />
          <p className="hint">日勤1人工あたりの単価（円）。半日はこの単価×0.5。未入力なら未設定。</p>
        </div>

        <div className="field">
          <label className="label" htmlFor="client-nightUnitPrice">
            夜勤単価
          </label>
          <input
            id="client-nightUnitPrice"
            className="input input--num"
            name="nightUnitPrice"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            defaultValue={
              row?.nightUnitPrice != null ? String(row.nightUnitPrice) : ""
            }
            placeholder="任意（円）"
          />
          <p className="hint">夜勤1人工あたりの単価（円）。未入力なら日勤単価を使います。</p>
        </div>

        <div className="field">
          <label className="label" htmlFor="client-otUnitPrice">
            残業単価
          </label>
          <input
            id="client-otUnitPrice"
            className="input input--num"
            name="otUnitPrice"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            defaultValue={
              row?.otUnitPrice != null ? String(row.otUnitPrice) : ""
            }
            placeholder="任意（円/時）"
          />
          <p className="hint">残業1時間あたりの単価（円）。未入力なら日勤単価÷8×1.25で自動計算。</p>
        </div>

        <div className="field">
          <label className="label" htmlFor="client-billingMode">
            請求方式
          </label>
          <select
            id="client-billingMode"
            className="select"
            name="billingMode"
            defaultValue={row?.billingMode ?? "AGGREGATE"}
          >
            <option value="AGGREGATE">集約（委託料を日勤・夜勤・残業でまとめる）</option>
            <option value="PER_SITE">現場ごと（現場名ごとに1行で請求）</option>
          </select>
          <p className="hint">請求書の明細の出し方。現場ごとは現場名・夜勤を分けて並べます。</p>
        </div>

        <div className="field">
          <label className="label" htmlFor="client-paymentDay">
            支払期限
          </label>
          <select
            id="client-paymentDay"
            className="select"
            name="paymentDay"
            defaultValue={row?.paymentDay != null ? String(row.paymentDay) : ""}
          >
            {PAYMENT_DAY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <p className="hint">
            支払月は対象月の翌月で固定。日だけ取引先ごとに指定します（請求書の「支払期限」欄に反映）。
          </p>
        </div>

        {isEdit && (
          <div className="field">
            <label className="inline-row" style={{ gap: 8 }}>
              <input
                type="checkbox"
                name="active"
                defaultChecked={row.active}
              />
              <span>有効（出面入力・請求で選べるようにする）</span>
            </label>
          </div>
        )}
      </form>
    </Drawer>
  );
}

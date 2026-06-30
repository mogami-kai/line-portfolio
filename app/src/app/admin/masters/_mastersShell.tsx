"use client";

// ============================================================
// /admin/masters — タブシェル（4タブの切替＋選択中タブのみ描画）
//
//   freee / マネーフォワード 風。1ページに縦羅列せず、タブで領域を分ける。
//   ・.mst-tabs セグメントナビ（取引先 / 職人 / 自社・協力会社 / 請求書設定）。
//     スマホは横スクロール可（CSS 側で overflow-x:auto）。
//   ・選択中のタブだけを描画（非選択タブはマウントしない）。
//   ・必須の初期設定（自社情報・取引先・職人）が未完了なら、.mst-setup の
//     控えめな1行だけ出す（大きな常駐カードは置かない）。
//
//   各タブは props で Row 配列を受け取り、内部でドロワーを開いて
//   追加/編集する（一覧の中にフォームを展開しない）。
// ============================================================

import { useState } from "react";
import type { JSX } from "react";
import type {
  MasterTab,
  ClientRow,
  WorkerRow,
  OrgRow,
  SettingRow,
} from "./_mastersTypes.js";
import { ClientsTab } from "./_tabClients.js";
import { WorkersTab } from "./_tabWorkers.js";
import { OrgsTab } from "./_tabOrgs.js";
import { SettingsTab } from "./_tabSettings.js";

const TABS: { key: MasterTab; label: string; group?: "blue" }[] = [
  { key: "workers", label: "職人" },
  { key: "orgs", label: "ロール" },
  { key: "clients", label: "取引先設定", group: "blue" },
  { key: "settings", label: "請求書設定", group: "blue" },
];

export function MastersShell({
  clients,
  workers,
  orgs,
  setting,
}: {
  clients: ClientRow[];
  workers: WorkerRow[];
  orgs: OrgRow[];
  setting: SettingRow | null;
}): JSX.Element {
  const [tab, setTab] = useState<MasterTab>("clients");

  // 必須の初期設定（自社情報・取引先・職人）が未完了か。
  //   未完了が1つでもあれば、.mst-setup の控えめな1行だけ出して導線にする。
  const needSetting = !setting?.issuerName?.trim();
  const needClient = !clients.some((c) => c.active);
  const needWorker = !workers.some((w) => w.active);
  const pending: { key: MasterTab; label: string }[] = [];
  if (needSetting) pending.push({ key: "settings", label: "請求書設定" });
  if (needClient) pending.push({ key: "clients", label: "取引先設定" });
  if (needWorker) pending.push({ key: "workers", label: "職人" });

  return (
    <div className="mst-shell">
      <nav className="mst-tabs" role="tablist" aria-label="マスタの種類">
        {TABS.filter((t) => !t.group).map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`mst-tab ${tab === t.key ? "mst-tab--on" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
        <div className="mst-tabs-group">
          {TABS.filter((t) => t.group === "blue").map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`mst-tab ${tab === t.key ? "mst-tab--on" : ""}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      {pending.length > 0 && (
        <div className="mst-setup">
          <span className="mst-setup-text">
            初期設定が未完了です（{pending.map((p) => p.label).join("・")}）。
          </span>
          <button
            type="button"
            className="mst-setup-link"
            onClick={() => setTab(pending[0]!.key)}
          >
            設定する
          </button>
        </div>
      )}

      {tab === "clients" && <ClientsTab clients={clients} />}
      {tab === "workers" && <WorkersTab workers={workers} orgs={orgs} />}
      {tab === "orgs" && <OrgsTab orgs={orgs} />}
      {tab === "settings" && <SettingsTab setting={setting} />}
    </div>
  );
}

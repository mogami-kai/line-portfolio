// ============================================================
// 【ファイル5】freee請求書API連携（MVP-3 / Phase2）
// 請求サマリ → freee請求書をAPIで自動作成（防御的クライアント）
// ============================================================
// 既存の webhook（ファイル1）・billing（ファイル4）には手を入れず、
// このファイルを追加するだけで動きます（GASは全ファイルを結合実行）。
//
// 依存（他ファイルで定義済みのグローバル）:
//   TZ / BILLING / HEADERS_BILLING_SUMMARY /
//   readSheetObjects_ / clientMasterMap_ / ymForMonthOffset_ /
//   toNumber / prop_ / appendProcessLog_ / SpreadsheetApp / UrlFetchApp
//
// 使用するfreeeエンドポイント（2026-06 時点の確認結果。詳細は下の⚠注意）:
//   請求書作成: POST https://api.freee.co.jp/iv/invoices  （freee請求書 API）
//   トークン更新: POST https://accounts.secure.freee.co.jp/public_api/token
//   ※ freee会計の POST /api/1/invoices（請求書作成）は 2023-10 に廃止されたため
//     freee請求書 API を使う（会計→請求書の移行ガイドにパラメータ差分表あり）。
//   ※ issue_date(発行日) / due_date(支払期日) / partner_id / company_id は引き継ぎ。
//   ※ 既定は下書き(draft)で作成し、会計取引の自動生成を避ける（status は設定で変更可）。
//
// セットアップ（スクリプトプロパティに設定する値）:
//   FREEE_ACCESS_TOKEN    … freeeのアクセストークン
//   FREEE_REFRESH_TOKEN   … リフレッシュトークン（401時の自動更新に使用）
//   FREEE_CLIENT_ID       … OAuthアプリのクライアントID
//   FREEE_CLIENT_SECRET   … OAuthアプリのクライアントシークレット
//   FREEE_COMPANY_ID      … 事業所ID（company_id・整数）
//   FREEE_INVOICES_URL    … （任意）請求書作成エンドポイントの上書き
//   FREEE_INVOICE_STATUS  … （任意）"draft"（既定）/ "issue" 等
//   ※未設定でも安全に no-op（月末ジョブを止めません）。
//
// OAuthスコープ（freeeアプリ側で許可が必要）: "read write"
//
// ⚠ 重要な注意:
//   公式リファレンス(developer.freee.co.jp)が bot制限で参照不可だったため、
//   エンドポイントのホスト（/iv/invoices）と明細(invoice_contents)のフィールド名は、
//   本番投入前に「freee請求書 帳票API」「会計→請求書 移行ガイド」の差分表と必ず
//   突き合わせること。そのため URL とステータスは上記プロパティで上書き可能にしてある。
// ============================================================

const FREEE = {
  // freee請求書（帳票）API。freee会計の POST /api/1/invoices は 2023-10 に廃止。
  defaultInvoicesUrl: "https://api.freee.co.jp/iv/invoices",
  tokenUrl:           "https://accounts.secure.freee.co.jp/public_api/token",
  defaultStatus:      "draft", // 下書きで作成（会計取引の自動生成を避ける）
};

// ============================================================
// 設定読み込み（スクリプトプロパティ）
// ============================================================

const freeeConfig_ = () => ({
  accessToken:   prop_("FREEE_ACCESS_TOKEN"),
  refreshToken:  prop_("FREEE_REFRESH_TOKEN"),
  clientId:      prop_("FREEE_CLIENT_ID"),
  clientSecret:  prop_("FREEE_CLIENT_SECRET"),
  companyId:     prop_("FREEE_COMPANY_ID"),
  invoicesUrl:   prop_("FREEE_INVOICES_URL")   || FREEE.defaultInvoicesUrl,
  invoiceStatus: prop_("FREEE_INVOICE_STATUS") || FREEE.defaultStatus,
});

// freeeのID（company_id / partner_id）は整数。数値でなければ 0 を返す。
// （文字列のまま送ると freee API が 400/422 で全件失敗するため）
const parseFreeeId_ = (v) => {
  const n = Number(String(v ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : 0;
};

// ============================================================
// 請求書作成（請求サマリ → freee請求書をAPIで作成）
// ============================================================

function freeeCreateInvoices_(ym) {
  const cfg       = freeeConfig_();
  const companyId = parseFreeeId_(cfg.companyId);

  // 未設定・不正なら安全に no-op（月末ジョブから無条件で呼ばれるため止めない）
  if (!cfg.accessToken || !companyId) {
    const reason = !cfg.accessToken
      ? "FREEE_ACCESS_TOKEN が未設定"
      : "FREEE_COMPANY_ID が未設定または整数でない";
    appendProcessLog_(
      new Date(), "", "", "",
      `[FREEE_SKIP] ${ym}`, "INFO", `${reason}のためスキップ`
    );
    return { skipped: true, reason };
  }

  // 対象月の請求サマリを取得
  const summary = readSheetObjects_(BILLING.sheetSummary, HEADERS_BILLING_SUMMARY)
    .filter((r) => String(r["対象月"] ?? "").trim() === String(ym).trim());

  const masterMap = clientMasterMap_();

  let created = 0;
  const skippedClients = [];
  const errors = [];

  for (const s of summary) {
    const client      = String(s["取引先"] ?? "").trim();
    const billingDate = s["請求日"]; // 文字列 or SheetsがDate化した値（toFreeeDate_で吸収）
    const joyo        = toNumber(s["常用請求額"], 0);
    const lump        = toNumber(s["請負請求額"], 0);
    const exp         = toNumber(s["経費請求額"], 0);
    if (!client) continue;

    // 取引先マスタから freee取引先ID（整数）を引く（無ければスキップ＝エラーではない）
    const cm        = masterMap[client];
    const partnerId = cm ? parseFreeeId_(cm["freee取引先ID"]) : 0;
    if (!partnerId) {
      skippedClients.push(client);
      continue;
    }

    // 明細（0円の行は作らない）
    const lines = [];
    if (joyo > 0) lines.push({ description: "出面（常用）",   amount: joyo });
    if (lump > 0) lines.push({ description: "請負工事一式",   amount: lump });
    if (exp  > 0) lines.push({ description: "立替経費",       amount: exp  });
    if (lines.length === 0) {
      skippedClients.push(client);
      continue;
    }

    const issueDate = toFreeeDate_(billingDate);
    if (!issueDate) {
      errors.push(`${client}: 請求日が不正のため作成をスキップ`);
      continue;
    }
    const payload = {
      company_id:     companyId,
      partner_id:     partnerId,
      invoice_status: cfg.invoiceStatus, // 既定 "draft"（会計取引の自動生成を避ける）
      issue_date:     issueDate,         // 発行日
      due_date:       issueDate,         // 支払期日（請求日＝期日で統一）
      invoice_contents: lines.map((l, i) => ({
        order:       i + 1,
        type:        "normal",
        description: l.description,
        qty:         1,
        unit:        "式",
        unit_price:  Math.round(l.amount),
        amount:      Math.round(l.amount),
      })),
    };

    try {
      const res = freeePostInvoice_(payload, cfg);
      if (res.ok) {
        created += 1;
      } else {
        errors.push(`${client}: HTTP ${res.code} ${String(res.body || "").slice(0, 200)}`);
      }
    } catch (err) {
      errors.push(`${client}: ${err && err.message ? err.message : err}`);
    }
  }

  appendProcessLog_(
    new Date(), "", "", "",
    `[FREEE_DONE] ${ym}`, "SUCCESS_FREEE",
    `created=${created} skippedClients=${skippedClients.length} errors=${errors.length}`
  );

  return { created, skippedClients, errors };
}

// 請求書を1件POST。401なら一度だけトークンを更新して再試行する。
function freeePostInvoice_(payload, cfg) {
  let token = cfg.accessToken;
  let res   = freeeFetch_(cfg.invoicesUrl, token, payload);

  if (res.code === 401) {
    const refreshed = freeeRefreshToken_();
    if (refreshed) {
      token = prop_("FREEE_ACCESS_TOKEN") || token;
      res   = freeeFetch_(cfg.invoicesUrl, token, payload);
    }
  }

  return { ok: res.code >= 200 && res.code < 300, code: res.code, body: res.body };
}

// freeeへのPOST共通処理（必ず muteHttpExceptions で getResponseCode を確認）
function freeeFetch_(url, token, payload) {
  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  return { code: res.getResponseCode(), body: res.getContentText() };
}

// 「yyyy/MM/dd」文字列 or Date を freee形式「yyyy-MM-dd」へ。
// 不明・空なら "" を返す（当日で代用すると請求日を誤るため、呼び出し側でスキップ）。
const toFreeeDate_ = (v) => {
  if (v instanceof Date) {
    return isNaN(v.getTime()) ? "" : Utilities.formatDate(v, TZ, "yyyy-MM-dd");
  }
  const s = String(v ?? "").trim();
  if (!s) return "";
  const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, TZ, "yyyy-MM-dd");
  }
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return Utilities.formatDate(parsed, TZ, "yyyy-MM-dd");
  return "";
};

// ============================================================
// アクセストークン更新（OAuth refresh_token）
// ============================================================

function freeeRefreshToken_() {
  const cfg = freeeConfig_();
  if (!cfg.refreshToken || !cfg.clientId || !cfg.clientSecret) return false;

  const res = UrlFetchApp.fetch(FREEE.tokenUrl, {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: {
      grant_type:    "refresh_token",
      refresh_token: cfg.refreshToken,
      client_id:     cfg.clientId,
      client_secret: cfg.clientSecret,
    },
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    appendProcessLog_(
      new Date(), "", "", "",
      "[FREEE_TOKEN]", "ERROR",
      `トークン更新失敗: HTTP ${code} ${String(res.getContentText() || "").slice(0, 200)}`
    );
    return false;
  }

  let json;
  try {
    json = JSON.parse(res.getContentText());
  } catch (err) {
    return false;
  }

  const newAccess  = String(json && json.access_token  ? json.access_token  : "").trim();
  const newRefresh = String(json && json.refresh_token ? json.refresh_token : "").trim();
  if (!newAccess) return false;

  const sp = PropertiesService.getScriptProperties();
  sp.setProperty("FREEE_ACCESS_TOKEN", newAccess);
  if (newRefresh) sp.setProperty("FREEE_REFRESH_TOKEN", newRefresh);

  appendProcessLog_(
    new Date(), "", "", "",
    "[FREEE_TOKEN]", "SUCCESS_FREEE", "アクセストークンを更新しました"
  );
  return true;
}

// ============================================================
// メニュー実行用ラッパー（手動実行）
// addBillingMenu_ から呼ぶ場合は billing.js のメニューに項目を追加してください
// ============================================================

function createFreeeInvoicesThisMonth() { runFreeeCreateInvoicesForOffset_(0); }
function createFreeeInvoicesPrevMonth() { runFreeeCreateInvoicesForOffset_(-1); }

function runFreeeCreateInvoicesForOffset_(offset) {
  const ui = SpreadsheetApp.getUi();
  const ym = ymForMonthOffset_(offset);
  try {
    const res = freeeCreateInvoices_(ym);

    if (res.skipped) {
      ui.alert(
        `ℹ️ ${ym} のfreee請求書作成はスキップしました\n\n` +
        `理由: ${res.reason}\n` +
        `スクリプトプロパティ FREEE_ACCESS_TOKEN / FREEE_COMPANY_ID を設定してください。`
      );
      return;
    }

    let msg = `✅ ${ym} のfreee請求書（下書き）を作成しました\n\n` +
      `作成: ${res.created}件\n` +
      `スキップ（freee取引先ID未設定）: ${res.skippedClients.length}件`;
    if (res.skippedClients.length > 0) {
      msg += "\n  ・" + res.skippedClients.join("\n  ・");
    }
    if (res.errors.length > 0) {
      msg += `\n\n⚠️ エラー: ${res.errors.length}件\n  ・` + res.errors.join("\n  ・");
    }
    ui.alert(msg);
  } catch (err) {
    ui.alert(`❌ freee請求書作成でエラー\n\n${err && err.stack ? err.stack : err}`);
  }
}

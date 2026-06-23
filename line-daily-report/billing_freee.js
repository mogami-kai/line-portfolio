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
//   toNumber / prop_ / appendProcessLog_
//
// 使用するfreeeエンドポイント（※下の⚠注意を必ず参照）:
//   請求書作成: POST https://api.freee.co.jp/api/1/invoices
//   トークン更新: POST https://accounts.secure.freee.co.jp/public_api/token
//   ※請求書ペイロードには company_id を含めます。
//
// セットアップ（スクリプトプロパティに設定する値）:
//   FREEE_ACCESS_TOKEN   … freeeのアクセストークン
//   FREEE_REFRESH_TOKEN  … リフレッシュトークン（401時の自動更新に使用）
//   FREEE_CLIENT_ID      … OAuthアプリのクライアントID
//   FREEE_CLIENT_SECRET  … OAuthアプリのクライアントシークレット
//   FREEE_COMPANY_ID     … 事業所ID（company_id）
//   ※未設定でも安全に no-op（月末ジョブを止めません）。
//
// OAuthスコープ（freeeアプリ側で許可が必要）:
//   read  … 取引先・請求書の参照
//   write … 請求書の作成
//   （freeeでは "read write" のように半角スペース区切りで指定）
//
// ⚠ 重要な注意:
//   実APIをここから呼べないため、エンドポイントのパス（/api/1/invoices 等）と
//   JSONペイロードのフィールド名（invoice_contents / partner_id / issue_date 等）は
//   本番投入前に「最新のfreee APIドキュメント」と必ず突き合わせて検証すること。
//   フィールド名やネスト構造が変わると 400/422 で失敗します。
// ============================================================

const FREEE = {
  invoicesUrl: "https://api.freee.co.jp/api/1/invoices",
  tokenUrl:    "https://accounts.secure.freee.co.jp/public_api/token",
};

// ============================================================
// 設定読み込み（スクリプトプロパティ）
// ============================================================

const freeeConfig_ = () => ({
  accessToken:  prop_("FREEE_ACCESS_TOKEN"),
  refreshToken: prop_("FREEE_REFRESH_TOKEN"),
  clientId:     prop_("FREEE_CLIENT_ID"),
  clientSecret: prop_("FREEE_CLIENT_SECRET"),
  companyId:    prop_("FREEE_COMPANY_ID"),
});

// ============================================================
// 請求書作成（請求サマリ → freee請求書をAPIで作成）
// ============================================================

function freeeCreateInvoices_(ym) {
  const cfg = freeeConfig_();

  // 未設定なら安全に no-op（月末ジョブから無条件で呼ばれるため止めない）
  if (!cfg.accessToken || !cfg.companyId) {
    appendProcessLog_(
      new Date(), "", "", "",
      `[FREEE_SKIP] ${ym}`, "INFO",
      "FREEE_ACCESS_TOKEN / FREEE_COMPANY_ID が未設定のためスキップ"
    );
    return { skipped: true, reason: "未設定" };
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
    const billingDate = String(s["請求日"] ?? "").trim();
    const joyo        = toNumber(s["常用請求額"], 0);
    const lump        = toNumber(s["請負請求額"], 0);
    const exp         = toNumber(s["経費請求額"], 0);
    if (!client) continue;

    // 取引先マスタから freee取引先ID を引く（無ければスキップ＝エラーではない）
    const cm        = masterMap[client];
    const partnerId = cm ? String(cm["freee取引先ID"] ?? "").trim() : "";
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
    const payload = {
      company_id: toNumber(cfg.companyId, cfg.companyId),
      partner_id: toNumber(partnerId, partnerId),
      issue_date: issueDate, // 請求日
      // 請求日＝期日（同日）。フィールド名はfreeeのバージョンにより
      // payment_date / due_date のいずれか（⚠ドキュメント要確認）。
      payment_date: issueDate,
      due_date:     issueDate,
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
  let res   = freeeFetch_(FREEE.invoicesUrl, token, payload);

  if (res.code === 401) {
    const refreshed = freeeRefreshToken_();
    if (refreshed) {
      token = prop_("FREEE_ACCESS_TOKEN") || token;
      res   = freeeFetch_(FREEE.invoicesUrl, token, payload);
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

// 「yyyy/MM/dd」や Date を freee形式「yyyy-MM-dd」へ。失敗時は当日。
const toFreeeDate_ = (v) => {
  const s = String(v ?? "").trim();
  const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, TZ, "yyyy-MM-dd");
  }
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return Utilities.formatDate(parsed, TZ, "yyyy-MM-dd");
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
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

    let msg = `✅ ${ym} のfreee請求書を作成しました\n\n` +
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

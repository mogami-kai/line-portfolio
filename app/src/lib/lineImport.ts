// ============================================================
// LINE トーク履歴の取り込みパーサ（バックフィル用・純関数）
//
//   LINE の「トーク履歴を保存」テキストを貼り付け、出面レポートを構造化する。
//   旧 GAS「従来ルール」の解釈を踏襲（実ログで calibration / 検証）:
//     ・1メッセージ＝1つ以上のレポートブロック（空行区切り）
//     ・ブロック =
//         日付行（例「6月10日「水」」「6/15」「1月20日 火曜日」）
//         取引先＋契約行（例「辻濱工業　常用」／常用=JOYO・請負/取決=UKEOI）
//         現場行（例「みなとみらい」）
//         職人行（空白区切り。「齋」「石渡（半日）」「久保 残1h」等の注記可）
//         経費/マーカー行（パーキング800・ガソリン3000・残0.5h・半日・夜勤）
//   実名・現場名は入力テキスト（実行時）にのみ存在し、コードには焼かない。
//
//   出力は「確定的に読めたブロック」と「読めなかった行（要確認）」に分ける。
//   呼び出し側（取り込み API）が find-or-create でマスタ化し Report を作る。
// ============================================================

import { parseReportDate } from "./validate.js";

export type Shift = "DAY" | "HALF" | "NIGHT";
export type ContractType = "JOYO" | "UKEOI";

export interface ParsedWorker {
  name: string;
  shift: Shift;
  manDays: number;
  otHours: number;
}

export interface ParsedExpense {
  kind: string;
  amount: number;
}

export interface ParsedReport {
  /** yyyy-MM-dd */
  date: string;
  client: string;
  contractType: ContractType;
  site: string | null;
  workers: ParsedWorker[];
  expenses: ParsedExpense[];
  /** 元メッセージ（重複検出・確認用） */
  raw: string;
}

export interface ParseResult {
  reports: ParsedReport[];
  /** 解釈できなかった/怪しいブロック（人手確認用）。 */
  skipped: Array<{ raw: string; reason: string }>;
}

// 契約キーワード → 種別。常用=JOYO、それ以外の取決/請負系=UKEOI。
const CONTRACT_RE = /(常用|請負|取決|取り決め|ニチレキ)/;
function contractOf(token: string): ContractType {
  if (/常用/.test(token)) return "JOYO";
  if (/(請負|取決|取り決め)/.test(token)) return "UKEOI";
  return "JOYO";
}

// 全角空白・連続空白を 1 つの区切りに。
function splitTokens(line: string): string[] {
  return line
    .replace(/[、,]/g, " ")
    .split(/[\s　]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const SHIFT_MARK = /(半日|夜勤|日勤)/;
const OT_MARK = /(?:残業|残|ot|OT)\s*([0-9]+(?:\.[0-9]+)?)\s*h?/i;
// 経費キーワード（金額は近傍の数字。カンマ・円・全角数字を吸収）。
const EXPENSE_KINDS = ["パーキング", "駐車", "ガソリン", "燃料", "弁当", "高速", "ETC"];

// ノイズ行（出面ブロックの構成要素になり得ない）を判定。
function isNoiseLine(line: string): boolean {
  const s = line.trim();
  if (!s) return true;
  if (/^\[(スタンプ|写真|動画|ファイル|アルバム|連絡先|位置情報)\]$/.test(s))
    return true;
  if (/(送信を取り消しました|がメッセージの送信を取り消しました)/.test(s))
    return true;
  if (/(グループに追加しました|グループから退出しました|がグループ名を|がアナウンス|通話時間|通話をキャンセル|通話が開始|通話が終了|プロフィール画像を変更|BGMを設定)/.test(s))
    return true;
  return false;
}

function toHalfWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 数字（カンマ・全角・円付き）→ 整数。見つからなければ null。 */
function parseAmount(s: string): number | null {
  const m = toHalfWidthDigits(s).replace(/,/g, "").match(/(\d+)\s*円?/);
  return m ? parseInt(m[1], 10) : null;
}

// ── LINE エクスポート → メッセージ本文の配列（タイムスタンプ/送信者を除去） ──
//   行頭 "HH:MM\t送信者\t本文" を 1 メッセージの開始とみなす。本文が " で始まる
//   複数行ブロックは閉じ " まで連結する。日付セクション見出しは無視。
export function extractMessages(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const messages: string[] = [];
  const msgStart = /^(\d{1,2}):(\d{2})\t(.*)$/;
  const dateHeader = /^\d{4}\/\d{1,2}\/\d{1,2}\([^)]*\)\s*$/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (dateHeader.test(line)) {
      i++;
      continue;
    }
    const m = line.match(msgStart);
    if (!m) {
      i++;
      continue;
    }
    // "HH:MM\t送信者\t本文..." の本文部分。送信者にタブが無い前提で 3 分割。
    const parts = line.split("\t");
    let body = parts.slice(2).join("\t");
    // 引用複数行: 本文が " 始まりで、その行内で閉じない場合は続行。
    if (body.startsWith('"') && !(body.length > 1 && body.endsWith('"'))) {
      const buf = [body.slice(1)];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.endsWith('"')) {
          buf.push(l.slice(0, -1));
          i++;
          break;
        }
        buf.push(l);
        i++;
      }
      messages.push(buf.join("\n"));
      continue;
    }
    // 単一行（前後の " は剥がす）。
    if (body.startsWith('"') && body.endsWith('"') && body.length >= 2) {
      body = body.slice(1, -1);
    }
    messages.push(body);
    i++;
  }
  return messages;
}

// ── 1 メッセージ → レポートブロック群（空行区切り） ──
function splitBlocks(message: string): string[][] {
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const raw of message.split("\n")) {
    const line = raw.replace(/\s+$/u, "");
    if (line.trim() === "") {
      if (cur.length) blocks.push(cur);
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur);
  return blocks;
}

// 職人トークンから名前と注記（半日/夜勤/残業）を取り出す。
function parseWorkerToken(token: string): ParsedWorker | null {
  let t = token.replace(/[（(](.*?)[)）]/g, " $1 "); // （半日）→ 半日
  let shift: Shift = "DAY";
  let ot = 0;

  const otm = t.match(OT_MARK);
  if (otm) {
    ot = parseFloat(otm[1]) || 0;
    t = t.replace(OT_MARK, " ");
  }
  if (/夜勤/.test(t)) {
    shift = "NIGHT";
    t = t.replace(/夜勤/g, " ");
  } else if (/半日/.test(t)) {
    shift = "HALF";
    t = t.replace(/半日/g, " ");
  }
  t = t.replace(/日勤/g, " ");
  const name = t.replace(/[\s　]+/g, "").trim();
  if (!name) return null;
  const manDays = shift === "HALF" ? 0.5 : 1;
  return { name, shift, manDays, otHours: ot };
}

const CLIENT_LINE_RE = CONTRACT_RE;

/**
 * テキスト全体を解析して ParsedReport[] を返す。
 * refYear: 年が省略された日付（「6月10日」）の補完に使う基準日（既定=今日）。
 */
export function parseLineHistory(text: string, refDate?: Date): ParseResult {
  const ref = refDate ?? new Date();
  const reports: ParsedReport[] = [];
  const skipped: Array<{ raw: string; reason: string }> = [];

  for (const message of extractMessages(text)) {
    // 同一メッセージ内では日付を1回だけ書き、後続ブロック（別現場）は継承する。
    let lastDate = "";
    for (const block of splitBlocks(message)) {
      const lines = block.filter((l) => !isNoiseLine(l));
      if (lines.length === 0) continue;

      // 取引先＋契約の行（常用/請負等を含む）。
      const clientIdx = lines.findIndex((l) => CLIENT_LINE_RE.test(l));

      // 日付: 取引先行まで（無ければブロック全体）から探す。全角数字は半角化して解釈。
      const dateEnd = clientIdx < 0 ? lines.length : clientIdx + 1;
      let blockDate = "";
      for (let k = 0; k < dateEnd; k++) {
        const p = parseReportDate(toHalfWidthDigits(lines[k]), ref);
        if (p.ok) {
          blockDate = p.iso;
          break;
        }
      }
      // 日付だけの短いブロック（例「6月1日」の後に空行）も継承元として記録する。
      if (blockDate) lastDate = blockDate;
      if (clientIdx < 0) continue; // このブロックに出面本体は無い。

      const dateIso = blockDate || lastDate;
      if (!dateIso) {
        skipped.push({ raw: block.join("\n"), reason: "日付を読めない" });
        continue;
      }

      // 取引先＋契約。行から契約キーワードを取り、その前を取引先名に。
      const clientLine = lines[clientIdx];
      const contractType = contractOf(clientLine);
      const cm = clientLine.match(CONTRACT_RE);
      let client = clientLine.slice(0, cm ? cm.index : clientLine.length).trim();
      // 契約の後ろに現場や時間が同居するケース（例「MALU 常用 横浜アリーナ」）。
      const afterContract = clientLine
        .slice((cm?.index ?? 0) + (cm?.[0].length ?? 0))
        .replace(/[0-9]{1,2}時.*$/u, "")
        .trim();
      client = client.replace(/[\s　]+/g, "");
      if (!client) {
        skipped.push({ raw: block.join("\n"), reason: "取引先を読めない" });
        continue;
      }

      // 現場: 取引先行の次の行。ただし契約行に現場が同居していればそれを優先。
      let site: string | null = null;
      let workerStart = clientIdx + 1;
      if (afterContract) {
        site = afterContract;
      } else if (clientIdx + 1 < lines.length) {
        site = lines[clientIdx + 1].trim() || null;
        workerStart = clientIdx + 2;
      }

      // 職人 + マーカー + 経費 を残りの行から拾う。
      const workers: ParsedWorker[] = [];
      const expenses: ParsedExpense[] = [];
      let blockShift: Shift | null = null;
      let blockOt = 0;

      for (let k = workerStart; k < lines.length; k++) {
        const line = lines[k].trim();
        if (!line) continue;

        // 経費行?
        const kind = EXPENSE_KINDS.find((kw) => line.includes(kw));
        if (kind) {
          const amt = parseAmount(line);
          if (amt != null) expenses.push({ kind, amount: amt });
          continue;
        }

        // ブロック単位のマーカー行（単独「半日」「夜勤」「残1h」「残業1h」）。
        const onlyShift = line.match(/^(半日|夜勤)$/);
        if (onlyShift) {
          blockShift = onlyShift[1] === "夜勤" ? "NIGHT" : "HALF";
          continue;
        }
        const onlyOt = line.match(/^(?:残業|残)\s*([0-9]+(?:\.[0-9]+)?)\s*h?$/i);
        if (onlyOt) {
          blockOt = parseFloat(onlyOt[1]) || 0;
          continue;
        }

        // 職人行（空白区切り）。トークンごとに名前＋注記。
        for (const tok of splitTokens(line)) {
          if (CONTRACT_RE.test(tok)) continue;
          const w = parseWorkerToken(tok);
          if (w) workers.push(w);
        }
      }

      if (workers.length === 0) {
        skipped.push({ raw: block.join("\n"), reason: "職人を読めない" });
        continue;
      }

      // ブロック単位のマーカーを各職人へ反映（個別注記が無い職人に適用）。
      for (const w of workers) {
        if (blockShift && w.shift === "DAY") {
          w.shift = blockShift;
          w.manDays = blockShift === "HALF" ? 0.5 : 1;
        }
        if (blockOt && w.otHours === 0) w.otHours = blockOt;
      }

      reports.push({
        date: dateIso,
        client,
        contractType,
        site: site && site.length ? site : null,
        workers,
        expenses,
        raw: block.join("\n"),
      });
    }
  }

  return { reports, skipped };
}

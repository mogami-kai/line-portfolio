"use client";

// ============================================================
// 未通知アラートの操作ボタン（再通知 / 再通知しない）
//   Server Action を直接呼び、失敗理由をカード内にインライン表示する。
//   （以前は <form action> で throw → Next の汎用エラー画面になり、
//     「なぜ再通知できないか」が全く伝わらなかった）
// ============================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  resendReportNotifyAction,
  dismissUnpostedReportAction,
} from "./_actions.js";

export function UnpostedActions({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [isPending, startTransition] = useTransition();

  function run(action: (id: string) => Promise<{ ok: boolean; error?: string }>) {
    setErr(null);
    startTransition(async () => {
      try {
        const res = await action(reportId);
        if (res.ok) {
          setDone(true);
          router.refresh(); // 一覧から消す
        } else {
          setErr(res.error ?? "失敗しました。もう一度お試しください。");
        }
      } catch (e) {
        setErr(String((e as Error)?.message ?? e));
      }
    });
  }

  if (done) {
    return <span className="muted">処理しました</span>;
  }

  return (
    <>
      <button
        type="button"
        className="btn btn--primary btn--sm"
        disabled={isPending}
        onClick={() => run(resendReportNotifyAction)}
      >
        {isPending ? "送信中…" : "再通知"}
      </button>
      <button
        type="button"
        className="btn btn--danger-text btn--sm"
        disabled={isPending}
        onClick={() => run(dismissUnpostedReportAction)}
      >
        再通知しない
      </button>
      {err && (
        <div className="unposted-err" role="alert">
          {err}
        </div>
      )}
    </>
  );
}

"use client";

import type { JSX } from "react";

// ============================================================
// 確認付き削除ボタン（クライアント）
//   - サーバアクションを prop で受け取り、押下時に window.confirm で必ず確認。
//   - OK なら FormData{id} を組み立て、useTransition 内で await action(fd)。
//   - 成功後は router.refresh() で表示を最新化。失敗は alert で日本語メッセージ表示。
//   ※ Server Component（請求書/ユーザー一覧）からも、Client Component（マスタ各タブ）
//     からも使える。action は「関数参照」を渡す（Server Action）。
// ============================================================

import { useTransition } from "react";
import { useRouter } from "next/navigation";

export function ConfirmDeleteButton({
  action,
  id,
  confirmText,
  label,
  className,
}: {
  // 想定内の失敗は { ok:false, error } を返す（本番では throw のメッセージが
  // マスクされるため）。成功は { ok:true }（または void）。
  action: (fd: FormData) => Promise<{ ok: boolean; error?: string } | void>;
  id: string;
  confirmText: string;
  label?: string;
  className?: string;
}): JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onClick(): void {
    if (pending) return;
    if (!window.confirm(confirmText)) return;
    const fd = new FormData();
    fd.set("id", id);
    startTransition(async () => {
      try {
        const res = await action(fd);
        // 削除できない理由（無効化してください 等）を、そのまま表示。
        if (res && res.ok === false) {
          window.alert(res.error ?? "削除できませんでした。");
          return;
        }
        router.refresh();
      } catch (e) {
        const message =
          e instanceof Error ? e.message : "削除に失敗しました。";
        window.alert(message);
      }
    });
  }

  return (
    <button
      type="button"
      className={className ?? "btn btn--danger-text btn--sm"}
      onClick={onClick}
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? "削除中…" : (label ?? "削除")}
    </button>
  );
}

"use client";

// ============================================================
// /admin/masters — 共通ドロワー（編集はすべてこの中で行う）
//
//   一覧の中にフォームを展開せず、編集/追加は必ずこのドロワーで開く。
//   ・PC（>=641px）: 画面右からのドロワー（.drw-panel）。
//   ・スマホ（<=640px）: 画面下からのボトムシート（全幅・上角丸・safe-area）。
//   出し分けは CSS（globals.css の .drw-* メディアクエリ）で行い、
//   ここでは構造とふるまい（マウントガード / Esc / 背面スクロールロック）だけを持つ。
//
//   ※ createPortal で <body> 直下に出す。SSR 中は body が無いため、
//     マウント後（useEffect で mounted=true）に初めてポータルを描画する。
// ============================================================

import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { createPortal } from "react-dom";

export function Drawer({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}): JSX.Element | null {
  // SSR 中は createPortal しない（body が無い）。マウント後に true。
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // 開いている間だけ: 背面スクロールを止め、Escape で閉じる。
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open || !mounted) return null;

  return createPortal(
    <div className="drw-overlay" role="dialog" aria-modal="true">
      <button
        type="button"
        className="drw-scrim"
        aria-label="閉じる"
        onClick={onClose}
      />
      <div className="drw-panel">
        <div className="drw-head">
          <div className="drw-title">{title}</div>
          <button
            type="button"
            className="drw-close"
            aria-label="閉じる"
            onClick={onClose}
          >
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <div className="drw-body">{children}</div>
        {footer && <div className="drw-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

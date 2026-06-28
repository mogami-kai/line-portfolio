"use client";

// ============================================================
// 管理画面の共通シェル（AppShell）
//   PC: 左サイドバー固定 ＋ 広い作業領域
//   スマホ/タブレット: 上部ヘッダー（ロゴ＋ハンバーガー）＋ ドロワー
//   現在地をハイライト。アイコンは依存なしの最小インラインSVG（テキスト併記）。
// ============================================================

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

interface NavItem {
  href: string;
  label: string;
  icon: () => ReactNode;
  match: (path: string) => boolean;
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const IconHome = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" {...stroke} aria-hidden>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V21h14V9.5" />
  </svg>
);
const IconInvoice = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" {...stroke} aria-hidden>
    <path d="M6 3h9l4 4v14H6z" />
    <path d="M14 3v5h5M9 12h7M9 16h7" />
  </svg>
);
const IconMasters = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" {...stroke} aria-hidden>
    <ellipse cx="12" cy="6" rx="7" ry="3" />
    <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
  </svg>
);
const IconUsers = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" {...stroke} aria-hidden>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
    <path d="M16 6.2A3 3 0 0 1 16 12M17 14c2.5.4 4 2.3 4 5" />
  </svg>
);

const NAV: NavItem[] = [
  { href: "/admin", label: "ホーム", icon: IconHome, match: (p) => p === "/admin" },
  {
    href: "/admin/invoices",
    label: "請求書",
    icon: IconInvoice,
    match: (p) => p.startsWith("/admin/invoices"),
  },
  {
    href: "/admin/masters",
    label: "マスタ管理",
    icon: IconMasters,
    match: (p) => p.startsWith("/admin/masters"),
  },
  {
    href: "/admin/users",
    label: "ユーザー承認",
    icon: IconUsers,
    match: (p) => p.startsWith("/admin/users"),
  },
];

function Brand() {
  return (
    <a href="/admin" className="brand" aria-label="出面管理 ホーム">
      {/* 正式ロゴは /public/brand/logo.svg に差し替え。 */}
      <img className="brand-logo" src="/brand/logo.svg" alt="" width={28} height={28} />
      <span className="brand-name">出面管理</span>
    </a>
  );
}

function NavLinks({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <nav className="nav">
      {NAV.map((item) => {
        const active = item.match(pathname);
        const Icon = item.icon;
        return (
          <a
            key={item.href}
            href={item.href}
            className={`nav-item ${active ? "is-active" : ""}`}
            aria-current={active ? "page" : undefined}
            onClick={onNavigate}
          >
            <span className="nav-ico">
              <Icon />
            </span>
            <span>{item.label}</span>
          </a>
        );
      })}
    </nav>
  );
}

export function AdminShell({
  userName,
  children,
}: {
  userName: string;
  children: ReactNode;
}) {
  const pathname = usePathname() || "/admin";
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const current = NAV.find((n) => n.match(pathname))?.label ?? "管理";

  // ドロワー: 開いている間は背面スクロールを止め、Esc で閉じ、パネルへフォーカス。
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="app-shell">
      {/* PC: サイドバー */}
      <aside className="app-sidebar">
        <div className="app-sidebar-top">
          <Brand />
        </div>
        <NavLinks pathname={pathname} />
        <div className="app-sidebar-foot">
          <div className="sb-user" title={userName}>
            {userName}
          </div>
          <a href="/api/auth/logout" className="sb-logout">
            ログアウト
          </a>
        </div>
      </aside>

      {/* スマホ/タブレット: 上部ヘッダー */}
      <header className="app-header">
        <Brand />
        <span className="app-header-title">{current}</span>
        <button
          type="button"
          className="app-burger"
          aria-label="メニュー"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <svg viewBox="0 0 24 24" width="24" height="24" {...stroke} aria-hidden>
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      </header>

      {/* ドロワー */}
      {open && (
        <div className="app-drawer" role="dialog" aria-modal="true">
          <button
            type="button"
            className="app-drawer-scrim"
            aria-label="閉じる"
            onClick={() => setOpen(false)}
          />
          <div className="app-drawer-panel" ref={panelRef} tabIndex={-1}>
            <div className="app-drawer-head">
              <Brand />
              <button
                type="button"
                className="app-burger"
                aria-label="閉じる"
                onClick={() => setOpen(false)}
              >
                <svg viewBox="0 0 24 24" width="24" height="24" {...stroke} aria-hidden>
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
            <NavLinks pathname={pathname} onNavigate={() => setOpen(false)} />
            <div className="app-sidebar-foot">
              <div className="sb-user">{userName}</div>
              <a href="/api/auth/logout" className="sb-logout">
                ログアウト
              </a>
            </div>
          </div>
        </div>
      )}

      {/* 作業領域 */}
      <main className="app-main">
        <div className="app-content">{children}</div>
      </main>
    </div>
  );
}

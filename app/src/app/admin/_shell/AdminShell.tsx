"use client";

// ============================================================
// 管理画面の共通シェル（AppShell）
//   PC: 左サイドバー固定 ＋ 広い作業領域
//   スマホ: 上部ヘッダー（ロゴ＋ページ名） ＋ 右端固定の凸凹ストリップ
//     - 閉じ時: アイコンのみの凸凹タブ（常時表示）
//     - 開き時: 各タブが左に展開してアイコン＋ラベル表示（ドロワー廃止）
// ============================================================

import { useEffect, useState, type ReactNode } from "react";
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
const IconAggregate = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" {...stroke} aria-hidden>
    <path d="M4 4v16h16" />
    <path d="M8 16v-4M12 16V8M16 16v-6" />
  </svg>
);
const IconInvoice = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" {...stroke} aria-hidden>
    <path d="M6 3h9l4 4v14H6z" />
    <path d="M14 3v5h5M9 12h7M9 16h7" />
  </svg>
);
const IconSettings = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" {...stroke} aria-hidden>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);
const IconHistory = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" {...stroke} aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 3" />
  </svg>
);
const IconUsers = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" {...stroke} aria-hidden>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
    <path d="M16 6.2A3 3 0 0 1 16 12M17 14c2.5.4 4 2.3 4 5" />
  </svg>
);
const IconLogout = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" {...stroke} aria-hidden>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
  </svg>
);

const NAV: NavItem[] = [
  { href: "/admin", label: "ホーム", icon: IconHome, match: (p) => p === "/admin" },
  {
    href: "/admin/aggregate",
    label: "集計",
    icon: IconAggregate,
    match: (p) => p.startsWith("/admin/aggregate"),
  },
  {
    href: "/admin/invoices",
    label: "請求書",
    icon: IconInvoice,
    match: (p) => p.startsWith("/admin/invoices"),
  },
  {
    href: "/admin/masters",
    label: "設定",
    icon: IconSettings,
    match: (p) => p.startsWith("/admin/masters"),
  },
  {
    href: "/admin/users",
    label: "ユーザー管理",
    icon: IconUsers,
    match: (p) => p.startsWith("/admin/users"),
  },
  {
    href: "/admin/logs",
    label: "履歴",
    icon: IconHistory,
    match: (p) => p.startsWith("/admin/logs"),
  },
];

function Brand() {
  return (
    <a href="/admin" className="brand" aria-label="出面管理 ホーム">
      <span className="brand-name">出面管理</span>
    </a>
  );
}

function NavLinks({
  pathname,
  items,
  onNavigate,
}: {
  pathname: string;
  items: NavItem[];
  onNavigate?: () => void;
}) {
  return (
    <nav className="nav">
      {items.map((item) => {
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
  scoped = false,
  children,
}: {
  userName: string;
  /** スコープ管理者＝ホーム・集計・請求のみ（設定/ユーザー管理を隠す）。 */
  scoped?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname() || "/admin";
  const [open, setOpen] = useState(false);
  // スコープ管理者は ホーム/集計/請求書 のみ。
  const nav = scoped
    ? NAV.filter((n) =>
        ["/admin", "/admin/aggregate", "/admin/invoices"].includes(n.href),
      )
    : NAV;
  const current = nav.find((n) => n.match(pathname))?.label ?? "管理";

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
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
        <NavLinks pathname={pathname} items={nav} />
        <div className="app-sidebar-foot">
          <div className="sb-user" title={userName}>
            {userName}
          </div>
          <a href="/api/auth/logout" className="sb-logout">
            ログアウト
          </a>
        </div>
      </aside>

      {/* スマホ: ヘッダー（ハンバーガーはストリップへ統合） */}
      <header className="app-header">
        <Brand />
        <span className="app-header-title">{current}</span>
      </header>

      {/* スマホ: スクリム（ストリップ展開時・背面） */}
      {open && (
        <button
          type="button"
          className="app-icon-scrim"
          onClick={() => setOpen(false)}
          aria-label="閉じる"
        />
      )}

      {/* スマホ: 右端固定の凸凹ナビストリップ */}
      <div className={`app-icon-bar${open ? " is-open" : ""}`}>
        {/* ハンバーガー（ストリップ最上部・ヘッダー同位置） */}
        <button
          type="button"
          className="app-icon-bar-burger"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "閉じる" : "メニュー"}
        >
          <span className="app-icon-bar-label app-icon-bar-burger-label">
            {userName}
          </span>
          <span className="app-icon-bar-ico">
            {open ? (
              <svg viewBox="0 0 24 24" width="22" height="22" {...stroke} aria-hidden>
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="22" height="22" {...stroke} aria-hidden>
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            )}
          </span>
        </button>

        {/* ナビアイコン（凸凹） */}
        {nav.map((item) => {
          const active = item.match(pathname);
          const Icon = item.icon;
          return (
            <a
              key={item.href}
              href={item.href}
              className={`app-icon-bar-item${active ? " is-active" : ""}`}
              aria-current={active ? "page" : undefined}
              onClick={() => setOpen(false)}
            >
              <span className="app-icon-bar-label">{item.label}</span>
              <span className="app-icon-bar-ico">
                <Icon />
              </span>
            </a>
          );
        })}

        {/* ログアウト */}
        <a href="/api/auth/logout" className="app-icon-bar-item app-icon-bar-item--logout">
          <span className="app-icon-bar-label">ログアウト</span>
          <span className="app-icon-bar-ico">
            <IconLogout />
          </span>
        </a>
      </div>

      {/* 作業領域 */}
      <main className="app-main">
        <div className="app-content">{children}</div>
      </main>
    </div>
  );
}

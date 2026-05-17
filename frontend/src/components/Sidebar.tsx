"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { ThemeToggle } from "@/components/ThemeToggle";
import { clearToken } from "@/lib/api";
import type { User } from "@/lib/types";

// ── SVG icons ──────────────────────────────────────────────────────────────

function Icon({ d, className = "" }: { d: string | string[]; className?: string }) {
  const paths = Array.isArray(d) ? d : [d];
  return (
    <svg
      width="18" height="18" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round"
      className={`shrink-0 ${className}`}
    >
      {paths.map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

const ICONS: Record<string, string[]> = {
  dashboard: [
    "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    "M9 22V12h6v10",
  ],
  plan: [
    "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  ],
  files: [
    "M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z",
    "M13 2v7h7",
  ],
  tasks: [
    "M9 11l3 3L22 4",
    "M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  ],
  filament: [
    "M12 2a10 10 0 1 0 10 10",
    "M12 8a4 4 0 1 0 4 4",
    "M12 12h.01",
  ],
  analytics: [
    "M18 20V10M12 20V4M6 20v-6",
  ],
  history: [
    "M12 8v4l3 3",
    "M3.05 11a9 9 0 1 1 .5 4M3 16v-5h5",
  ],
  printers: [
    "M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2",
    "M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6",
    "M6 18h12v3H6z",
  ],
  users: [
    "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2",
    "M9 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0",
    "M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  ],
  setup: [
    "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  ],
  settings: [
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  ],
  logout: [
    "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4",
    "M16 17l5-5-5-5",
    "M21 12H9",
  ],
};

const NAV: { href: string; label: string; icon: string; adminOnly?: boolean }[] = [
  { href: "/dashboard", label: "Дашборд", icon: "dashboard" },
  { href: "/plan", label: "План друку", icon: "plan" },
  { href: "/files", label: "Файли", icon: "files" },
  { href: "/tasks", label: "Завдання", icon: "tasks" },
  { href: "/filament", label: "Пластик", icon: "filament" },
  { href: "/analytics", label: "Аналітика", icon: "analytics" },
  { href: "/history", label: "Історія", icon: "history" },
  { href: "/printers", label: "Принтери", icon: "printers", adminOnly: true },
  { href: "/setup", label: "Гід підключення", icon: "setup", adminOnly: true },
  { href: "/users", label: "Користувачі", icon: "users", adminOnly: true },
  { href: "/settings", label: "Налаштування", icon: "settings", adminOnly: true },
];

function initials(user: User): string {
  if (user.name) {
    const parts = user.name.trim().split(/\s+/);
    return parts.length >= 2
      ? (parts[0][0] + parts[1][0]).toUpperCase()
      : parts[0].slice(0, 2).toUpperCase();
  }
  return user.email.slice(0, 2).toUpperCase();
}

export function Sidebar({ user }: { user: User }) {
  const pathname = usePathname();
  const router = useRouter();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  function logout() {
    clearToken();
    router.replace("/login");
  }

  const nav = NAV.filter((i) => !i.adminOnly || user.role === "admin");

  return (
    <aside className="group/sidebar fixed inset-y-0 left-0 z-40 flex flex-col border-r border-neutral-200 bg-white transition-[width] duration-200 ease-out w-14 hover:w-[220px] dark:border-neutral-800 dark:bg-neutral-950">

      {/* Brand */}
      <div className="flex h-14 shrink-0 items-center gap-3 overflow-hidden px-4">
        {/* Mascot icon */}
        <svg width="28" height="22" viewBox="0 0 112 88" className="shrink-0" aria-hidden="true">
          <rect x="24" y="0"  width="24" height="8"  className="fill-neutral-900 dark:fill-neutral-100"/>
          <rect x="64" y="0"  width="24" height="8"  className="fill-neutral-900 dark:fill-neutral-100"/>
          <rect x="16" y="8"  width="80" height="16" className="fill-neutral-900 dark:fill-neutral-100"/>
          <rect x="0"  y="24" width="112" height="16" className="fill-neutral-900 dark:fill-neutral-100"/>
          <rect x="16" y="40" width="80" height="8"  className="fill-neutral-900 dark:fill-neutral-100"/>
          <rect x="16" y="48" width="80" height="8"  className="fill-neutral-900 dark:fill-neutral-100"/>
          <rect x="32" y="48" width="16" height="8"  className="fill-white dark:fill-neutral-950"/>
          <rect x="64" y="48" width="16" height="8"  className="fill-white dark:fill-neutral-950"/>
          <rect x="16" y="56" width="80" height="8"  className="fill-neutral-900 dark:fill-neutral-100"/>
          <rect x="32" y="56" width="16" height="8"  className="fill-white dark:fill-neutral-950"/>
          <rect x="64" y="56" width="16" height="8"  className="fill-white dark:fill-neutral-950"/>
          <rect x="16" y="64" width="80" height="8"  className="fill-neutral-900 dark:fill-neutral-100"/>
          <rect x="32" y="72" width="16" height="16" className="fill-neutral-900 dark:fill-neutral-100"/>
          <rect x="64" y="72" width="16" height="16" className="fill-neutral-900 dark:fill-neutral-100"/>
        </svg>
        <span className="whitespace-nowrap text-sm font-semibold tracking-tight opacity-0 transition-opacity duration-150 group-hover/sidebar:opacity-100">
          monofarm
        </span>
      </div>

      <div className="mx-3 h-px bg-neutral-100 dark:bg-neutral-800" />

      {/* Nav */}
      <nav className="flex flex-1 flex-col gap-0.5 overflow-hidden px-2 py-3">
        {nav.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              className={[
                "group flex h-9 items-center gap-3 overflow-hidden rounded-lg px-2.5 text-sm transition-colors",
                active
                  ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                  : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100",
              ].join(" ")}
            >
              <Icon d={ICONS[item.icon]} />
              <span className="whitespace-nowrap opacity-0 transition-opacity duration-150 group-hover/sidebar:opacity-100">
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>

      <div className="mx-3 h-px bg-neutral-100 dark:bg-neutral-800" />

      {/* Bottom */}
      <div className="flex flex-col gap-0.5 overflow-hidden px-2 py-3">
        <div className="flex h-9 items-center gap-3 overflow-hidden px-2.5">
          <ThemeToggle compact />
          <span className="whitespace-nowrap text-sm text-neutral-500 opacity-0 transition-opacity duration-150 group-hover/sidebar:opacity-100 dark:text-neutral-400">
            Тема
          </span>
        </div>

        {user.role === "admin" && (
          <Link
            href="/settings"
            title="Налаштування"
            className={[
              "flex h-9 items-center gap-3 overflow-hidden rounded-lg px-2.5 text-sm transition-colors",
              pathname.startsWith("/settings")
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100",
            ].join(" ")}
          >
            <Icon d={ICONS.settings} />
            <span className="whitespace-nowrap opacity-0 transition-opacity duration-150 group-hover/sidebar:opacity-100">
              Налаштування
            </span>
          </Link>
        )}

        {/* User */}
        <div ref={menuRef} className="relative">
          <button
            onClick={() => setUserMenuOpen((v) => !v)}
            title={user.name || user.email}
            className="flex h-9 w-full items-center gap-3 overflow-hidden rounded-lg px-2.5 text-sm text-neutral-600 transition-colors hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            <div className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-neutral-200 text-[9px] font-bold text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300">
              {initials(user)}
            </div>
            <div className="flex min-w-0 flex-col items-start opacity-0 transition-opacity duration-150 group-hover/sidebar:opacity-100">
              <span className="w-full truncate text-xs font-medium text-neutral-700 dark:text-neutral-300">
                {user.name || user.email}
              </span>
              <span className="text-[10px] text-neutral-400">{user.role}</span>
            </div>
          </button>

          {userMenuOpen && (
            <div className="absolute bottom-full left-2 right-2 mb-1 rounded-xl border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
              <div className="border-b border-neutral-100 px-3 py-2 dark:border-neutral-800">
                <p className="truncate text-xs font-medium text-neutral-700 dark:text-neutral-300">{user.name || user.email}</p>
                <p className="truncate text-[10px] text-neutral-400">{user.email}</p>
              </div>
              <button
                onClick={logout}
                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-red-600 hover:bg-neutral-50 dark:text-red-400 dark:hover:bg-neutral-800"
              >
                <Icon d={ICONS.logout} className="size-3.5" />
                Вийти
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

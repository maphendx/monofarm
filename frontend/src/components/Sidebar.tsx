"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { ThemeToggle } from "@/components/ThemeToggle";
import { clearToken } from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n";
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
  dashboard: ["M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M9 22V12h6v10"],
  files:     ["M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z", "M13 2v7h7"],
  tasks:     ["M9 11l3 3L22 4", "M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"],
  plan:      ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
  printers:  ["M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2", "M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6", "M6 18h12v3H6z"],
  analytics: ["M18 20V10M12 20V4M6 20v-6"],
  history:   ["M12 8v4l3 3", "M3.05 11a9 9 0 1 1 .5 4M3 16v-5h5"],
  filament:  ["M12 2a10 10 0 1 0 10 10", "M12 8a4 4 0 1 0 4 4", "M12 12h.01"],
  users:     ["M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2", "M9 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0", "M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"],
  settings:  ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"],
  logout:    ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9"],
  warehouse: ["M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z", "M3.27 6.96L12 12.01l8.73-5.05", "M12 22.08V12"],
};

function initials(user: User): string {
  if (user.name) {
    const parts = user.name.trim().split(/\s+/);
    return parts.length >= 2
      ? (parts[0][0] + parts[1][0]).toUpperCase()
      : parts[0].slice(0, 2).toUpperCase();
  }
  return user.email.slice(0, 2).toUpperCase();
}

const NAV_GROUPS = [
  {
    label: null,
    items: [
      { href: "/dashboard", icon: "dashboard", tKey: "nav.dashboard" },
      { href: "/plan",      icon: "plan",      tKey: "nav.plan" },
      { href: "/tasks",     icon: "tasks",     tKey: "nav.tasks" },
      { href: "/files",     icon: "files",     tKey: "nav.files" },
      { href: "/printers",  icon: "printers",  tKey: "nav.printers" },
    ],
  },
  {
    label: "Аналіз",
    items: [
      { href: "/analytics", icon: "analytics", tKey: "nav.analytics" },
      { href: "/history",   icon: "history",   tKey: "nav.history" },
    ],
  },
  {
    label: "Управління",
    items: [
      { href: "/filament",   icon: "filament",   tKey: "nav.filament" },
      { href: "/warehouse",  icon: "warehouse",  tKey: "nav.warehouse" },
      { href: "/users",      icon: "users",      tKey: "nav.users", adminOnly: true },
    ],
  },
] as const;

export function Sidebar({ user }: { user: User }) {
  const pathname = usePathname();
  const router = useRouter();
  const t = useT();
  const { locale, setLocale } = useLocale();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  function logout() {
    clearToken();
    router.replace("/login");
  }

  const isAdmin = user.role === "admin";

  const linkCls = (href: string) => [
    "flex h-9 items-center gap-3 overflow-hidden rounded-lg px-2.5 text-sm transition-colors",
    pathname === href || pathname.startsWith(href + "/")
      ? "bg-cyan-50 text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-400"
      : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100",
  ].join(" ");

  return (
    <aside className="group/sidebar fixed inset-y-0 left-0 z-40 flex flex-col border-r border-neutral-200 bg-white transition-[width] duration-200 ease-out w-14 hover:w-[220px] dark:border-neutral-800 dark:bg-[#161614]">

      {/* Brand */}
      <div className="flex h-14 shrink-0 items-center gap-3 overflow-hidden px-4">
        <svg width="26" height="26" viewBox="0 0 32 32" fill="none" className="shrink-0" aria-hidden="true">
          <polygon points="16,2 25,14 7,14" fill="#0891b2"/>
          <rect x="4"   y="17" width="24" height="4"   rx="2"    fill="#0891b2"/>
          <rect x="7.5" y="23" width="17" height="3.2" rx="1.6"  fill="#0891b2" opacity="0.6"/>
          <rect x="12"  y="28" width="8"  height="2.5" rx="1.25" fill="#0891b2" opacity="0.3"/>
        </svg>
        <span className="whitespace-nowrap font-mono text-sm font-semibold tracking-[0.06em] uppercase opacity-0 transition-opacity duration-150 group-hover/sidebar:opacity-100">
          MONO<span className="text-cyan-600 dark:text-cyan-400">FARM</span>
        </span>
      </div>

      <div className="mx-3 h-px bg-neutral-100 dark:bg-neutral-800" />

      {/* Nav */}
      <nav className="flex flex-1 flex-col overflow-hidden px-2 py-3">
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi} className={gi > 0 ? "mt-1" : ""}>
            {group.label && (
              <p className="mt-2 mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-widest select-none whitespace-nowrap text-neutral-400 dark:text-neutral-600 opacity-0 transition-opacity duration-150 group-hover/sidebar:opacity-100">
                {group.label}
              </p>
            )}
            <div className="flex flex-col gap-0.5">
              {group.items
                .filter((item) => !("adminOnly" in item && item.adminOnly) || isAdmin)
                .map((item) => {
                  const label = t(item.tKey as Parameters<typeof t>[0]);
                  return (
                    <Link key={item.href} href={item.href} title={label} className={linkCls(item.href)}>
                      <Icon d={ICONS[item.icon]} />
                      <span className="whitespace-nowrap opacity-0 transition-opacity duration-150 group-hover/sidebar:opacity-100">
                        {label}
                      </span>
                    </Link>
                  );
                })}
            </div>
          </div>
        ))}
      </nav>

      <div className="mx-3 h-px bg-neutral-100 dark:bg-neutral-800" />

      {/* Footer */}
      <div className="flex flex-col gap-0.5 overflow-hidden px-2 py-3">

        {isAdmin && (
          <Link href="/settings" title={t("nav.settings")} className={linkCls("/settings")}>
            <Icon d={ICONS.settings} />
            <span className="whitespace-nowrap opacity-0 transition-opacity duration-150 group-hover/sidebar:opacity-100">
              {t("nav.settings")}
            </span>
          </Link>
        )}

        {/* User row + theme toggle */}
        <div ref={menuRef} className="relative">
          <div className="flex h-9 items-center overflow-hidden rounded-lg px-2.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors">
            <button
              onClick={() => setUserMenuOpen((v) => !v)}
              title={user.name || user.email}
              className="flex min-w-0 flex-1 items-center gap-3"
            >
              <div className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-neutral-200 text-[9px] font-bold text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300">
                {initials(user)}
              </div>
              <div className="flex min-w-0 flex-col items-start opacity-0 transition-opacity duration-150 group-hover/sidebar:opacity-100">
                <span className="w-full truncate text-xs font-medium text-neutral-700 dark:text-neutral-300">
                  {user.name || user.email}
                </span>
                <span className="text-xs text-neutral-400">{user.role}</span>
              </div>
            </button>
            <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/sidebar:opacity-100">
              <button
                onClick={() => setLocale(locale === "uk" ? "en" : "uk")}
                title="Switch language"
                className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
              >
                {locale === "uk" ? "EN" : "UA"}
              </button>
              <ThemeToggle compact />
            </div>
          </div>

          {userMenuOpen && (
            <div className="absolute bottom-full left-2 right-2 mb-1 rounded-xl border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
              <div className="border-b border-neutral-100 px-3 py-2 dark:border-neutral-800">
                <p className="truncate text-xs font-medium text-neutral-700 dark:text-neutral-300">{user.name || user.email}</p>
                <p className="truncate text-xs text-neutral-400">{user.email}</p>
              </div>
              <button
                onClick={logout}
                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-red-600 hover:bg-neutral-50 dark:text-red-400 dark:hover:bg-neutral-800"
              >
                <Icon d={ICONS.logout} className="size-3.5" />
                {t("auth.logout")}
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

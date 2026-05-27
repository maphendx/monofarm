"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { api, clearToken } from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n";
import type { User } from "@/lib/types";

// ── Icons ──────────────────────────────────────────────────────────────────────

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
      { href: "/filament",  icon: "filament",  tKey: "nav.filament" },
      { href: "/warehouse", icon: "warehouse", tKey: "nav.warehouse" },
      { href: "/users",     icon: "users",     tKey: "nav.users", adminOnly: true },
    ],
  },
] as const;

// ── Sidebar ────────────────────────────────────────────────────────────────────

export function Sidebar({
  user,
  pinned,
  onPinToggle,
  onSearch,
}: {
  user: User;
  pinned: boolean;
  onPinToggle: () => void;
  onSearch: () => void;
}) {
  const pathname              = usePathname();
  const router                = useRouter();
  const t                     = useT();
  const { locale, setLocale } = useLocale();

  const [settingsOpen,    setSettingsOpen]    = useState(true);
  const [agentConnected,  setAgentConnected]  = useState<boolean | null>(null);

  // Agent status — poll every 30 s
  useEffect(() => {
    async function check() {
      try {
        const d = await api<{ connected: boolean }>("/api/agent/status");
        setAgentConnected(d.connected);
      } catch {
        setAgentConnected(false);
      }
    }
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, []);

  function logout() { clearToken(); router.replace("/login"); }

  const isAdmin = user.role === "admin";

  // When pinned, text is always visible; otherwise opacity-0 → show on hover
  const txt = pinned
    ? "opacity-100"
    : "opacity-0 transition-opacity duration-150 group-hover/sidebar:opacity-100";

  const linkCls = (href: string) =>
    ["nav-link h-9 overflow-hidden", pathname === href || pathname.startsWith(href + "/") ? "active" : ""].join(" ");

  const agentColor = agentConnected === null
    ? "bg-[var(--text-faint)]"
    : agentConnected
      ? "bg-[var(--state-ok)]"
      : "bg-[var(--state-idle)]";
  const agentLabel = agentConnected === null
    ? "Агент: перевірка..."
    : agentConnected
      ? "Агент: підключено"
      : "Агент: відключено";

  return (
    <aside className={[
      "group/sidebar fixed inset-y-0 left-0 z-40 flex flex-col",
      "border-r border-[var(--border)] bg-[var(--bg-elevated)]",
      "transition-[width] duration-200 ease-out",
      pinned ? "w-[220px]" : "w-14 hover:w-[220px]",
    ].join(" ")}>

      {/* Brand */}
      <div className="flex h-14 shrink-0 items-center gap-3 overflow-hidden px-4">
        <svg width="22" height="22" viewBox="0 0 64 64" fill="none" className="shrink-0" aria-hidden="true">
          <g stroke="var(--accent)" strokeWidth="3" fill="none" opacity=".55">
            <circle cx="14" cy="14" r="4"/><circle cx="32" cy="14" r="4"/><circle cx="50" cy="14" r="4"/>
            <circle cx="14" cy="32" r="4"/>                                  <circle cx="50" cy="32" r="4"/>
            <circle cx="14" cy="50" r="4"/><circle cx="32" cy="50" r="4"/><circle cx="50" cy="50" r="4"/>
          </g>
          <circle cx="32" cy="32" r="7" fill="var(--accent)"/>
        </svg>
        <span className={`whitespace-nowrap font-mono text-sm font-semibold tracking-[0.06em] uppercase ${txt}`}>
          MONO<span className="text-[var(--accent)]">FARM</span>
        </span>
      </div>

      <div className="mx-3 h-px bg-[var(--surface-hi)]" />

      {/* Main nav */}
      <nav className="flex flex-1 flex-col overflow-hidden px-2 py-3">
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi} className={gi > 0 ? "mt-1" : ""}>
            {group.label && (
              <p className={`mt-2 mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-widest select-none whitespace-nowrap text-[var(--text-faint)] ${txt}`}>
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
                      <span className={`whitespace-nowrap ${txt}`}>{label}</span>
                    </Link>
                  );
                })}
            </div>
          </div>
        ))}
      </nav>

      <div className="mx-3 h-px bg-[var(--surface-hi)]" />

      {/* Settings section (collapsible) */}
      <div className="flex flex-col overflow-hidden px-2 py-2">
        <button
          onClick={() => setSettingsOpen((v) => !v)}
          className="nav-link h-9 w-full"
          title="Налаштування"
        >
          <Icon d={ICONS.settings} />
          <span className={`flex-1 whitespace-nowrap text-left ${txt}`}>Налаштування</span>
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            className={`shrink-0 transition-transform duration-150 ${settingsOpen ? "rotate-180" : ""} ${txt}`}
          >
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>

        {settingsOpen && (
          <div className="flex flex-col gap-0.5 overflow-hidden">
            {isAdmin && (
              <Link href="/settings" title="Системні налаштування" className={linkCls("/settings")}>
                <Icon d={ICONS.settings} className="opacity-40" />
                <span className={`whitespace-nowrap text-sm ${txt}`}>Системні</span>
              </Link>
            )}

            {/* Profile */}
            <div className="flex h-9 items-center gap-3 overflow-hidden rounded-lg px-2.5">
              <div className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--surface-hi)] text-[9px] font-bold text-[var(--text)]">
                {initials(user)}
              </div>
              <div className={`flex min-w-0 flex-col items-start ${txt}`}>
                <span className="w-full truncate text-xs font-medium text-[var(--text)]">{user.name || user.email}</span>
                <span className="text-[10px] text-[var(--text-faint)]">{user.role}</span>
              </div>
            </div>

            {/* Theme + language */}
            <div className="flex h-9 items-center gap-2 overflow-hidden rounded-lg px-2.5">
              <ThemeToggle compact />
              <button
                onClick={() => setLocale(locale === "uk" ? "en" : "uk")}
                title="Switch language"
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-faint)] transition hover:bg-[var(--surface-hi)] hover:text-[var(--text)] ${txt}`}
              >
                {locale === "uk" ? "EN" : "UA"}
              </button>
            </div>

            {/* Logout */}
            <button onClick={logout} title="Вийти" className="nav-link h-9 text-[var(--state-error)]">
              <Icon d={ICONS.logout} />
              <span className={`whitespace-nowrap ${txt}`}>Вийти</span>
            </button>
          </div>
        )}
      </div>

      <div className="mx-3 h-px bg-[var(--surface-hi)]" />

      {/* Bottom toolbar: search, pin, agent */}
      <div className="flex flex-col gap-0.5 px-2 py-3">

        {/* Search */}
        <button onClick={onSearch} title="Пошук (⌘K)" className="nav-link h-9">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <span className={`flex-1 whitespace-nowrap ${txt}`}>Пошук</span>
          <kbd className={`text-[10px] text-[var(--text-faint)] border border-[var(--border)] rounded px-1 py-0.5 ${txt}`}>⌘K</kbd>
        </button>

        {/* Pin / unpin */}
        <button onClick={onPinToggle} title={pinned ? "Відкріпити сайдбар" : "Закріпити сайдбар"} className="nav-link h-9">
          {pinned ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <polyline points="15 18 9 12 15 6"/><polyline points="9 18 3 12 9 6"/>
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <polyline points="9 18 15 12 9 6"/><polyline points="15 18 21 12 15 6"/>
            </svg>
          )}
          <span className={`whitespace-nowrap ${txt}`}>{pinned ? "Згорнути" : "Закріпити"}</span>
        </button>

        {/* Agent status */}
        <div className="nav-link h-9 cursor-default" title={agentLabel}>
          <span className="relative flex size-[18px] shrink-0 items-center justify-center">
            {agentConnected && (
              <span className={`absolute size-2.5 rounded-full ${agentColor} animate-ping opacity-60`} />
            )}
            <span className={`size-2.5 rounded-full transition-colors duration-500 ${agentColor}`} />
          </span>
          <span className={`whitespace-nowrap text-xs text-[var(--text-muted)] ${txt}`}>{agentLabel}</span>
        </div>

      </div>
    </aside>
  );
}

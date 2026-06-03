"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { User } from "@/lib/types";

// ── icons ─────────────────────────────────────────────────────────────────────

function Icon({ d, className = "" }: { d: string | string[]; className?: string }) {
  const paths = Array.isArray(d) ? d : [d];
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
      className={`shrink-0 ${className}`}>
      {paths.map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

const ICONS: Record<string, string[]> = {
  dashboard: ["M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M9 22V12h6v10"],
  files:     ["M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z", "M13 2v7h7"],
  tasks:     ["M9 11l3 3L22 4", "M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"],
  plan:      ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
  analytics: ["M18 20V10M12 20V4M6 20v-6"],
  history:   ["M12 8v4l3 3", "M3.05 11a9 9 0 1 1 .5 4M3 16v-5h5"],
  filament:  ["M12 2a10 10 0 1 0 10 10", "M12 8a4 4 0 1 0 4 4", "M12 12h.01"],
  printers:  ["M6 9V2h12v7", "M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2", "M6 14h12v8H6z"],
  users:     ["M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2", "M9 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0", "M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"],
  settings:  ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"],
  warehouse: ["M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z", "M3.27 6.96L12 12.01l8.73-5.05", "M12 22.08V12"],
  support:   ["M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"],
  learn:     ["M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z", "M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"],
};

const NAV_GROUPS = [
  {
    label: null,
    items: [
      { href: "/dashboard", icon: "dashboard", tKey: "nav.dashboard" },
      { href: "/queue",     icon: "plan",      tKey: "nav.plan" },
      { href: "/history",   icon: "history",   tKey: "nav.history" },
    ],
  },
  {
    label: "Друк",
    items: [
      { href: "/materials",  icon: "filament",  tKey: "nav.filament" },
      { href: "/files",     icon: "files",     tKey: "nav.files" },
      { href: "/printers",  icon: "printers",  tKey: "nav.printers" },
    ],
  },
  {
    label: "Управління",
    items: [
      { href: "/tasks",     icon: "tasks",     tKey: "nav.tasks" },
      { href: "/warehouse", icon: "warehouse", tKey: "nav.warehouse" },
      { href: "/analytics", icon: "analytics", tKey: "nav.analytics" },
    ],
  },
] as const;

// ── component ─────────────────────────────────────────────────────────────────

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
  const pathname = usePathname();
  const t        = useT();

  const [agentConnected, setAgentConnected] = useState<boolean | null>(null);
  const [agentLastChecked, setAgentLastChecked] = useState<Date | null>(null);
  const [agentHover, setAgentHover] = useState(false);

  useEffect(() => {
    async function check() {
      try {
        const d = await api<{ connected: boolean }>("/api/agent/status");
        setAgentConnected(d.connected);
      } catch {
        setAgentConnected(false);
      }
      setAgentLastChecked(new Date());
    }
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, []);

  const isAdmin = user.role === "admin";

  // Map href → module key. null = always visible (admin-only items use role check separately).
  const MODULE_MAP: Record<string, string> = {
    "/dashboard":  "dashboard",
    "/queue":      "plan",
    "/history":    "history",
    "/materials":  "filament",
    "/files":      "files",
    "/printers":   "printers",
    "/tasks":      "tasks",
    "/warehouse":  "warehouse",
    "/analytics":  "analytics",
  };

  function canSee(href: string): boolean {
    if (isAdmin) return true;
    if (!user.allowed_modules) return true; // null = unrestricted
    const mod = MODULE_MAP[href];
    return !mod || user.allowed_modules.includes(mod);
  }

  const txt = pinned
    ? "opacity-100"
    : "opacity-0 transition-opacity duration-150 group-hover/sidebar:opacity-100";

  const linkCls = (href: string) =>
    ["nav-link h-9 overflow-hidden", pathname === href || pathname.startsWith(href + "/") ? "active" : ""].join(" ");

  const agentColor = agentConnected === null ? "bg-[var(--text-faint)]"
    : agentConnected ? "bg-[var(--state-ok)]"
    : "bg-[var(--state-idle)]";

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
                .filter((item) => canSee(item.href))
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

      {/* Settings (admin only) + Support + Learn (everyone) */}
      <div className="px-2 py-2">
        {isAdmin && (
          <Link href="/settings" title={t("nav.settings")} className={linkCls("/settings")}>
            <Icon d={ICONS.settings} />
            <span className={`whitespace-nowrap ${txt}`}>{t("nav.settings")}</span>
          </Link>
        )}
        <Link href="/support" title={t("nav.support")} className={linkCls("/support")}>
          <Icon d={ICONS.support} />
          <span className={`whitespace-nowrap ${txt}`}>{t("nav.support")}</span>
        </Link>
        <Link href="/learn" title={t("nav.learn")} className={linkCls("/learn")}>
          <Icon d={ICONS.learn} />
          <span className={`whitespace-nowrap ${txt}`}>{t("nav.learn")}</span>
        </Link>
      </div>

      {/* Bottom toolbar ──────────────────────────────────────────────────────
          Pin arrow: always visible (w-14 = exact collapsed sidebar width).
          Theme · search · agent: hidden when collapsed, shown on hover/pinned.
      ─────────────────────────────────────────────────────────────────────── */}
      <div className="py-2">
        <div className={[
          "flex items-center",
          pinned ? "overflow-visible" : "overflow-hidden group-hover/sidebar:overflow-visible"
        ].join(" ")}>

          {/* Pin / unpin — always visible */}
          <button
            onClick={onPinToggle}
            title={pinned ? "Відкріпити сайдбар" : "Закріпити сайдбар"}
            className="flex w-14 shrink-0 items-center justify-center py-1.5 text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
          >
            {pinned ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6"/><polyline points="9 18 3 12 9 6"/>
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6"/><polyline points="15 18 21 12 15 6"/>
              </svg>
            )}
          </button>

          {/* Theme · search · agent — appear only when sidebar is expanded */}
          <div className={[
            "flex flex-1 items-center",
            pinned
              ? "opacity-100 overflow-visible"
              : "opacity-0 overflow-hidden group-hover/sidebar:opacity-100 group-hover/sidebar:overflow-visible transition-opacity duration-150",
          ].join(" ")}>

            <div className="flex flex-1 items-center justify-center">
              <ThemeToggle compact />
            </div>

            <button
              onClick={onSearch}
              title="Пошук (⌘K)"
              className="flex flex-1 items-center justify-center py-1.5 text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
            </button>

            <div
              className="relative flex flex-1 items-center justify-center cursor-default py-1.5"
              onMouseEnter={() => setAgentHover(true)}
              onMouseLeave={() => setAgentHover(false)}
            >
              <span className="relative flex items-center justify-center">
                {agentConnected && (
                  <span className={`absolute size-2.5 rounded-full ${agentColor} animate-ping opacity-60`} />
                )}
                <span className={`size-2.5 rounded-full transition-colors duration-500 ${agentColor}`} />
              </span>
              {agentHover && (
                <div className="absolute bottom-full left-1/2 mb-2 -translate-x-1/2 w-52 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-3 shadow-lg z-50 text-left">
                  <p className="mb-2 text-xs font-semibold text-[var(--text)]">Статус агента</p>
                  <div className="flex items-center gap-2">
                    <span className={`size-2 shrink-0 rounded-full ${agentColor}`} />
                    <span className="text-xs text-[var(--text-muted)]">
                      {agentConnected === null ? "Перевірка…" : agentConnected ? "Підключено" : "Відключено"}
                    </span>
                  </div>
                  {agentLastChecked && (
                    <p className="mt-2 text-[10px] text-[var(--text-faint)]">
                      Перевірено: {agentLastChecked.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </p>
                  )}
                </div>
              )}
            </div>

          </div>
        </div>
      </div>

    </aside>
  );
}

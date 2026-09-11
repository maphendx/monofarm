"use client";

import {
  BookOpen,
  CalendarDays,
  ChevronsLeft,
  ChevronsRight,
  Disc3,
  FolderOpen,
  History,
  LayoutGrid,
  LineChart,
  ListChecks,
  MessageSquare,
  Search,
  Settings2,
  Warehouse as WarehouseIcon,
} from "lucide-react";
import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";

import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { User } from "@/lib/types";

const ICON_PROPS = { size: 18, strokeWidth: 1.7, className: "shrink-0" } as const;

type NavIconProps = { size?: number; className?: string; strokeWidth?: number | string };
type NavIcon = ComponentType<NavIconProps>;

// Custom glyph — lucide's "printer" is an office printer with paper, wrong domain.
// Original Monofarm 3D-printer glyph (stroke 1.7, lucide-style grid).
function Printer3DIcon({ size = 18, className = "" }: NavIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden="true"
    >
      <rect x="4" y="3" width="16" height="18" rx="2.2" />
      <rect x="7" y="5.6" width="10" height="8.4" rx="1.2" />
      <path d="M8.8 11.6h6.4" />
      <path d="M10.8 11.6v-1.8h2.4v1.8" />
      <path d="M4 17h16" />
    </svg>
  );
}

const NAV_GROUPS: { label: string | null; items: { href: Route; Ic: NavIcon; tKey: string }[] }[] = [
  {
    label: null,
    items: [
      { href: "/dashboard", Ic: LayoutGrid,    tKey: "nav.dashboard" },
      { href: "/queue",     Ic: CalendarDays,  tKey: "nav.plan" },
      { href: "/history",   Ic: History,       tKey: "nav.history" },
    ],
  },
  {
    label: "nav.groupPrint",
    items: [
      { href: "/materials", Ic: Disc3,         tKey: "nav.filament" },
      { href: "/files",     Ic: FolderOpen,    tKey: "nav.files" },
      { href: "/printers",  Ic: Printer3DIcon, tKey: "nav.printers" },
    ],
  },
  {
    label: "nav.groupManage",
    items: [
      { href: "/tasks",     Ic: ListChecks,    tKey: "nav.tasks" },
      { href: "/warehouse", Ic: WarehouseIcon, tKey: "nav.warehouse" },
      { href: "/analytics", Ic: LineChart,     tKey: "nav.analytics" },
    ],
  },
];

// ── component ────────────────────────────────────────────────────────────────
//
export function Sidebar({
  user,
  pinned,
  onPinToggle,
  onSearch,
}: {
  user?: User | null;
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
    const id = setInterval(() => { if (!document.hidden) void check(); }, 30_000);
    return () => clearInterval(id);
  }, []);

  const isAdmin = user?.role === "admin";

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
    if (!user || !user.allowed_modules) return true; // null = unrestricted
    const mod = MODULE_MAP[href];
    return !mod || user.allowed_modules.includes(mod);
  }

  // Labels fade out when the sidebar is collapsed (icons + tooltips take over).
  const lbl = pinned
    ? "opacity-100"
    : "invisible opacity-0 transition-opacity duration-150";

  // Custom hover tooltip — replaces the native `title` (slow, unstyled).
  const tip = (text: string) => (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2 py-1 text-xs font-medium text-[var(--text)] opacity-0 shadow-lg transition-opacity duration-150 group-hover/item:delay-300 group-hover/item:opacity-100"
    >
      {text}
    </span>
  );

  const navItem = (href: string, icon: ReactNode, label: string) => (
    <Link
      href={href as Route}
      aria-label={label}
      className={["nav-link group/item relative h-9", pathname === href || pathname.startsWith(href + "/") ? "active" : ""].join(" ")}
    >
      {icon}
      <span className={`whitespace-nowrap ${lbl}`}>{label}</span>
      {!pinned && tip(label)}
    </Link>
  );

  const agentColor = agentConnected === null ? "bg-[var(--text-faint)]"
    : agentConnected ? "bg-[var(--state-ok)]"
    : "bg-[var(--state-idle)]";

  return (
    <aside className={[
      "fixed inset-y-0 left-0 z-40 flex flex-col",
      "border-r border-[var(--border)] bg-[var(--bg)]",
      "transition-[width] duration-200 ease-out",
      pinned ? "w-[220px]" : "w-14",
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
        <span className={`whitespace-nowrap text-sm font-semibold tracking-tight ${lbl}`}>
          mono<span className="text-[var(--accent)]">farm</span>
        </span>
      </div>

      {/* Main nav */}
      <nav className="flex flex-1 flex-col px-2 py-3">
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi} className={gi > 0 ? "mt-1" : ""}>
            {group.label && (
              <p className={`mt-2 mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-widest select-none whitespace-nowrap text-[var(--text-faint)] ${lbl}`}>
                {t(group.label as Parameters<typeof t>[0])}
              </p>
            )}
            <div className="flex flex-col gap-0.5">
              {group.items
                .filter((item) => !("adminOnly" in item && item.adminOnly) || isAdmin)
                .filter((item) => canSee(item.href))
                .map((item) => (
                  <div key={item.href}>
                    {navItem(item.href, <item.Ic {...ICON_PROPS} />, t(item.tKey as Parameters<typeof t>[0]))}
                  </div>
                ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Settings (admin only) + Support + Learn (everyone) */}
      <div className="px-2 py-2">
        {isAdmin && navItem("/settings", <Settings2 {...ICON_PROPS} />, t("nav.settings"))}
        {navItem("/support", <MessageSquare {...ICON_PROPS} />, t("nav.support"))}
        {navItem("/learn", <BookOpen {...ICON_PROPS} />, t("nav.learn"))}
      </div>

      {/* Bottom toolbar ──────────────────────────────────────────────────────
          Pin arrow: always visible (w-14 = exact collapsed sidebar width).
          Theme · search · agent: visible when expanded, clipped when collapsed.
      ─────────────────────────────────────────────────────────────────────── */}
      <div className="py-2">
        <div className="flex items-center overflow-hidden">

          {/* Pin / unpin — always visible */}
          <button
            onClick={onPinToggle}
            title={pinned ? "Відкріпити сайдбар" : "Закріпити сайдбар"}
            className="flex w-14 shrink-0 items-center justify-center py-1.5 text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
          >
            {pinned
              ? <ChevronsLeft size={15} strokeWidth={1.7} />
              : <ChevronsRight size={15} strokeWidth={1.7} />
            }
          </button>

          {/* Theme · search · agent — visible when the sidebar is expanded */}
          <div className="flex flex-1 items-center">

            <div className="flex flex-1 items-center justify-center">
              <ThemeToggle compact />
            </div>

            <button
              onClick={onSearch}
              title="Пошук (⌘K)"
              className="flex flex-1 items-center justify-center py-1.5 text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
            >
              <Search size={15} strokeWidth={1.7} />
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

export function SidebarFallback({ pinned = false }: { pinned?: boolean }) {
  return (
    <aside className={[
      "fixed inset-y-0 left-0 z-40 flex flex-col",
      "border-r border-[var(--border)] bg-[var(--bg)]",
      "transition-[width] duration-200 ease-out",
      pinned ? "w-[220px]" : "w-14",
    ].join(" ")}>
      <div className="flex h-14 shrink-0 items-center gap-3 overflow-hidden px-4">
        <svg width="22" height="22" viewBox="0 0 64 64" fill="none" className="shrink-0" aria-hidden="true">
          <g stroke="var(--accent)" strokeWidth="3" fill="none" opacity=".55">
            <circle cx="14" cy="14" r="4"/><circle cx="32" cy="14" r="4"/><circle cx="50" cy="14" r="4"/>
            <circle cx="14" cy="32" r="4"/>                                  <circle cx="50" cy="32" r="4"/>
            <circle cx="14" cy="50" r="4"/><circle cx="32" cy="50" r="4"/><circle cx="50" cy="50" r="4"/>
          </g>
          <circle cx="32" cy="32" r="7" fill="var(--accent)"/>
        </svg>
        <span className="whitespace-nowrap text-sm font-semibold tracking-tight">
          mono<span className="text-[var(--accent)]">farm</span>
        </span>
      </div>
    </aside>
  );
}

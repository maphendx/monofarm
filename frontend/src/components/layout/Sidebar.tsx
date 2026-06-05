"use client";

import {
  BarChart2,
  BookOpen,
  ClipboardCheck,
  ChevronsLeft,
  ChevronsRight,
  FileText,
  History,
  Home,
  List,
  MessageCircle,
  Package,
  Search,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { User } from "@/lib/types";

// ── custom icons (no lucide equivalents or design-system-specific shapes) ─────

function FilamentIcon({ size = 18, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
      className={`shrink-0 ${className}`}>
      <path d="M12 2a10 10 0 1 0 10 10"/>
      <path d="M12 8a4 4 0 1 0 4 4"/>
      <path d="M12 12h.01"/>
    </svg>
  );
}

// Design-system printer: slim output tray (rect y=18 h=3), differs from lucide Printer
function PrinterNavIcon({ size = 18, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
      className={`shrink-0 ${className}`}>
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
      <path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/>
      <rect x="6" y="18" width="12" height="3"/>
    </svg>
  );
}

type NavIcon = LucideIcon | typeof FilamentIcon;

const NAV_GROUPS: { label: string | null; items: { href: string; Ic: NavIcon; tKey: string }[] }[] = [
  {
    label: null,
    items: [
      { href: "/dashboard", Ic: Home,        tKey: "nav.dashboard" },
      { href: "/queue",     Ic: List,        tKey: "nav.plan" },
      { href: "/history",   Ic: History,     tKey: "nav.history" },
    ],
  },
  {
    label: "Друк",
    items: [
      { href: "/materials", Ic: FilamentIcon,   tKey: "nav.filament" },
      { href: "/files",     Ic: FileText,      tKey: "nav.files" },
      { href: "/printers",  Ic: PrinterNavIcon, tKey: "nav.printers" },
    ],
  },
  {
    label: "Управління",
    items: [
      { href: "/tasks",     Ic: ClipboardCheck, tKey: "nav.tasks" },
      { href: "/warehouse", Ic: Package,     tKey: "nav.warehouse" },
      { href: "/analytics", Ic: BarChart2,   tKey: "nav.analytics" },
    ],
  },
];

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
                      <item.Ic size={18} strokeWidth={1.6} className="shrink-0" />
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
            <Settings size={18} strokeWidth={1.6} className="shrink-0" />
            <span className={`whitespace-nowrap ${txt}`}>{t("nav.settings")}</span>
          </Link>
        )}
        <Link href="/support" title={t("nav.support")} className={linkCls("/support")}>
          <MessageCircle size={18} strokeWidth={1.6} className="shrink-0" />
          <span className={`whitespace-nowrap ${txt}`}>{t("nav.support")}</span>
        </Link>
        <Link href="/learn" title={t("nav.learn")} className={linkCls("/learn")}>
          <BookOpen size={18} strokeWidth={1.6} className="shrink-0" />
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
            {pinned
              ? <ChevronsLeft size={15} strokeWidth={1.6} />
              : <ChevronsRight size={15} strokeWidth={1.6} />
            }
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
              <Search size={15} strokeWidth={1.6} />
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

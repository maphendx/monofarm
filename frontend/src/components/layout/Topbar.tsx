"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { clearToken } from "@/lib/api";
import { useLocale, useT, type Locale } from "@/lib/i18n";
import type { User } from "@/lib/types";

function initials(user: User): string {
  if (user.name) {
    const parts = user.name.trim().split(/\s+/);
    return parts.length >= 2
      ? (parts[0][0] + parts[1][0]).toUpperCase()
      : parts[0].slice(0, 2).toUpperCase();
  }
  return user.email.slice(0, 2).toUpperCase();
}

function LangToggle() {
  const { locale, setLocale } = useLocale();
  const next: Locale = locale === "en" ? "uk" : "en";
  return (
    <button
      onClick={() => setLocale(next)}
      title={locale === "en" ? "Switch to Ukrainian" : "Switch to English"}
      className="flex h-8 items-center rounded-md border border-[var(--border)] px-2 text-xs font-medium text-[var(--text-muted)] transition hover:bg-[var(--surface-hi)]   "
    >
      {locale === "en" ? "UA" : "EN"}
    </button>
  );
}

function ProfileMenu({ user }: { user: User }) {
  const router = useRouter();
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function logout() {
    clearToken();
    router.replace("/login");
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent)] text-xs font-semibold text-white transition hover:bg-[var(--accent-hi)]   "
        title={user.name || user.email}
      >
        {initials(user)}
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-50 min-w-[180px] rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] py-1 shadow-lg  ">
          <div className="border-b border-[var(--border)] px-4 py-2 ">
            <p className="truncate text-sm font-medium">{user.name || user.email}</p>
            <p className="truncate text-xs text-[var(--text-muted)]">{user.email}</p>
          </div>
          {user.role === "admin" && (
            <Link
              href="/settings"
              onClick={() => setOpen(false)}
              className="flex w-full items-center px-4 py-2 text-sm text-[var(--text)] hover:bg-[var(--surface-hi)]  "
            >
              {t("nav.settings")}
            </Link>
          )}
          <button
            onClick={logout}
            className="flex w-full items-center px-4 py-2 text-sm text-[var(--state-error)] hover:bg-[var(--surface-hi)]"
          >
            {t("auth.logout")}
          </button>
        </div>
      )}
    </div>
  );
}

export function Topbar({ user }: { user: User | null }) {
  const pathname = usePathname();
  const t = useT();

  const NAV = [
    { href: "/dashboard", label: t("nav.dashboard") },
    { href: "/plan",      label: t("nav.plan") },
    { href: "/files",     label: t("nav.files") },
    { href: "/tasks",     label: t("nav.tasks") },
    { href: "/materials",  label: t("nav.filament") },
    { href: "/analytics", label: t("nav.analytics") },
    { href: "/history",   label: t("nav.history") },
    { href: "/printers",  label: t("nav.printers"),  adminOnly: true },
    { href: "/users",     label: t("nav.users"),     adminOnly: true },
  ] as const;

  return (
    <header className="border-b border-[var(--border)] bg-[var(--bg-elevated)]  ">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <Link href="/dashboard" className="font-semibold tracking-tight">
            monofarm
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {NAV.filter((i) => !("adminOnly" in i) || !i.adminOnly || user?.role === "admin").map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={
                    "rounded-md px-3 py-1.5 transition " +
                    (active
                      ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                      : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]")
                  }
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <LangToggle />
          <ThemeToggle />
          {user && <ProfileMenu user={user} />}
        </div>
      </div>
    </header>
  );
}

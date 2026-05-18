"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ThemeToggle } from "@/components/ThemeToggle";
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
      className="flex h-8 items-center rounded-md border border-neutral-200 px-2 text-xs font-medium text-neutral-600 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
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
        className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-900 text-xs font-semibold text-white transition hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        title={user.name || user.email}
      >
        {initials(user)}
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-50 min-w-[180px] rounded-xl border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
          <div className="border-b border-neutral-100 px-4 py-2 dark:border-neutral-800">
            <p className="truncate text-sm font-medium">{user.name || user.email}</p>
            <p className="truncate text-xs text-neutral-500">{user.email}</p>
          </div>
          {user.role === "admin" && (
            <Link
              href="/settings"
              onClick={() => setOpen(false)}
              className="flex w-full items-center px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {t("nav.settings")}
            </Link>
          )}
          <button
            onClick={logout}
            className="flex w-full items-center px-4 py-2 text-sm text-red-600 hover:bg-neutral-50 dark:text-red-400 dark:hover:bg-neutral-800"
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
    { href: "/filament",  label: t("nav.filament") },
    { href: "/analytics", label: t("nav.analytics") },
    { href: "/history",   label: t("nav.history") },
    { href: "/printers",  label: t("nav.printers"),  adminOnly: true },
    { href: "/users",     label: t("nav.users"),     adminOnly: true },
  ] as const;

  return (
    <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
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
                      ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                      : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800")
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

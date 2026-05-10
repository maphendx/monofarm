"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";

import { clearToken } from "@/lib/api";
import type { User } from "@/lib/types";

const NAV: { href: string; label: string; adminOnly?: boolean }[] = [
  { href: "/dashboard", label: "Дашборд" },
  { href: "/plan", label: "План дня" },
  { href: "/tasks", label: "Завдання" },
  { href: "/users", label: "Користувачі", adminOnly: true },
];

export function Topbar({ user }: { user: User | null }) {
  const router = useRouter();
  const pathname = usePathname();

  function logout() {
    clearToken();
    router.replace("/login");
  }

  return (
    <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <Link href="/dashboard" className="font-semibold tracking-tight">
            printfarm
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {NAV.filter((i) => !i.adminOnly || user?.role === "admin").map((item) => {
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
        <div className="flex items-center gap-3 text-sm">
          {user && (
            <span className="text-neutral-500">
              {user.email}{" "}
              <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs uppercase tracking-wide dark:bg-neutral-800">
                {user.role}
              </span>
            </span>
          )}
          <button
            onClick={logout}
            className="rounded-md border border-neutral-200 px-3 py-1.5 text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Вийти
          </button>
        </div>
      </div>
    </header>
  );
}

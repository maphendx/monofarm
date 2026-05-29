"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { usePageTitle } from "@/lib/usePageTitle";

type NavItem  = { href: string; label: string };
type NavGroup = { label: string; href: string; exact?: boolean; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Огляд",
    href: "/warehouse",
    exact: true,
    items: [],
  },
  {
    label: "Товари",
    href: "/warehouse/products",
    items: [
      { href: "/warehouse/products",   label: "Номенклатура" },
      { href: "/warehouse/specs",      label: "Специфікації" },
      { href: "/warehouse/stock",      label: "Залишки" },
      { href: "/warehouse/categories", label: "Категорії" },
    ],
  },
  {
    label: "Склади",
    href: "/warehouse/warehouses",
    items: [
      { href: "/warehouse/warehouses", label: "Склади" },
      { href: "/warehouse/zones",      label: "Стелажі" },
    ],
  },
  {
    label: "Операції",
    href: "/warehouse/movements",
    items: [
      { href: "/warehouse/movements",  label: "Рухи" },
      { href: "/warehouse/production", label: "Виробництво" },
    ],
  },
  {
    label: "Продажі",
    href: "/warehouse/orders",
    items: [
      { href: "/warehouse/orders",         label: "Замовлення" },
      { href: "/warehouse/counterparties", label: "Контрагенти" },
      { href: "/warehouse/cashflow",       label: "Фінанси" },
    ],
  },
  {
    label: "Аналіз",
    href: "/warehouse/analytics",
    items: [],
  },
];

function isGroupActive(group: NavGroup, pathname: string): boolean {
  if (group.items.length === 0) {
    return group.exact ? pathname === group.href : pathname.startsWith(group.href);
  }
  return group.items.some(
    (item) => pathname === item.href || pathname.startsWith(item.href + "/"),
  );
}

export default function WarehouseLayout({ children }: { children: React.ReactNode }) {
  usePageTitle("nav.warehouse");
  const pathname = usePathname();
  const activeGroup = NAV_GROUPS.find((g) => isGroupActive(g, pathname)) ?? null;

  return (
    <div className="-mx-6 -mt-6">

      {/* ── Sticky nav header ─────────────────────────────────────────────── */}
      <div className="sticky top-0 z-20 bg-[var(--bg-elevated)]">

        {/* Primary row — group tabs */}
        <div className="flex items-center gap-1 overflow-x-auto border-b border-[var(--border)] px-4 py-2 scrollbar-none">
          {NAV_GROUPS.map((group) => {
            const active = isGroupActive(group, pathname);
            return (
              <Link
                key={group.href}
                href={group.href}
                className={[
                  "shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-[var(--accent)] text-white"
                    : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]",
                ].join(" ")}
              >
                {group.label}
              </Link>
            );
          })}
        </div>

        {/* Secondary row — sub-pages of active group */}
        {activeGroup && activeGroup.items.length > 0 && (
          <div className="flex items-center overflow-x-auto border-b border-[var(--border)] px-5 scrollbar-none">
            {activeGroup.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={[
                    "shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-xs transition-colors",
                    active
                      ? "border-[var(--accent)] font-medium text-[var(--accent)]"
                      : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]",
                  ].join(" ")}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      <div className="px-6 py-5">
        {children}
      </div>
    </div>
  );
}

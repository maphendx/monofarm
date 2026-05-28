"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { usePageTitle } from "@/lib/usePageTitle";

const NAV_GROUPS = [
  {
    label: null,
    items: [
      { href: "/warehouse", label: "Огляд", exact: true },
    ],
  },
  {
    label: "Товари",
    items: [
      { href: "/warehouse/products",    label: "Номенклатура" },
      { href: "/warehouse/specs",       label: "Специфікації" },
      { href: "/warehouse/stock",       label: "Залишки" },
      { href: "/warehouse/categories",  label: "Категорії" },
    ],
  },
  {
    label: "Склади",
    items: [
      { href: "/warehouse/warehouses", label: "Склади" },
    ],
  },
  {
    label: "Операції",
    items: [
      { href: "/warehouse/movements",  label: "Рухи" },
      { href: "/warehouse/production", label: "Виробництво" },
    ],
  },
  {
    label: "Продажі",
    items: [
      { href: "/warehouse/orders",         label: "Замовлення" },
      { href: "/warehouse/counterparties", label: "Контрагенти" },
      { href: "/warehouse/cashflow",       label: "Фінанси" },
    ],
  },
  {
    label: "Аналіз",
    items: [
      { href: "/warehouse/analytics", label: "Аналітика" },
    ],
  },
];

function isActive(href: string, pathname: string, exact?: boolean) {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(href + "/");
}

function NavTab({ href, label, exact }: { href: string; label: string; exact?: boolean }) {
  const pathname = usePathname();
  const active = isActive(href, pathname, exact);
  return (
    <Link
      href={href}
      className={[
        "shrink-0 whitespace-nowrap px-3 py-2.5 text-sm transition-colors",
        active
          ? "border-b-2 border-[var(--accent)] font-medium text-[var(--accent)]"
          : "border-b-2 border-transparent text-[var(--text-muted)] hover:text-[var(--text-hi)]",
      ].join(" ")}
    >
      {label}
    </Link>
  );
}

export default function WarehouseLayout({ children }: { children: React.ReactNode }) {
  usePageTitle("nav.warehouse");
  return (
    <div className="-mx-6 -mt-6">

      {/* ── Horizontal tab nav ──────────────────────────────────────────── */}
      <div className="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--bg-elevated)]">
        <div className="flex overflow-x-auto px-4 scrollbar-none">
          {NAV_GROUPS.map((group, gi) => (
            <div key={gi} className={["flex items-center", gi > 0 ? "border-l border-[var(--border)] ml-1 pl-1" : ""].join(" ")}>
              {group.label && (
                <span className="hidden shrink-0 px-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-faint)] sm:inline">
                  {group.label}
                </span>
              )}
              {group.items.map((item) => (
                <NavTab key={item.href} {...item} />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      <div className="px-6 py-5">
        {children}
      </div>
    </div>
  );
}

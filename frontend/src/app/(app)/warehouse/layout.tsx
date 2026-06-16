"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { ScannerModal } from "@/components/warehouse/ScannerModal";
import { usePageTitle } from "@/lib/usePageTitle";
import { useUser } from "@/lib/auth-context";

type NavItem  = { href: string; label: string; fullOnly?: boolean };
type NavGroup = { label: string; href: string; exact?: boolean; fullOnly?: boolean; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Огляд",
    href: "/warehouse",
    exact: true,
    fullOnly: true,
    items: [],
  },
  {
    label: "Товари",
    href: "/warehouse/products",
    items: [
      { href: "/warehouse/products",   label: "Номенклатура" },
      { href: "/warehouse/specs",      label: "Специфікації",   fullOnly: true },
      { href: "/warehouse/stock",      label: "Залишки",        fullOnly: true },
      { href: "/warehouse/categories", label: "Категорії" },
      { href: "/warehouse/labels",     label: "Шаблони міток",  fullOnly: true },
    ],
  },
  {
    label: "Склади",
    href: "/warehouse/warehouses",
    fullOnly: true,
    items: [
      { href: "/warehouse/warehouses", label: "Склади" },
      { href: "/warehouse/zones",      label: "Стелажі" },
    ],
  },
  {
    label: "Операції",
    href: "/warehouse/production",
    fullOnly: true,
    items: [
      { href: "/warehouse/production", label: "Виробництво" },
      { href: "/warehouse/movements",  label: "Рухи" },
      { href: "/warehouse/purchases",  label: "Закупівлі" },
    ],
  },
  {
    label: "Каса",
    href: "/warehouse/cashregister",
    fullOnly: true,
    items: [
      { href: "/warehouse/cashregister",  label: "POS" },
      { href: "/warehouse/bank-accounts", label: "Рахунки" },
    ],
  },
  {
    label: "Продажі",
    href: "/warehouse/orders",
    fullOnly: true,
    items: [
      { href: "/warehouse/orders",         label: "Замовлення" },
      { href: "/warehouse/counterparties", label: "Контрагенти" },
      { href: "/warehouse/cashflow",       label: "Фінанси" },
    ],
  },
  {
    label: "Аналіз",
    href: "/warehouse/analytics",
    fullOnly: true,
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

function UpgradeGate() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-[var(--surface-hi)]">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
        </svg>
      </div>
      <div>
        <p className="text-base font-semibold text-[var(--text)]">Потрібен тариф Starter або вище</p>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Цей розділ доступний починаючи з тарифу <strong>Starter</strong>.
        </p>
      </div>
      <Link
        href="/settings"
        className="btn btn-primary mt-2"
      >
        Перейти до тарифів
      </Link>
    </div>
  );
}

export default function WarehouseLayout({ children }: { children: React.ReactNode }) {
  usePageTitle("nav.warehouse");
  const pathname = usePathname();
  const user     = useUser();
  const isFree = user.org_plan === "free";

  // Redirect free-plan users landing on restricted pages to /warehouse/products
  const isOnRestrictedPage =
    isFree &&
    NAV_GROUPS.filter((g) => g.fullOnly)
      .flatMap((g) => [g.href, ...g.items.map((i) => i.href)])
      .some((href) => pathname === href || pathname.startsWith(href + "/"));

  const visibleGroups = isFree
    ? NAV_GROUPS.filter((g) => !g.fullOnly)
    : NAV_GROUPS;

  const activeGroup = visibleGroups.find((g) => isGroupActive(g, pathname)) ?? null;
  const [scannerOpen, setScannerOpen] = useState(false);

  return (
    <div className="-mx-6 -mt-6">

      {/* ── Sticky nav header ─────────────────────────────────────────────── */}
      <div className="sticky top-0 z-20 bg-[var(--bg-elevated)]">

        {/* Primary row — group tabs */}
        <div className="flex items-center gap-1 overflow-x-auto px-4 py-2.5 scrollbar-none">
          {visibleGroups.map((group) => {
            const active = isGroupActive(group, pathname);
            return (
              <Link
                key={group.href}
                href={group.href}
                className={[
                  "shrink-0 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-[var(--accent)] text-white shadow-sm"
                    : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]",
                ].join(" ")}
              >
                {group.label}
              </Link>
            );
          })}
          {/* Upgrade badge for free plan */}
          {isFree && (
            <Link
              href="/settings"
              className="ml-2 shrink-0 rounded-full border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-3 py-1 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors"
            >
              Free · Upgrade
            </Link>
          )}
          {!isFree && (
            <button
              onClick={() => setScannerOpen(true)}
              title="Сканер (⌘⇧S)"
              className="ml-auto shrink-0 flex items-center gap-1.5 rounded-lg border border-[var(--border-strong)] px-3 py-1.5 text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                <rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3"/><path d="M17 21v-4h4"/><path d="M21 14h-4"/>
              </svg>
              <span className="hidden sm:inline">Сканер</span>
            </button>
          )}
        </div>

        {/* Secondary row — sub-pages of active group */}
        {activeGroup && activeGroup.items.length > 0 && (
          <div className="flex items-center gap-1 overflow-x-auto border-t border-[var(--border)] bg-[var(--bg)] px-4 py-1.5 scrollbar-none">
            {activeGroup.items
              .filter((item) => !isFree || !item.fullOnly)
              .map((item) => {
                const active = pathname === item.href || pathname.startsWith(item.href + "/");
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={[
                      "shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                      active
                        ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                        : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]",
                    ].join(" ")}
                  >
                    {item.label}
                  </Link>
                );
              })}
          </div>
        )}

        <div className="border-b border-[var(--border)]" />
      </div>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      <div className="px-6 py-5">
        {isOnRestrictedPage ? <UpgradeGate /> : children}
      </div>

      {scannerOpen && <ScannerModal onClose={() => setScannerOpen(false)} />}
    </div>
  );
}

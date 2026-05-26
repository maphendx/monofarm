"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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
      { href: "/warehouse/movements",  label: "Рухи товарів" },
      { href: "/warehouse/production", label: "Виробництво" },
      { href: "/warehouse/assembly",   label: "Збірка" },
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

const ALL_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

function isActive(href: string, pathname: string, exact?: boolean) {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(href + "/");
}

function NavLink({ href, label, exact }: { href: string; label: string; exact?: boolean }) {
  const pathname = usePathname();
  const active = isActive(href, pathname, exact);
  return (
    <Link
      href={href}
      className={[
        "flex items-center rounded-md px-3 py-1.5 text-sm transition-colors",
        active
          ? "bg-[rgba(56,189,248,.08)] font-medium text-[var(--accent)]  "
          : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)] hover:text-[var(--text-hi)]  dark:hover:bg-white/5 ",
      ].join(" ")}
    >
      {label}
    </Link>
  );
}

export default function WarehouseLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
     * Break out of the parent's px-6 py-6 padding AND the mx-auto max-w-[1400px] centering
     * so the warehouse section fills the full width of <main> (100vw - sidebar 3.5rem).
     *
     * margin-left = -(parent padding 1.5rem) - auto margin from max-w centering
     * auto margin = max(0, (100vw - sidebar - max-w) / 2)
     *             = max(0, (100vw - 3.5rem - 87.5rem) / 2)   [87.5rem = 1400px]
     *
     * On screens ≤ 1456px (sidebar + 1400px): auto margin = 0, so just -1.5rem (normal px-6 removal).
     * On wider screens: negative margin grows to pull content flush left.
     */
    <div
      className="-mt-6 flex min-h-screen flex-col md:flex-row"
      style={{
        marginLeft: "calc(-1.5rem - max(0px, (100vw - 3.5rem - 87.5rem) / 2))",
        width: "calc(100vw - 3.5rem)",
      }}
    >

      {/* ── Mobile: horizontal scrolling nav ─────────────────────────────── */}
      <div className="shrink-0 border-b border-[var(--border)] bg-[var(--bg-elevated)]   md:hidden">
        <div className="flex gap-0.5 overflow-x-auto px-3 py-2">
          {ALL_ITEMS.map((item) => (
            <NavLink key={item.href} {...item} />
          ))}
        </div>
      </div>

      {/* ── Desktop: vertical sub-nav ─────────────────────────────────────── */}
      <nav className="hidden w-44 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)] bg-[var(--bg-elevated)] px-3 pb-6 pt-3   md:flex">
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi} className={gi > 0 ? "mt-6" : ""}>
            {group.label && (
              <p className="mb-1.5 px-3 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-faint)]/60 select-none ">
                {group.label}
              </p>
            )}
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <NavLink key={item.href} {...item} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* ── Content ───────────────────────────────────────────────────────── */}
      <div className="min-w-0 flex-1 px-4 py-4 md:px-6 md:py-6">
        {children}
      </div>
    </div>
  );
}

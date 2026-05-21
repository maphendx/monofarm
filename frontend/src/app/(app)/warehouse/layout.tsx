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
      { href: "/warehouse/products",   label: "Номенклатура" },
      { href: "/warehouse/stock",      label: "Залишки" },
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

function isActive(href: string, pathname: string, exact?: boolean) {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(href + "/");
}

export default function WarehouseLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    // Break out of parent px-6 py-6 to let the sub-nav sit flush on the left
    <div className="-mx-6 -mt-6 flex min-h-[calc(100vh-56px)]">

      {/* ── Sub-nav ───────────────────────────────────────────────────────────── */}
      <nav className="w-44 shrink-0 border-r border-neutral-200 bg-white dark:border-neutral-800 dark:bg-[#161614] flex flex-col py-4 px-2 gap-0.5">
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi} className={gi > 0 ? "mt-3" : ""}>
            {group.label && (
              <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-widest text-neutral-400 dark:text-neutral-600 select-none">
                {group.label}
              </p>
            )}
            {group.items.map((item) => {
              const active = isActive(item.href, pathname, (item as { exact?: boolean }).exact);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={[
                    "flex h-8 items-center rounded-md px-2 text-sm transition-colors",
                    active
                      ? "bg-cyan-50 text-cyan-700 font-medium dark:bg-cyan-950/40 dark:text-cyan-400"
                      : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100",
                  ].join(" ")}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* ── Content ───────────────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 px-6 py-6">
        {children}
      </div>
    </div>
  );
}

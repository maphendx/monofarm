"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/warehouse",                label: "Огляд" },
  { href: "/warehouse/warehouses",     label: "Склади" },
  { href: "/warehouse/products",       label: "Номенклатура" },
  { href: "/warehouse/stock",          label: "Залишки" },
  { href: "/warehouse/movements",      label: "Рухи" },
  { href: "/warehouse/production",     label: "Виробництво" },
  { href: "/warehouse/assembly",       label: "Збірка" },
  { href: "/warehouse/orders",         label: "Замовлення" },
  { href: "/warehouse/counterparties", label: "Контрагенти" },
  { href: "/warehouse/cashflow",       label: "Фінанси" },
  { href: "/warehouse/analytics",      label: "Аналітика" },
];

export default function WarehouseLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Склад</h1>
        <nav className="mt-3 flex gap-0.5 border-b border-neutral-200 dark:border-neutral-800">
          {TABS.map((tab) => {
            const active =
              tab.href === "/warehouse"
                ? pathname === "/warehouse"
                : pathname === tab.href || pathname.startsWith(tab.href + "/");
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={[
                  "relative px-3 py-2 text-sm transition-colors",
                  active
                    ? "text-neutral-900 dark:text-neutral-100 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-cyan-500"
                    : "text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300",
                ].join(" ")}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>
      {children}
    </div>
  );
}

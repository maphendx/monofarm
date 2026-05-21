"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type StockEntry = {
  id:             number;
  product_id:     number;
  product_name:   string;
  warehouse_id:   number;
  warehouse_name: string;
  quantity:       string;
  reserved_qty:   string;
  available:      string;
  updated_at:     string;
};

export default function StockPage() {
  const [stock,    setStock]   = useState<StockEntry[]>([]);
  const [loading,  setLoading] = useState(true);
  const [whFilter, setWhFilter] = useState("Всі");
  const [showLow,  setShowLow]  = useState(false);

  const load = useCallback(async () => {
    try { setStock(await api<StockEntry[]>("/api/warehouse/stock")); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const warehouses = ["Всі", ...Array.from(new Set(stock.map((s) => s.warehouse_name)))];

  const filtered = stock.filter((s) => {
    if (whFilter !== "Всі" && s.warehouse_name !== whFilter) return false;
    if (showLow && parseFloat(s.available) >= 10) return false;
    return true;
  });

  const whColor = (name: string) => {
    if (name.includes("Готова")) return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    if (name.includes("Сировина")) return "bg-blue-500/10 text-blue-700 dark:text-blue-400";
    return "bg-red-500/10 text-red-700 dark:text-red-400";
  };

  const lowCount = stock.filter((s) => parseFloat(s.available) < 10).length;

  if (loading) return <div className="text-sm text-neutral-500">Завантаження…</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {warehouses.map((w) => (
            <button key={w} onClick={() => setWhFilter(w)}
              className={["rounded-md px-2.5 py-1.5 text-xs transition-colors",
                whFilter === w
                  ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                  : "border border-neutral-200 text-neutral-600 hover:border-neutral-400 dark:border-neutral-800 dark:text-neutral-400",
              ].join(" ")}>
              {w}
            </button>
          ))}
        </div>
        {lowCount > 0 && (
          <button onClick={() => setShowLow((v) => !v)}
            className={["rounded-md px-2.5 py-1.5 text-xs transition-colors",
              showLow ? "bg-amber-600 text-white" : "border border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400",
            ].join(" ")}>
            ⚠ Мало залишків ({lowCount})
          </button>
        )}
        <button onClick={load} className="ml-auto rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800">
          ↻ Оновити
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wider text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
            <tr>
              <th className="px-4 py-3 font-medium">Товар</th>
              <th className="px-4 py-3 font-medium">Склад</th>
              <th className="px-4 py-3 font-medium text-right">Кількість</th>
              <th className="px-4 py-3 font-medium text-right">Зарез.</th>
              <th className="px-4 py-3 font-medium text-right">Вільно</th>
              <th className="px-4 py-3 font-medium text-right">Оновлено</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {filtered.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-neutral-400">Немає записів</td></tr>
            ) : (
              filtered.map((s) => {
                const avail = parseFloat(s.available);
                const isLow = avail < 10;
                return (
                  <tr key={s.id} className={isLow ? "bg-amber-50/40 dark:bg-amber-950/10" : "hover:bg-neutral-50 dark:hover:bg-neutral-800/50"}>
                    <td className="px-4 py-3 font-medium">
                      {s.product_name}
                      {isLow && <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">⚠</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${whColor(s.warehouse_name)}`}>
                        {s.warehouse_name}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{parseFloat(s.quantity).toFixed(0)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-neutral-400">
                      {parseFloat(s.reserved_qty) > 0 ? parseFloat(s.reserved_qty).toFixed(0) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium">
                      <span className={avail < 0 ? "text-red-500" : isLow ? "text-amber-600 dark:text-amber-400" : ""}>
                        {avail.toFixed(0)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-neutral-400">
                      {new Date(s.updated_at).toLocaleDateString("uk-UA")}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

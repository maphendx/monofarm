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
    if (name.includes("Готова")) return "badge badge-ok";
    if (name.includes("Сировина")) return "badge badge-print";
    return "badge badge-error";
  };

  const lowCount = stock.filter((s) => parseFloat(s.available) < 10).length;

  if (loading) return <div className="text-sm text-[var(--text-muted)]">Завантаження…</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {warehouses.map((w) => (
            <button key={w} onClick={() => setWhFilter(w)}
              className={["rounded-md px-2.5 py-1.5 text-xs transition-colors",
                whFilter === w
                  ? "bg-[var(--accent)] text-white  "
                  : "border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)]  ",
              ].join(" ")}>
              {w}
            </button>
          ))}
        </div>
        {lowCount > 0 && (
          <button onClick={() => setShowLow((v) => !v)}
            className={["rounded-md px-2.5 py-1.5 text-xs transition-colors",
              showLow ? "bg-[var(--state-warn)] text-white" : "border border-[rgba(245,158,11,.3)] text-[var(--state-warn)]",
            ].join(" ")}>
            ⚠ Мало залишків ({lowCount})
          </button>
        )}
        <button onClick={load} className="ml-auto rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs hover:bg-[var(--surface-hi)]  ">
          ↻ Оновити
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]  ">
        <table className="w-full text-sm">
          <thead className="bg-[var(--bg)] text-left text-xs uppercase tracking-wider text-[var(--text-muted)]  ">
            <tr>
              <th className="px-4 py-3 font-medium">Товар</th>
              <th className="px-4 py-3 font-medium">Склад</th>
              <th className="px-4 py-3 font-medium text-right">Кількість</th>
              <th className="px-4 py-3 font-medium text-right">Зарез.</th>
              <th className="px-4 py-3 font-medium text-right">Вільно</th>
              <th className="px-4 py-3 font-medium text-right">Оновлено</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] dark:divide-neutral-800">
            {filtered.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-[var(--text-faint)]">Немає записів</td></tr>
            ) : (
              filtered.map((s) => {
                const avail = parseFloat(s.available);
                const isLow = avail < 10;
                return (
                  <tr key={s.id} className={isLow ? "bg-[rgba(245,158,11,.05)]" : "hover:bg-[var(--surface-hi)]"}>
                    <td className="px-4 py-3 font-medium">
                      {s.product_name}
                      {isLow && <span className="ml-2 text-xs text-[var(--state-warn)]">⚠</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${whColor(s.warehouse_name)}`}>
                        {s.warehouse_name}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{parseFloat(s.quantity).toFixed(0)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-[var(--text-faint)]">
                      {parseFloat(s.reserved_qty) > 0 ? parseFloat(s.reserved_qty).toFixed(0) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium">
                      <span className={avail < 0 ? "text-[var(--state-error)]" : isLow ? "text-[var(--state-warn)]" : ""}>
                        {avail.toFixed(0)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-[var(--text-faint)]">
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

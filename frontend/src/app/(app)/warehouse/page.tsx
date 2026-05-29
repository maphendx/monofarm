"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { PageSkeleton } from "@/components/ui/ContentSkeleton";

// ── Types ─────────────────────────────────────────────────────────────────────

type StockEntry = {
  product_id:    number;
  product_name:  string;
  warehouse_name: string;
  quantity:      string;
  reserved_qty:  string;
  available:     string;
};

type Batch = {
  id:           number;
  product_name: string;
  target_qty:   number;
  printed_qty:  number;
  status:       string;
  due_date:     string | null;
};

type Movement = {
  id:              number;
  type:            string;
  product_name:    string;
  quantity:        string;
  warehouse_to_id: number | null;
  created_at:      string;
};

type MovementListOut = { items: Movement[]; next_cursor: string | null };

const TYPE_META: Record<string, { label: string; cls: string }> = {
  PRODUCTION_IN:  { label: "Виробництво +", cls: "badge badge-ok" },
  PRODUCTION_OUT: { label: "Сировина −",    cls: "badge badge-print" },
  SALE_OUT:       { label: "Продаж",        cls: "badge badge-accent" },
  PURCHASE_IN:    { label: "Закупка",       cls: "badge badge-accent" },
  DEFECT:         { label: "Брак",          cls: "badge badge-error" },
  ADJUSTMENT:     { label: "Коригування",   cls: "badge badge-neutral" },
  TRANSFER:       { label: "Переміщення",   cls: "badge badge-warn" },
};

// ── Components ────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4  ">
      <p className="text-xs text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-[var(--text-faint)]">{sub}</p>
    </div>
  );
}

function ProgressBar({ value }: { value: number }) {
  const pct = Math.min(100, Math.round(value));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-hi)] ">
      <div className="h-full rounded-full bg-[var(--accent)] transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}

function fmtDate(s: string) {
  return new Date(s).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function WarehouseDashboard() {
  const [stock,     setStock]     = useState<StockEntry[]>([]);
  const [batches,   setBatches]   = useState<Batch[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [loading,   setLoading]   = useState(true);

  const load = useCallback(async () => {
    try {
      const [s, b, m] = await Promise.all([
        api<StockEntry[]>("/api/warehouse/stock"),
        api<Batch[]>("/api/warehouse/batches"),
        api<MovementListOut>("/api/warehouse/movements?limit=5"),
      ]);
      setStock(s);
      setBatches(b);
      setMovements(m.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const activeBatches = batches.filter((b) => b.status === "active");
  const totalUnits    = stock.reduce((sum, s) => sum + parseFloat(s.quantity), 0);
  const pendingOrders = 0; // orders endpoint — placeholder

  const lowStock = stock.filter((s) => {
    const avail = parseFloat(s.available);
    return avail < 10 && s.warehouse_name === "Готова продукція";
  });

  if (loading) return <PageSkeleton cols={5} withStats statsCount={4} />;

  return (
    <div className="space-y-6">

      {/* KPI */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Товари (SKU)"       value={String(new Set(stock.map((s) => s.product_id)).size)} sub="активних позицій" />
        <KpiCard label="Готова продукція"   value={String(Math.round(totalUnits))} sub="одиниць на складах" />
        <KpiCard label="Активні партії"     value={String(activeBatches.length)} sub="у виробництві" />
        <KpiCard label="Нові замовлення"    value={String(pendingOrders)} sub="очікують обробки" />
      </div>

      {/* Low stock alert */}
      {lowStock.length > 0 && (
        <div className="rounded-xl border border-[rgba(245,158,11,.25)] bg-[rgba(245,158,11,.08)] px-4 py-3">
          <p className="mb-2 text-sm font-medium text-[var(--state-warn)]">
            ⚠ {lowStock.length} позиції нижче мінімального залишку
          </p>
          <ul className="space-y-1">
            {lowStock.map((s) => (
              <li key={s.product_id} className="flex items-center gap-2 text-sm text-[var(--state-warn)]">
                <span className="font-medium">{s.product_name}</span>
                <span>—</span>
                <span>{parseFloat(s.available).toFixed(0)} шт</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">

        {/* Active batches */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4  ">
          <h2 className="mb-3 text-sm font-medium">Активні партії</h2>
          {activeBatches.length === 0 ? (
            <p className="text-sm text-[var(--text-faint)]">Немає активних партій</p>
          ) : (
            <div className="space-y-4">
              {activeBatches.map((b) => {
                const pct = b.target_qty > 0 ? (b.printed_qty / b.target_qty) * 100 : 0;
                return (
                  <div key={b.id}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="font-medium">{b.product_name}</span>
                      {b.due_date && (
                        <span className="text-xs text-[var(--text-faint)]">до {new Date(b.due_date).toLocaleDateString("uk-UA")}</span>
                      )}
                    </div>
                    <ProgressBar value={pct} />
                    <p className="mt-1 text-xs text-[var(--text-faint)]">
                      {b.printed_qty} / {b.target_qty} шт · {pct.toFixed(0)}%
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent movements */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4  ">
          <h2 className="mb-3 text-sm font-medium">Останні рухи</h2>
          {movements.length === 0 ? (
            <p className="text-sm text-[var(--text-faint)]">Немає рухів</p>
          ) : (
            <div className="space-y-2">
              {movements.map((m) => {
                const meta = TYPE_META[m.type] ?? { label: m.type, cls: "bg-[var(--surface-hi)] text-[var(--text-muted)]" };
                return (
                  <div key={m.id} className="flex items-center gap-3 text-sm">
                    <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ${meta.cls}`}>
                      {meta.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[var(--text)] ">
                      {m.product_name}
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--text-muted)]">
                      {parseFloat(m.quantity) > 0 ? "+" : ""}{parseFloat(m.quantity).toFixed(0)}
                    </span>
                    <span className="shrink-0 text-xs text-[var(--text-faint)]">{fmtDate(m.created_at)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
